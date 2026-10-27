import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { redis } from '../../db/redis.js';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/AppError.js';
import { emailService } from '../../common/services/email.service.js';
import {
  RegisterInput,
  VerifyOtpInput,
  ResendOtpInput,
  LoginInput,
  GoogleAuthInput,
  GithubAuthInput,
  ForgotPasswordInput,
  ResetPasswordInput,
} from './auth.validation.js';

export type RegisterResult =
  | {
      status: 'pending_verification';
      message: string;
      email: string;
      cooldownSeconds: number;
    }
  | AuthResult;

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

/** How long a just-rotated refresh token still counts as a concurrent refresh rather than theft. */
const ROTATION_GRACE_MS = 30_000;

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

  async register(input: RegisterInput): Promise<RegisterResult> {
    const email = input.email.toLowerCase().trim();

    const existing = await prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
    if (existing) {
      throw new AppError(409, 'CONFLICT', 'An account with this email already exists');
    }

    if (input.otp) {
      return this.verifyOtp({ email, otp: input.otp });
    }

    const cooldown = await redis.get(`otp_cooldown:${email}`);
    if (cooldown) {
      throw new AppError(429, 'RATE_LIMITED', 'Please wait 30 seconds before requesting another code');
    }

    const otp = crypto.randomInt(10000, 100000).toString();
    const hashedPassword = await bcrypt.hash(input.password, BCRYPT_ROUNDS);

    const pendingData = {
      otpHash: this.hashToken(otp),
      email,
      hashedPassword,
      fullName: input.fullName || null,
      expertiseLevel: input.expertiseLevel || null,
      attemptsRemaining: 5,
      createdAt: Date.now(),
    };

    await redis.set(`pending_reg:${email}`, JSON.stringify(pendingData), 'EX', 600);
    await redis.set(`otp_cooldown:${email}`, '1', 'EX', 30);

    try {
      await emailService.sendOtpVerification(email, otp);
      logger.info({ email }, 'Verification OTP email dispatched');
    } catch (err) {
      logger.error({ err, email }, 'Failed to deliver verification OTP email');
    }

    return {
      status: 'pending_verification',
      message: 'Verification code sent to your email',
      email,
      cooldownSeconds: 30,
    };
  }

  async verifyOtp(input: VerifyOtpInput): Promise<AuthResult> {
    const email = input.email.toLowerCase().trim();
    const raw = await redis.get(`pending_reg:${email}`);
    if (!raw) {
      throw new AppError(400, 'BAD_REQUEST', 'Verification code has expired or is invalid. Please sign up again.');
    }

    const pending = JSON.parse(raw);
    if (pending.attemptsRemaining <= 0) {
      await redis.del(`pending_reg:${email}`);
      throw new AppError(400, 'BAD_REQUEST', 'Too many incorrect attempts. Please request a new verification code.');
    }

    const inputHash = this.hashToken(input.otp);
    if (inputHash !== pending.otpHash) {
      pending.attemptsRemaining -= 1;
      const ttl = await redis.ttl(`pending_reg:${email}`);
      if (ttl > 0) {
        await redis.set(`pending_reg:${email}`, JSON.stringify(pending), 'EX', ttl);
      }
      throw new AppError(400, 'BAD_REQUEST', `Incorrect verification code. ${pending.attemptsRemaining} attempt(s) remaining.`);
    }

    await redis.del([`pending_reg:${email}`, `otp_cooldown:${email}`]);

    const existing = await prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
    if (existing) {
      throw new AppError(409, 'CONFLICT', 'An account with this email already exists');
    }

    try {
      const user = await prisma.user.create({
        data: {
          email,
          hashedPassword: pending.hashedPassword,
          expertiseLevel: pending.expertiseLevel || null,
          dataConsent: true,
          dataConsentDate: new Date(),
          role: 'user',
        },
      });
      logger.info({ userId: user.id, email }, 'User account created and verified successfully');
      return this.issueSession(user);
    } catch (err: unknown) {
      if (typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === 'P2002') {
        throw new AppError(409, 'CONFLICT', 'An account with this email already exists');
      }
      throw err;
    }
  }

  async resendOtp(input: ResendOtpInput): Promise<{ success: boolean; message: string; cooldownSeconds: number }> {
    const email = input.email.toLowerCase().trim();
    const cooldown = await redis.get(`otp_cooldown:${email}`);
    if (cooldown) {
      throw new AppError(429, 'RATE_LIMITED', 'Please wait 30 seconds before requesting another code');
    }

    const existing = await prisma.user.findFirst({ where: { email, deletedAt: null }, select: { id: true } });
    if (existing) {
      throw new AppError(409, 'CONFLICT', 'An account with this email already exists. Please sign in.');
    }

    const raw = await redis.get(`pending_reg:${email}`);
    if (!raw) {
      throw new AppError(400, 'BAD_REQUEST', 'No pending registration found for this email. Please sign up first.');
    }

    const pending = JSON.parse(raw);
    const otp = crypto.randomInt(10000, 100000).toString();
    pending.otpHash = this.hashToken(otp);
    pending.attemptsRemaining = 5;

    await redis.set(`pending_reg:${email}`, JSON.stringify(pending), 'EX', 600);
    await redis.set(`otp_cooldown:${email}`, '1', 'EX', 30);

    try {
      await emailService.sendOtpVerification(email, otp);
      logger.info({ email }, 'Verification OTP resent');
    } catch (err) {
      logger.error({ err, email }, 'Failed to deliver resent verification OTP email');
    }

    return {
      success: true,
      message: 'A new verification code has been sent',
      cooldownSeconds: 30,
    };
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
      // Two tabs (or a tab and a retry) refreshing with the same cookie a moment apart is normal:
      // the second request presents the token the first one just rotated. Within the grace window
      // it gets its own fresh pair instead of tripping theft detection and signing the user out
      // everywhere. Older reuse is still treated as compromise.
      const rotatedRecently =
        storedToken.replacedById !== null && Date.now() - storedToken.revokedAt.getTime() < ROTATION_GRACE_MS;
      if (rotatedRecently && new Date() <= storedToken.expiresAt && !storedToken.user.suspendedAt) {
        logger.info({ userId: storedToken.userId }, 'Concurrent refresh within the rotation grace window');
        return this.issueRefreshPair(storedToken.user);
      }
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
    let lostRace = false;
    await prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({
        data: { userId: storedToken.user.id, tokenHash: this.hashToken(newRefreshToken), expiresAt: this.refreshExpiry() },
      });
      const revoked = await tx.refreshToken.updateMany({
        where: { id: storedToken.id, revokedAt: null },
        data: { revokedAt: new Date(), replacedById: created.id },
      });
      if (revoked.count !== 1) {
        // A concurrent refresh of the same token rotated it first; undo this rotation.
        lostRace = true;
        throw new AppError(409, 'CONFLICT', 'Concurrent refresh');
      }
    }).catch((err: unknown) => {
      if (!lostRace) throw err;
    });

    // Same situation as the grace window above, caught inside the transaction instead.
    if (lostRace) return this.issueRefreshPair(storedToken.user);

    return { accessToken, refreshToken: newRefreshToken };
  }

  /** A fresh access + refresh pair for a user, without touching their other refresh tokens. */
  private async issueRefreshPair(user: { id: string; email: string; role: string }): Promise<{ accessToken: string; refreshToken: string }> {
    const { accessToken, refreshToken } = this.generateTokens({ userId: user.id, email: user.email, role: user.role });
    await prisma.refreshToken.create({
      data: { userId: user.id, tokenHash: this.hashToken(refreshToken), expiresAt: this.refreshExpiry() },
    });
    return { accessToken, refreshToken };
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
        // If the user already has a password account and hasn't confirmed linking yet, prompt for confirmation.
        if (byEmail.hashedPassword && !input.linkAccount) {
          throw new AppError(
            409,
            'ACCOUNT_LINK_REQUIRED',
            'An account with this email already exists using password login. Would you like to link your Google account to it?',
            { email }
          );
        }

        const existingIdentity = await prisma.authIdentity.findFirst({
          where: { userId: byEmail.id, provider: 'google' },
        });
        if (!existingIdentity) {
          await prisma.authIdentity.create({
            data: { userId: byEmail.id, provider: 'google', providerUserId: googleSub },
          });
        }
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

  async loginWithGithub(input: GithubAuthInput): Promise<AuthResult> {
    if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
      throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'GitHub sign-in is not configured on this server');
    }

    let tokenData: { access_token?: string; error?: string; error_description?: string };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const res = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code: input.code,
            redirect_uri: input.redirectUri,
          }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('GitHub token exchange failed');
        tokenData = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
      } finally {
        clearTimeout(timer);
      }
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Invalid or expired GitHub authorization code');
    }

    if (!tokenData.access_token) {
      throw new AppError(401, 'UNAUTHORIZED', tokenData.error_description || 'Invalid or expired GitHub authorization code');
    }

    const ghAccessToken = tokenData.access_token;
    let ghUser: { id: number; login: string };
    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${ghAccessToken}`,
          'User-Agent': 'Embedo-App',
          Accept: 'application/vnd.github.v3+json',
        },
      });
      if (!userRes.ok) throw new Error('Failed to fetch GitHub profile');
      ghUser = (await userRes.json()) as { id: number; login: string };
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Could not retrieve GitHub user profile');
    }

    let emailsRes: Response;
    try {
      emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${ghAccessToken}`,
          'User-Agent': 'Embedo-App',
          Accept: 'application/vnd.github.v3+json',
        },
      });
    } catch {
      throw new AppError(401, 'UNAUTHORIZED', 'Could not verify a GitHub email address');
    }
    if (!emailsRes.ok) {
      throw new AppError(403, 'FORBIDDEN', 'Could not verify a GitHub email address; grant the user:email permission and try again');
    }

    const emailsList = (await emailsRes.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const verifiedEmail = emailsList.find((candidate) => candidate.primary && candidate.verified)
      || emailsList.find((candidate) => candidate.verified);
    const email = verifiedEmail?.email.toLowerCase().trim() || '';

    if (!email) {
      throw new AppError(400, 'BAD_REQUEST', 'Your GitHub account does not have a verified email address');
    }

    const githubSub = String(ghUser.id);

    let user = await prisma.user.findFirst({
      where: { deletedAt: null, authIdentities: { some: { provider: 'github', providerUserId: githubSub } } },
    });

    if (!user) {
      const byEmail = await prisma.user.findFirst({ where: { email, deletedAt: null } });

      if (byEmail) {
        if (byEmail.hashedPassword && !input.linkAccount) {
          throw new AppError(
            409,
            'ACCOUNT_LINK_REQUIRED',
            'An account with this email already exists using password login. Would you like to link your GitHub account to it?',
            { email }
          );
        }

        const existingIdentity = await prisma.authIdentity.findFirst({
          where: { userId: byEmail.id, provider: 'github' },
        });
        if (!existingIdentity) {
          await prisma.authIdentity.create({
            data: { userId: byEmail.id, provider: 'github', providerUserId: githubSub },
          });
        }
        user = byEmail;
      } else {
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
            authIdentities: { create: { provider: 'github', providerUserId: githubSub } },
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
