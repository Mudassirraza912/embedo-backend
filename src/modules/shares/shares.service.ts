import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../common/errors/AppError.js';
import { env } from '../../config/env.js';
import { usersService } from '../users/users.service.js';
import { sessionsService } from '../sessions/sessions.service.js';
import { CreateShareLinkInput } from './shares.validation.js';

const ARTIFACT_TITLES = {
  fbd: 'Functional Block Diagram',
  power: 'Power Tree',
  protocol: 'Protocol Map',
  prototypeDiagram: 'Prototype Module Diagram',
} as const;

const ARCHITECT_ARTIFACT_FIELDS = [
  'functionalBlock',
  'powerTree',
  'protocolMap',
  'bom',
  'projectMeta',
  'summary',
  'version',
] as const;

const EXPIRATION_MS: Record<'24h' | '7d' | '30d', number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

const digestToken = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');

function buildArtifactSnapshot(architecture: Record<string, unknown>, artifactKey: keyof typeof ARTIFACT_TITLES) {
  if (artifactKey === 'prototypeDiagram') {
    if (architecture.kind !== 'prototype' || !architecture.moduleDiagram) return null;
    const snapshot: Record<string, unknown> = {};
    for (const key of [
      'kind',
      'schemaVersion',
      'versionTag',
      'understanding',
      'notes',
      'stateHash',
      'projectMeta',
      'instances',
      'nets',
      'connections',
      'gaps',
      'compatibility',
      'moduleDiagram',
      'pinList',
      'hardwareLibrary',
      'domainKnowledge',
      'bom',
      'summary',
      'version',
    ]) {
      const value = architecture[key];
      if (value !== undefined && value !== null) snapshot[key] = value;
    }
    return snapshot;
  }

  const selectedDiagram = artifactKey === 'fbd'
    ? architecture.functionalBlock
    : artifactKey === 'power'
      ? architecture.powerTree
      : architecture.protocolMap;
  if (!selectedDiagram || typeof selectedDiagram !== 'object' || Array.isArray(selectedDiagram)) return null;

  const snapshot: Record<string, unknown> = { kind: 'architect' };
  for (const key of ARCHITECT_ARTIFACT_FIELDS) {
    const value = architecture[key];
    if (value !== undefined && value !== null) snapshot[key] = value;
  }
  return snapshot;
}

export class SharesService {
  async getTargetPreference(sessionId: string, userId: string) {
    const session = await sessionsService.getSession(sessionId, userId);
    if (session.userId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Only the project owner can manage share preferences');
    }
    return { targetType: session.shareTargetType === 'project' ? 'project' : 'artifact' } as const;
  }

  async updateTargetPreference(sessionId: string, userId: string, targetType: 'artifact' | 'project') {
    const session = await sessionsService.getSession(sessionId, userId);
    if (session.userId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Only the project owner can manage share preferences');
    }
    await prisma.designSession.update({
      where: { id: sessionId },
      data: { shareTargetType: targetType },
    });
    return { targetType };
  }

  async createLink(sessionId: string, userId: string, input: CreateShareLinkInput, anonSessionToken?: string) {
    const session = anonSessionToken
      ? await sessionsService.getSession(sessionId, userId, anonSessionToken)
      : await sessionsService.getSession(sessionId, userId);
    if (session.userId !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Only the project owner can create share links');
    }
    if (!session.architecture) {
      throw new AppError(400, 'BAD_REQUEST', 'A generated project is required before sharing');
    }
    if (input.targetType === 'artifact' && !input.artifactKey) {
      throw new AppError(400, 'BAD_REQUEST', 'Select a supported diagram before creating an Artifact link');
    }

    const architecture = session.architecture;
    if (typeof architecture !== 'object' || architecture === null || Array.isArray(architecture)) {
      throw new AppError(400, 'BAD_REQUEST', 'The generated design snapshot is unavailable');
    }
    const architectureObject = architecture as Record<string, unknown>;
    const snapshot = input.targetType === 'project'
      ? {
          architecture,
          messages: (Array.isArray(session.chatMessages) ? session.chatMessages : [])
            .filter((message) => message.role === 'user' || message.role === 'assistant')
            .map((message) => ({ role: message.role, content: message.content })),
        }
      : buildArtifactSnapshot(architectureObject, input.artifactKey!);
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      throw new AppError(400, 'BAD_REQUEST', 'The selected diagram is not available in this design');
    }

    const settings = await usersService.getShareSettings(userId);
    if (!settings) {
      throw new AppError(409, 'SHARE_SETTINGS_REQUIRED', 'Save an expiry preference before creating a viewer link');
    }
    if (input.visibility === 'private') {
      throw new AppError(
        409,
        'PRIVATE_SHARING_UNAVAILABLE',
        'Private share links are unavailable until an approved access policy is configured'
      );
    }
    const issuedAt = new Date();
    const expiresAt = settings.expiration === 'never'
      ? null
      : new Date(issuedAt.getTime() + EXPIRATION_MS[settings.expiration]);
    const token = crypto.randomBytes(32).toString('hex');
    const artifactKey = input.targetType === 'artifact' ? input.artifactKey : null;

