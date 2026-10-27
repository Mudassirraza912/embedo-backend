import bcrypt from 'bcryptjs';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../common/errors/AppError.js';
import { ShareSettingsInput } from './users.validation.js';

export interface UpdateProfileInput {
  expertiseLevel?: 'student' | 'hobbyist' | 'professional' | 'expert';
}

export class UsersService {
  async getShareSettings(userId: string) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { shareExpiration: true },
    });

    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    const { shareExpiration } = user;
    if (shareExpiration === null) return null;
    if (!isShareExpiration(shareExpiration)) {
      throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'Stored sharing settings are invalid');
    }

    return { expiration: shareExpiration };
  }

  async updateShareSettings(userId: string, input: ShareSettingsInput) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: { shareExpiration: input.expiration },
      select: { shareExpiration: true },
    });

    if (user.shareExpiration !== input.expiration) {
      throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'Sharing settings were not persisted');
    }

    return { expiration: user.shareExpiration };
  }

  async getProfile(userId: string) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        role: true,
        expertiseLevel: true,
        dataConsent: true,
        dataConsentDate: true,
        createdAt: true,
        subscriptions: {
          where: { status: 'active' },
          select: { plan: true, status: true, currentPeriodEnd: true },
        },
      },
    });

    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    const currentPlan = user.subscriptions[0]?.plan || 'free';

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      expertiseLevel: user.expertiseLevel,
      dataConsent: user.dataConsent,
      dataConsentDate: user.dataConsentDate,
      plan: currentPlan,
      createdAt: user.createdAt,
    };
  }

  async updateProfile(userId: string, input: UpdateProfileInput) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        expertiseLevel: input.expertiseLevel,
      },
      select: {
        id: true,
        email: true,
        role: true,
        expertiseLevel: true,
        dataConsent: true,
      },
    });

    return user;
  }

  async updateConsent(userId: string, consent: boolean) {
    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        dataConsent: consent,
        dataConsentDate: consent ? new Date() : null,
      },
      select: {
        id: true,
        dataConsent: true,
        dataConsentDate: true,
      },
    });

    return user;
  }

  /**
   * Soft-deletes user account according to Database.md §6.1
   * - Scrubs PII (email, password)
   * - Revokes tokens & OAuth links
   * - PRESERVES design_sessions, ai_calls, user_feedback, and design_outcomes (training moat)
   */
  async deleteAccount(userId: string, passwordConfirmation?: string) {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
    });

    if (!user) {
      throw new AppError(404, 'NOT_FOUND', 'User not found');
    }

    if (user.hashedPassword) {
      if (!passwordConfirmation) {
        throw new AppError(400, 'BAD_REQUEST', 'Password confirmation is required to delete your account');
      }
      const isValid = await bcrypt.compare(passwordConfirmation, user.hashedPassword);
      if (!isValid) {
        throw new AppError(400, 'BAD_REQUEST', 'Incorrect password confirmation');
      }
    }

    const anonymizedEmail = `deleted-${user.id}@embedo.invalid`;

    await prisma.$transaction([
      // 1. Soft-delete and PII scrub
      prisma.user.update({
        where: { id: userId },
        data: {
          email: anonymizedEmail,
          hashedPassword: null,
          deletedAt: new Date(),
        },
      }),

      prisma.shareLink.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),

      // 2. Remove OAuth links
      prisma.authIdentity.deleteMany({
        where: { userId },
      }),

      // 3. Revoke all refresh tokens
      prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    return { success: true, message: 'Account deleted and personal identity erased' };
  }
}

const isShareExpiration = (value: string | null): value is ShareSettingsInput['expiration'] =>
  value === '24h' || value === '7d' || value === '30d' || value === 'never';

export const usersService = new UsersService();
