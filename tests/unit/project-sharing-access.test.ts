import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { aiPipelineQueue } from '../../src/jobs/ai-pipeline.queue.js';
import { sessionsService } from '../../src/modules/sessions/sessions.service.js';
import {
  isActiveProjectShare,
  projectSharingAccessService,
} from '../../src/modules/shares/project-sharing-access.service.js';

const ownerId = '11111111-1111-1111-1111-111111111111';
const collaboratorId = '22222222-2222-2222-2222-222222222222';
const sessionId = '33333333-3333-3333-3333-333333333333';
const issuedAt = new Date(Date.now() - 60_000);

function projectLink(overrides: Record<string, unknown> = {}) {
  return {
    sessionId,
    targetType: 'project',
    visibility: 'private',
    inviteeEmails: ['collaborator@example.test'],
    expirationPolicy: '7d',
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
    revokedAt: null,
    snapshot: {
      architecture: { projectMeta: { name: 'Shared project' } },
      messages: [{ role: 'assistant', content: 'Shared' }],
    },
    ...overrides,
  };
}

afterEach(() => jest.restoreAllMocks());

describe('shared Project authorization', () => {
  it('grants active private project access only to the invited account email', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({
      email: 'collaborator@example.test',
    } as never);
    jest.spyOn(prisma.shareLink, 'findMany').mockResolvedValue([projectLink()] as never);

    await expect(projectSharingAccessService.canEdit(sessionId, collaboratorId)).resolves.toBe(true);

    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({
      email: 'other@example.test',
    } as never);
    await expect(projectSharingAccessService.canEdit(sessionId, collaboratorId)).resolves.toBe(false);
  });

  it('allows authenticated users on an active public Project link, but never Artifact links', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({
      email: 'viewer@example.test',
    } as never);
    const findLinks = jest.spyOn(prisma.shareLink, 'findMany').mockResolvedValue([
      projectLink({ visibility: 'public', inviteeEmails: [] }),
    ] as never);

    await expect(projectSharingAccessService.canEdit(sessionId, collaboratorId)).resolves.toBe(true);
    findLinks.mockResolvedValueOnce([projectLink({ targetType: 'artifact', visibility: 'public' })] as never);
    await expect(projectSharingAccessService.canEdit(sessionId, collaboratorId)).resolves.toBe(false);
  });

  it('fails closed for revoked, expired, missing-policy, and malformed legacy Project links', () => {
    const valid = projectLink();
    expect(isActiveProjectShare(valid)).toBe(true);
    expect(isActiveProjectShare(projectLink({ revokedAt: new Date() }))).toBe(false);
    expect(isActiveProjectShare(projectLink({ expiresAt: new Date(Date.now() - 1) }))).toBe(false);
    expect(isActiveProjectShare(projectLink({ expirationPolicy: null }))).toBe(false);
    expect(isActiveProjectShare(projectLink({ snapshot: null }))).toBe(false);
  });

  it('lets an invited collaborator perform a session write, while preserving owner-only deletion', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({
      email: 'collaborator@example.test',
    } as never);
    jest.spyOn(prisma.shareLink, 'findMany').mockResolvedValue([projectLink()] as never);
    jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValue({
      id: sessionId,
      userId: ownerId,
      anonSessionToken: null,
      status: 'FAILED',
      deletedAt: null,
      architecture: { projectMeta: { name: 'Shared project' } },
      applicationContext: 'architect',
      chatMessages: [],
      userFeedback: [],
      designOutcome: null,
    } as never);
    const update = jest.spyOn(prisma.designSession, 'update').mockResolvedValue({} as never);
    const enqueue = jest.spyOn(aiPipelineQueue, 'add').mockResolvedValue({} as never);

    await expect(sessionsService.retry(sessionId, collaboratorId)).resolves.toMatchObject({
      sessionId,
      status: 'PENDING',
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: sessionId },
      data: { status: 'PENDING' },
    });
    expect(enqueue).toHaveBeenCalled();

    update.mockClear();
    await expect(sessionsService.deleteSession(sessionId, collaboratorId)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('lists only currently accessible shared Project IDs', async () => {
    const findLinks = jest.spyOn(prisma.shareLink, 'findMany').mockResolvedValue([
      projectLink({ sessionId, visibility: 'public', inviteeEmails: [] }),
      projectLink({ sessionId: '44444444-4444-4444-4444-444444444444', revokedAt: new Date() }),
    ] as never);

    await expect(projectSharingAccessService.accessibleSessionIds('viewer@example.test'))
      .resolves.toEqual([sessionId]);
    expect(findLinks).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ targetType: 'project' }),
    }));
  });
});