    const link = await prisma.shareLink.create({
      data: {
        sessionId,
        userId,
        tokenHash: digestToken(token),
        targetType: input.targetType,
        artifactKey,
        snapshot: snapshot as unknown as Prisma.InputJsonValue,
        inviteeEmails: [],
        visibility: input.visibility,
        expirationPolicy: settings.expiration,
        issuedAt,
        expiresAt,
      },
      select: {
        id: true,
        targetType: true,
        artifactKey: true,
        inviteeEmails: true,
        visibility: true,
        expirationPolicy: true,
        issuedAt: true,
        expiresAt: true,
      },
    });

    const { inviteeEmails, ...publicMetadata } = link;
    const artifactMode = input.targetType === 'artifact'
      ? input.artifactKey === 'prototypeDiagram' ? 'prototype' : 'architect'
      : null;
    return {
      ...publicMetadata,
      invitedCount: inviteeEmails.length,
      viewerUrl: input.targetType === 'project'
        ? `${env.FRONTEND_URL.replace(/\/$/, '')}/project-viewer/${token}`
        : `${env.FRONTEND_URL.replace(/\/$/, '')}/${artifactMode}/artifact-viewer/${token}`,
    };
  }

  async getViewer(token: string, viewerEmail?: string) {
    const now = new Date();
    const link = await prisma.shareLink.findUnique({
      where: { tokenHash: digestToken(token) },
      include: {
        session: {
          select: { id: true, title: true, deletedAt: true, status: true },
        },
      },
    });

    if (
      !link ||
      link.revokedAt ||
      !link.issuedAt ||
      link.issuedAt > now ||
      !['public', 'private'].includes(link.visibility || '') ||
      !link.expirationPolicy ||
      !['24h', '7d', '30d', 'never'].includes(link.expirationPolicy) ||
      typeof link.snapshot !== 'object' ||
      link.snapshot === null ||
      Array.isArray(link.snapshot) ||
      link.session.deletedAt ||
      link.session.status === 'SYSTEM' ||
      !['project', 'artifact'].includes(link.targetType)
    ) {
      throw new AppError(404, 'SHARE_NOT_FOUND', 'Share link is unavailable');
    }

    if (
      link.visibility === 'private' &&
      (!viewerEmail || !link.inviteeEmails.some((email) => email.toLowerCase() === viewerEmail.trim().toLowerCase()))
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

    const linkMetadata = {
      visibility: link.visibility,
      expirationPolicy: link.expirationPolicy,
      issuedAt: link.issuedAt,
      expiresAt: link.expiresAt,
    };
    if (link.targetType === 'artifact') {
      if (!link.artifactKey || !(link.artifactKey in ARTIFACT_TITLES)) {
        throw new AppError(404, 'SHARE_NOT_FOUND', 'Share link is unavailable');
      }
      if (!Object.keys(link.snapshot).length) {
        throw new AppError(404, 'SHARE_NOT_FOUND', 'Share link is unavailable');
      }
      return {
        targetType: 'artifact',
        ...linkMetadata,
        artifact: {
          mode: link.artifactKey === 'prototypeDiagram' ? 'prototype' : 'architect',
          key: link.artifactKey,
          title: ARTIFACT_TITLES[link.artifactKey as keyof typeof ARTIFACT_TITLES],
          sourceProject: link.session.title || 'Untitled Project',
          issuedAt: link.issuedAt,
          format: 'json',
          content: link.snapshot,
        },
      };
    }

    const projectSnapshot = link.snapshot as Record<string, unknown>;
    const projectArchitecture = projectSnapshot.architecture;
    const projectMessages = projectSnapshot.messages;
    if (
      typeof projectArchitecture !== 'object' ||
      projectArchitecture === null ||
      Array.isArray(projectArchitecture) ||
      !Array.isArray(projectMessages) ||
      projectMessages.some((message) =>
        !message ||
        typeof message !== 'object' ||
        !('role' in message) ||
        !('content' in message) ||
        !['user', 'assistant'].includes(String(message.role)) ||
        typeof message.content !== 'string'
      )
    ) {
      throw new AppError(404, 'SHARE_NOT_FOUND', 'Share link is unavailable');
    }

    return {
      targetType: 'project',
      ...linkMetadata,
      project: {
        title: link.session.title || 'Untitled Project',
        architecture: projectArchitecture,
        messages: projectMessages,
        ...(viewerEmail
          ? { sessionId: link.session.id, canEdit: true }
          : { canEdit: false }),
      },
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
