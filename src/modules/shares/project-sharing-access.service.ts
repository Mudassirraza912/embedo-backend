import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';

const EXPIRATION_MS: Record<'24h' | '7d' | '30d', number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

type ProjectShareAccessRecord = {
  targetType: string;
  visibility: string | null;
  inviteeEmails: string[];
  expirationPolicy: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
  snapshot: Prisma.JsonValue | null;
};

const hasProjectSnapshot = (snapshot: Prisma.JsonValue | null): boolean => {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const project = snapshot as Prisma.JsonObject;
  const architecture = project['architecture'];
  const messages = project['messages'];
  return (
    typeof architecture === 'object' &&
    architecture !== null &&
    !Array.isArray(architecture) &&
    Array.isArray(messages) &&
    messages.every((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
      const item = message as Prisma.JsonObject;
      return (
        (item['role'] === 'user' || item['role'] === 'assistant') &&
        typeof item['content'] === 'string'
      );
    })
  );
};

export const isActiveProjectShare = (
  link: ProjectShareAccessRecord,
  now: Date = new Date()
): boolean => {
  if (
    link.targetType !== 'project' ||
    link.revokedAt ||
    !link.issuedAt ||
    link.issuedAt > now ||
    !hasProjectSnapshot(link.snapshot)
  ) {
    return false;
  }

  if (link.expirationPolicy === 'never') return link.expiresAt === null;
  if (
    link.expirationPolicy !== '24h' &&
    link.expirationPolicy !== '7d' &&
    link.expirationPolicy !== '30d'
  ) {
    return false;
  }

  const expectedExpiry = link.issuedAt.getTime() + EXPIRATION_MS[link.expirationPolicy];
  return link.expiresAt?.getTime() === expectedExpiry && link.expiresAt > now;
};

export class ProjectSharingAccessService {
  async canEdit(sessionId: string, userId: string): Promise<boolean> {
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { email: true },
    });
    if (!user) return false;

    const now = new Date();
    const links = await prisma.shareLink.findMany({
      where: {
        sessionId,
        targetType: 'project',
        revokedAt: null,
        issuedAt: { not: null, lte: now },
        OR: [
          { visibility: 'public' },
          { visibility: 'private', inviteeEmails: { has: user.email.toLowerCase() } },
        ],
      },
      select: {
        targetType: true,
        visibility: true,
        inviteeEmails: true,
        expirationPolicy: true,
        issuedAt: true,
        expiresAt: true,
        revokedAt: true,
        snapshot: true,
      },
    });

    return links.some((link) => {
      if (!isActiveProjectShare(link, now)) return false;
      return link.visibility === 'public' ||
        (link.visibility === 'private' &&
          link.inviteeEmails.some((email) => email.toLowerCase() === user.email.toLowerCase()));
    });
  }

  async accessibleSessionIds(userEmail: string): Promise<string[]> {
    const now = new Date();
    const links = await prisma.shareLink.findMany({
      where: {
        targetType: 'project',
        revokedAt: null,
        issuedAt: { not: null, lte: now },
        OR: [
          { visibility: 'public' },
          { visibility: 'private', inviteeEmails: { has: userEmail.toLowerCase() } },
        ],
      },
      select: {
        sessionId: true,
        targetType: true,
        visibility: true,
        inviteeEmails: true,
        expirationPolicy: true,
        issuedAt: true,
        expiresAt: true,
        revokedAt: true,
        snapshot: true,
      },
    });

    return [...new Set(links
      .filter((link) => {
        if (!isActiveProjectShare(link, now)) return false;
        return link.visibility === 'public' ||
          (link.visibility === 'private' &&
            link.inviteeEmails.some((email) => email.toLowerCase() === userEmail.toLowerCase()));
      })
      .map((link) => link.sessionId))];
  }
}

export const projectSharingAccessService = new ProjectSharingAccessService();
