import crypto from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../common/errors/AppError.js';
import { env } from '../../config/env.js';
import { usersService } from '../users/users.service.js';
import { sessionsService } from '../sessions/sessions.service.js';
import { CreateShareLinkInput } from './shares.validation.js';

const EXPIRATION_MS: Record<'24h' | '7d' | '30d', number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const digestToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

export class SharesService {
  async createLink(sessionId: string, userId: string, input: CreateShareLinkInput, anonSessionToken?: string) {
    const session = anonSessionToken
      ? await sessionsService.getSession(sessionId, userId, anonSessionToken)
      : await sessionsService.getSession(sessionId, userId);
    if (!session.architecture) {
      throw new AppError(400, 'BAD_REQUEST', 'A generated project is required before sharing');
    }

    const settings = await usersService.getShareSettings(userId);
    if (!settings) {
      throw new AppError(409, 'SHARE_SETTINGS_REQUIRED', 'Save sharing settings before creating a viewer link');
    }
    if (!settings.visibility) {
      throw new AppError(
        409,
        'SHARE_VISIBILITY_REQUIRED',
        'Link visibility has not been configured. No viewer link was created'
      );
    }
    if (settings.visibility !== 'public') {
      throw new AppError(
        403,
        'PRIVATE_SHARING_UNAVAILABLE',
        'Private sharing is unavailable until an authorization policy is approved and enforced'
      );
    }

    const issuedAt = new Date();
    const expiresAt = settings.expiration === 'never'
      ? null
      : new Date(issuedAt.getTime() + EXPIRATION_MS[settings.expiration]);
    const token = crypto.randomBytes(32).toString('hex');

    const link = await prisma.shareLink.create({
      data: {
        sessionId,
        userId,
        tokenHash: digestToken(token),
        targetType: input.targetType,
        visibility: settings.visibility,
        expirationPolicy: settings.expiration,
        issuedAt,
        expiresAt,
      },
      select: { id: true, targetType: true, visibility: true, expirationPolicy: true, issuedAt: true, expiresAt: true },
    });

    return {
      ...link,
      viewerUrl: `${env.FRONTEND_URL.replace(/\/$/, '')}/share/${token}`,
    };
  }

  async getViewer(token: string) {
    const now = new Date();
    const link = await prisma.shareLink.findUnique({
      where: { tokenHash: digestToken(token) },
      include: {
        session: {
          select: { id: true, title: true, architecture: true, deletedAt: true, status: true },
        },
      },
    });

    if (
      !link ||
      link.revokedAt ||
      !link.issuedAt ||
      link.issuedAt > now ||
      link.visibility !== 'public' ||
      !link.expirationPolicy ||
      !['24h', '7d', '30d', 'never'].includes(link.expirationPolicy) ||
      link.session.deletedAt ||
      link.session.status === 'SYSTEM' ||
      !link.session.architecture
    ) {
      throw new AppError(404, 'SHARE_NOT_FOUND', 'Share link is unavailable');
    }

    if (link.expirationPolicy === 'never') {
      if (link.expiresAt !== null) {
        throw new AppError(404, 'SHARE_NOT_FOUND', 'Share link is unavailable');
      }
    } else {
      const duration = EXPIRATION_MS[link.expirationPolicy as keyof typeof EXPIRATION_MS];
      const expectedExpiry = link.issuedAt.getTime() + duration;
      if (!link.expiresAt || link.expiresAt.getTime() !== expectedExpiry || link.expiresAt <= now) {
        throw new AppError(404, 'SHARE_NOT_FOUND', 'Share link is unavailable');
      }
    }

    const architecture = link.session.architecture;
    if (link.targetType === 'artifact') {
      return {
        targetType: 'artifact',
        artifact: { format: 'json', architecture },
      };
    }
    if (link.targetType !== 'project') {
      throw new AppError(404, 'SHARE_NOT_FOUND', 'Share link is unavailable');
    }

    return {
      targetType: 'project',
      project: { title: link.session.title || 'Untitled Project', architecture },
    };
  }

  async revokeLink(linkId: string, userId: string): Promise<void> {
    const result = await prisma.shareLink.updateMany({
      where: { id: linkId, userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (result.count !== 1) {
      throw new AppError(404, 'NOT_FOUND', 'Share link not found');
    }
  }
}

export const sharesService = new SharesService();
