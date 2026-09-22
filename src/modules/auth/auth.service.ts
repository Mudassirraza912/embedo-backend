import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { redis } from '../../db/redis.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/AppError.js';
import { emailService } from '../../common/services/email.service.js';
import { RegisterInput, LoginInput, GoogleAuthInput, ForgotPasswordInput, ResetPasswordInput } from './auth.validation.js';

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
}

export interface AuthResult {
  user: {
    id: string;
    email: string;
    role: string;
    expertiseLevel: string | null;
    dataConsent: boolean;
  };
  accessToken: string;
  refreshToken: string;
}

interface GoogleTokenInfo {
  sub?: string;
  email?: string;
  email_verified?: string | boolean;
  aud?: string;
  iss?: string;
  exp?: string;
  name?: string;
}

const BCRYPT_ROUNDS = 12;
const PASSWORD_RESET_TTL_SECONDS = 3600;
const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);

/** Parse durations like "7d", "12h", "30m", "900s", or a plain number of seconds. */
const parseDurationSeconds = (value: string, fallbackSeconds: number): number => {
  const m = /^(\d+)\s*([smhd]?)$/i.exec(value.trim());
  if (!m) return fallbackSeconds;
  const n = Number(m[1]);
  switch ((m[2] || 's').toLowerCase()) {
    case 'd':
      return n * 86400;
    case 'h':
      return n * 3600;
    case 'm':
      return n * 60;
    default:
      return n;
  }
};

const REFRESH_TTL_SECONDS = parseDurationSeconds(env.JWT_REFRESH_EXPIRES_IN, 7 * 86400);

export class AuthService {
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private generateTokens(payload: TokenPayload): { accessToken: string; refreshToken: string } {
    const accessToken = jwt.sign(payload, env.JWT_ACCESS_SECRET, {
      expiresIn: env.JWT_ACCESS_EXPIRES_IN as jwt.SignOptions['expiresIn'],
    });
    const refreshToken = crypto.randomBytes(40).toString('hex');
    return { accessToken, refreshToken };
  }

  private refreshExpiry(): Date {
    return new Date(Date.now() + REFRESH_TTL_SECONDS * 1000);
  }

  private async issueSession(user: {
    id: string;
    email: string;
    role: string;
    expertiseLevel: string | null;
    dataConsent: boolean;
  }): Promise<AuthResult> {
    const { accessToken, refreshToken } = this.generateTokens({ userId: user.id, email: user.email, role: user.role });

    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: this.hashToken(refreshToken), expiresAt: this.refreshExpiry() },
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        expertiseLevel: user.expertiseLevel,
        dataConsent: user.dataConsent,
      },
      accessToken,
      refreshToken,
    };
  }

  async register(input: RegisterInput): Promise<AuthResult> {
    const email = input.email.toLowerCase();

    const existing = await prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
    if (existing) {
      throw new AppError(409, 'CONFLICT', 'An account with this email already exists');
    }

    const hashedPassword = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    try {
      const user = await prisma.user.create({
        data: {
          email,
          hashedPassword,
          expertiseLevel: input.expertiseLevel || null,
          dataConsent: true,
          dataConsentDate: new Date(),
          role: 'user',
        },
      });
      return this.issueSession(user);
    } catch (err: unknown) {
      // Concurrent registration on the same email: the unique index is the source of truth.
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
        throw new AppError(409, 'CONFLICT', 'An account with this email already exists');
      }
      throw err;
    }
  }

  async login(input: LoginInput): Promise<AuthResult> {
    const user = await prisma.user.findFirst({ where: { email: input.email.toLowerCase(), deletedAt: null } });

    if (!user || !user.hashedPassword) {
      // Burn comparable time so a missing account is not distinguishable by latency.
      await bcrypt.compare(input.password, '$2a$12$CwTycUXWue0Thq9StjUM0uJ8Uk9WqUv0cGq2QYHc6E2nRZ2yj2rQm');
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
    }

    const isValid = await bcrypt.compare(input.password, user.hashedPassword);
    if (!isValid) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid email or password');
    }

    if (user.suspendedAt) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended due to policy violations');
    }

    return this.issueSession(user);
  }

  /**
   * Rotating refresh tokens with reuse detection: presenting an already-rotated token is treated
   * as theft and revokes every active token for that user.
   */
  async refresh(rawRefreshToken: string | undefined): Promise<{ accessToken: string; refreshToken: string }> {
    if (!rawRefreshToken) {
      throw new AppError(401, 'UNAUTHORIZED', 'Refresh token required');
    }

    const tokenHash = this.hashToken(rawRefreshToken);
    const storedToken = await prisma.refreshToken.findFirst({ where: { tokenHash }, include: { user: true } });

    if (!storedToken || !storedToken.user || storedToken.user.deletedAt !== null) {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired refresh token');
    }

    if (storedToken.revokedAt) {
      // Reuse of a rotated token => compromise. Kill the whole family.
      await prisma.refreshToken.updateMany({
        where: { userId: storedToken.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      logger.warn({ userId: storedToken.userId }, 'Refresh token reuse detected — all sessions revoked');
      throw new AppError(401, 'UNAUTHORIZED', 'Session invalidated. Please sign in again.');
    }

    if (new Date() > storedToken.expiresAt) {
      await prisma.refreshToken.update({ where: { id: storedToken.id }, data: { revokedAt: new Date() } });
      throw new AppError(401, 'UNAUTHORIZED', 'Refresh token has expired');
    }

    if (storedToken.user.suspendedAt) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Account suspended');
    }

    const { accessToken, refreshToken: newRefreshToken } = this.generateTokens({
      userId: storedToken.user.id,
      email: storedToken.user.email,
      role: storedToken.user.role,
    });

    // Atomic rotation: the old token is revoked in the same transaction that creates the new one.
    await prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: { userId: storedToken.user.id, tokenHash: this.hashToken(newRefreshToken), expiresAt: this.refreshExpiry() },
      });
      const revoked = await tx.refreshToken.updateMany({
        where: { id: storedToken.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: created.id },
      });
      if (revoked.count !== 1) {
        // Lost a race with a concurrent refresh of the same token; abort this rotation.
        throw new AppError(401, 'UNAUTHORIZED', 'Session invalidated. Please sign in again.');
      }
    });

    return { accessToken, refreshToken: newRefreshToken };
  }

  async loginWithGoogle(input: GoogleAuthInput): Promise<AuthResult> {
    // Fail closed: Google sign-in is refused entirely when the audience cannot be verified.
    if (!env.GOOGLE_CLIENT_ID) {
      throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'Google sign-in is not configured on this server');
    }

    let payload: GoogleTokenInfo;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(input.idToken)}`, {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Google token verification failed');
        payload = (await res.json()) as GoogleTokenInfo;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired Google ID token');
    }

    if (payload.aud !== env.GOOGLE_CLIENT_ID) {
      throw new AppError(401, 'UNAUTHORIZED', 'Google ID token audience mismatch');
    }
    if (payload.iss && !GOOGLE_ISSUERS.has(payload.iss)) {
      throw new AppError(401, 'UNAUTHORIZED', 'Google ID token issuer mismatch');
    }
    if (!payload.sub || !payload.email) {
      throw new AppError(400, 'BAD_REQUEST', 'Google account does not have an associated email address');
    }
    const isVerified = payload.email_verified === 'true' || payload.email_verified === true;
    if (!isVerified) {
      throw new AppError(403, 'FORBIDDEN', 'Google email is not verified');
    }

    const email = payload.email.toLowerCase();
    const googleSub = payload.sub;

    let user = await prisma.user.findFirst({
      where: { deletedAt: null, authIdentities: { some: { provider: 'google', providerUserId: googleSub } } },
    });

    if (!user) {
      const byEmail = await prisma.user.findFirst({ where: { email, deletedAt: null } });

      if (byEmail) {
        // Never silently link a Google identity onto a password account.
        if (byEmail.hashedPassword) {
          throw new AppError(
            409,
            'CONFLICT',
            'An account with this email already exists using password login. Please sign in with your email and password.'
          );
        }
        await prisma.authIdentity.create({ data: { userId: byEmail.id, provider: 'google', providerUserId: googleSub } });
        user = byEmail;
      } else {
        // New account: consent to data use must be explicit (same rule as email registration).
        if (input.dataConsent !== true) {
          throw new AppError(400, 'CONSENT_REQUIRED', 'Data consent is required to create an Embedo account');
        }
        user = await prisma.user.create({
          data: {
            email,
            expertiseLevel: input.expertiseLevel || null,
            dataConsent: true,
            dataConsentDate: new Date(),
            role: 'user',
            authIdentities: { create: { provider: 'google', providerUserId: googleSub } },
          },
        });
      }
    }

    if (user.suspendedAt) {
      throw new AppError(403, 'ACCOUNT_SUSPENDED', 'Your account has been suspended due to policy violations');
    }

    return this.issueSession(user);
  }

  async logout(rawRefreshToken?: string): Promise<void> {
    if (!rawRefreshToken) return;
    await prisma.refreshToken.updateMany({
      where: { tokenHash: this.hashToken(rawRefreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Always responds with the same generic message (anti-enumeration).
   * The reset token is delivered ONLY by email. It is never returned in the response or logged.
   */
  async forgotPassword(input: ForgotPasswordInput): Promise<{ message: string }> {
    const generic = { message: "If an account exists with that email, we've sent a password reset link." };

    const user = await prisma.user.findFirst({ where: { email: input.email.toLowerCase(), deletedAt: null } });
    if (!user || user.suspendedAt) {
      return generic;
    }

    if (!emailService.isConfigured) {
      logger.error({ userId: user.id }, 'Password reset requested but SMTP is not configured — no email sent');
      return generic;
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(rawToken);
    await redis.set(`pwd_reset:${tokenHash}`, user.id, 'EX', PASSWORD_RESET_TTL_SECONDS);

    const resetUrl = `${env.FRONTEND_URL.replace(/\/$/, '')}/reset-password?token=${rawToken}`;

    try {
      await emailService.sendPasswordReset(user.email, resetUrl);
      logger.info({ userId: user.id }, 'Password reset email sent');
    } catch (err) {
      await redis.del(`pwd_reset:${tokenHash}`);
      logger.error({ err, userId: user.id }, 'Failed to send password reset email');
    }

    return generic;
  }

  async resetPassword(input: ResetPasswordInput): Promise<{ message: string }> {
    const tokenHash = this.hashToken(input.token);
    const key = `pwd_reset:${tokenHash}`;

    // Atomic consume: GETDEL guarantees a token can only ever be used once.
    const userId = await redis.getdel(key);
    if (!userId) {
      throw new AppError(400, 'BAD_REQUEST', 'Invalid or expired password reset link. Please request a new one.');
    }

    const user = await prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user || user.suspendedAt) {
      throw new AppError(400, 'BAD_REQUEST', 'Unable to reset password for this account.');
    }

    const hashedPassword = await bcrypt.hash(input.newPassword, BCRYPT_ROUNDS);

    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { hashedPassword } }),
      prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);

    logger.info({ userId: user.id }, 'Password reset successfully');
    return { message: 'Password has been reset successfully. Please log in with your new password.' };
  }
}

export const authService = new AuthService();
