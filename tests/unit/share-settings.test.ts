import { afterEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { AppError } from '../../src/common/errors/AppError.js';
import { sessionsService } from '../../src/modules/sessions/sessions.service.js';
import { sharesService } from '../../src/modules/shares/shares.service.js';
import { usersService } from '../../src/modules/users/users.service.js';
import { createShareLinkSchema } from '../../src/modules/shares/shares.validation.js';

const app = createApp();
const ownerId = '11111111-1111-1111-1111-111111111111';
const sessionId = '22222222-2222-2222-2222-222222222222';
const accessToken = (userId = ownerId) =>
  jwt.sign({ userId, email: 'owner@example.test', role: 'user' }, env.JWT_ACCESS_SECRET);

const authenticatedAs = (userId = ownerId, email = 'owner@example.test') => {
  jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({
    id: userId,
    email,
    role: 'user',
    suspendedAt: null,
    deletedAt: null,
    shareVisibility: null,
    shareExpiration: null,
  } as never);
  jest.spyOn(redis, 'get').mockResolvedValue(null);
  return accessToken(userId);
};

const viewerRecord = (overrides: Record<string, unknown> = {}) => ({
  id: '33333333-3333-3333-3333-333333333333',
  targetType: 'project',
  artifactKey: null,
  inviteeEmails: [],
  snapshot: {
    architecture: { projectMeta: { name: 'Viewer project' }, bom: [] },
    messages: [{ role: 'assistant', content: 'Shared conversation' }],
  },
  visibility: 'public',
  expirationPolicy: 'never',
  issuedAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: null,
  revokedAt: null,
  session: {
    id: sessionId,
    title: 'Read-only project',
    deletedAt: null,
    status: 'DONE',
  },
  ...overrides,
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('authenticated sharing settings', () => {
  it('returns null when the authenticated user has not explicitly saved settings', async () => {
    const token = authenticatedAs();
    const findUser = jest.spyOn(prisma.user, 'findFirst');
    const response = await request(app)
      .get('/api/v1/users/me/share-settings')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { settings: null } });
    expect(findUser).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ownerId, deletedAt: null },
    }));
  });

  it('returns only the saved expiry', async () => {
    const token = authenticatedAs();
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({
      id: ownerId,
      deletedAt: null,
      shareVisibility: 'private',
      shareExpiration: '7d',
    } as never);

    const response = await request(app)
      .get('/api/v1/users/me/share-settings')
      .set('Authorization', 'Bearer ' + token);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { settings: { expiration: '7d' } } });
  });

  it('persists the expiry for the authenticated identity and returns the persisted shape', async () => {
    const token = authenticatedAs();
    const update = jest.spyOn(prisma.user, 'update').mockResolvedValue({
      shareExpiration: '7d',
    } as never);

    const response = await request(app)
      .patch('/api/v1/users/me/share-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ expiration: '7d' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { settings: { expiration: '7d' } } });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: ownerId },
      data: { shareExpiration: '7d' },
    }));
  });

  it('rejects invalid values and client-supplied identity fields', async () => {
    const token = authenticatedAs();
    const update = jest.spyOn(prisma.user, 'update');
    const invalidValue = await request(app)
      .patch('/api/v1/users/me/share-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ expiration: 'custom' });
    const invalidVisibility = await request(app)
      .patch('/api/v1/users/me/share-settings')
      .set('Authorization', 'Bearer ' + token)
      .send({ visibility: 'public', expiration: '7d' });
    const clientIdentity = await request(app)
      .patch('/api/v1/users/me/share-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ expiration: 'never', userId: ownerId });

    expect(invalidValue.status).toBe(400);
    expect(invalidVisibility.status).toBe(400);
    expect(clientIdentity.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it('requires authentication and cannot use a client-supplied user id', async () => {
    const anonymous = await request(app)
      .patch('/api/v1/users/me/share-settings')
      .send({ expiration: 'never', userId: ownerId });
    expect(anonymous.status).toBe(401);
  });
});

describe('Project and Artifact share links', () => {
  it('returns and persists the per-project share target for the authenticated owner', async () => {
    const token = authenticatedAs();
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({
      userId: ownerId,
      shareTargetType: 'artifact',
    } as never);
    const update = jest.spyOn(prisma.designSession, 'update').mockResolvedValue({} as never);

    const current = await request(app)
      .get(`/api/v1/sessions/${sessionId}/share-preference`)
      .set('Authorization', 'Bearer ' + token);
    const saved = await request(app)
      .patch(`/api/v1/sessions/${sessionId}/share-preference`)
      .set('Authorization', 'Bearer ' + token)
      .send({ targetType: 'project' });

    expect(current.status).toBe(200);
    expect(current.body).toEqual({ data: { targetType: 'artifact' } });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ data: { targetType: 'project' } });
    expect(update).toHaveBeenCalledWith({
      where: { id: sessionId },
      data: { shareTargetType: 'project' },
    });
  });

  it('does not expose or update another user’s share-target preference', async () => {
    const token = authenticatedAs();
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({
      userId: '55555555-5555-5555-5555-555555555555',
      shareTargetType: 'project',
    } as never);
    const update = jest.spyOn(prisma.designSession, 'update');

    const response = await request(app)
      .patch(`/api/v1/sessions/${sessionId}/share-preference`)
      .set('Authorization', 'Bearer ' + token)
      .send({ targetType: 'project' });

    expect(response.status).toBe(403);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects invalid share-target preference values', async () => {
    const token = authenticatedAs();
    const getSession = jest.spyOn(sessionsService, 'getSession');

    const response = await request(app)
      .patch(`/api/v1/sessions/${sessionId}/share-preference`)
      .set('Authorization', 'Bearer ' + token)
      .send({ targetType: 'invalid' });

    expect(response.status).toBe(400);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('validates per-link visibility and requires invitees for private links', () => {
    expect(createShareLinkSchema.parse({ targetType: 'project', visibility: 'public' }))
      .toEqual({ targetType: 'project', visibility: 'public' });
    expect(() => createShareLinkSchema.parse({
      targetType: 'project',
      visibility: 'private',
    })).toThrow();
    expect(() => createShareLinkSchema.parse({
      targetType: 'artifact',
      artifactKey: 'unsupported',
    })).toThrow();
  });

  it('requires the authenticated owner and explicit public settings before issuing either link type', async () => {
    const token = authenticatedAs();
    const ownerCheck = jest.spyOn(sessionsService, 'getSession').mockRejectedValue(
      new AppError(403, 'FORBIDDEN', 'You do not have permission to access this design session')
    );
    const denied = await request(app)
      .post(`/api/v1/sessions/${sessionId}/share-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ targetType: 'project', visibility: 'public' });
    expect(denied.status).toBe(403);
    expect(ownerCheck).toHaveBeenCalledWith(sessionId, ownerId);

    jest.restoreAllMocks();
    const ownerToken = authenticatedAs();
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({
      userId: ownerId,
      architecture: { bom: [], functionalBlock: { nodes: [{ id: 'n1' }] } },
    } as never);
    jest.spyOn(usersService, 'getShareSettings').mockResolvedValue(null);
    const unset = await request(app)
      .post(`/api/v1/sessions/${sessionId}/share-links`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetType: 'artifact', artifactKey: 'fbd', visibility: 'public' });
    expect(unset.status).toBe(409);
    expect(unset.body.error.code).toBe('SHARE_SETTINGS_REQUIRED');
  });

  it('issues a public link using an immutable settings snapshot and exact expiry measured from issuance', async () => {
    const getSession = jest.spyOn(sessionsService, 'getSession').mockResolvedValue({
      userId: ownerId,
      architecture: { bom: [], functionalBlock: { nodes: [{ id: 'n1' }] } },
    } as never);
    const getSettings = jest.spyOn(usersService, 'getShareSettings').mockResolvedValue({
      expiration: '24h',
    });

    const create = jest.spyOn(prisma.shareLink, 'create').mockImplementation(async (args) => ({
      id: '44444444-4444-4444-4444-444444444444',
      targetType: args.data.targetType,
      artifactKey: args.data.artifactKey,
      inviteeEmails: args.data.inviteeEmails,
      visibility: args.data.visibility,
      expirationPolicy: args.data.expirationPolicy,
      issuedAt: args.data.issuedAt,
      expiresAt: args.data.expiresAt,
    } as never));

    const before = Date.now();
    const result = await sharesService.createLink(
      sessionId,
      ownerId,
      { targetType: 'artifact', artifactKey: 'fbd', visibility: 'public' },
      'claimed-guest-session'
    );
    const persisted = create.mock.calls[0]![0].data;

    expect(getSession).toHaveBeenCalledWith(sessionId, ownerId, 'claimed-guest-session');
    expect(getSettings).toHaveBeenCalledWith(ownerId);
    expect(persisted).toMatchObject({
      sessionId,
      userId: ownerId,
      targetType: 'artifact',
      artifactKey: 'fbd',
      visibility: 'public',
      expirationPolicy: '24h',
    });
    expect(persisted.snapshot).toEqual({ nodes: [{ id: 'n1' }] });
    expect(persisted.issuedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(persisted.expiresAt!.getTime() - persisted.issuedAt!.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(result.viewerUrl).toMatch(/^http:\/\/localhost:5173\/architect\/artifact-viewer\/[a-f0-9]{64}$/);
    expect(JSON.stringify(create.mock.calls)).not.toContain(result.viewerUrl.split('/').pop());
  });

  it('uses the selected link visibility and saved account expiry', async () => {
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({
      userId: ownerId,
      architecture: { bom: [] },
    } as never);
    jest.spyOn(usersService, 'getShareSettings').mockResolvedValue({
      expiration: '7d',
    });
    const create = jest.spyOn(prisma.shareLink, 'create').mockImplementation(async (args) => ({
      id: '44444444-4444-4444-4444-444444444444',
      targetType: args.data.targetType,
      artifactKey: args.data.artifactKey,
      inviteeEmails: args.data.inviteeEmails,
      visibility: args.data.visibility,
      expirationPolicy: args.data.expirationPolicy,
      issuedAt: args.data.issuedAt,
      expiresAt: args.data.expiresAt,
    } as never));

    const result = await sharesService.createLink(sessionId, ownerId, {
      targetType: 'project',
      visibility: 'private',
      inviteeEmails: ['person@example.test'],
    });
    expect(create.mock.calls[0]![0].data).toMatchObject({
      visibility: 'private',
      inviteeEmails: ['person@example.test'],
      expirationPolicy: '7d',
    });
    expect(result.visibility).toBe('private');
  });

  it('does not let a Project collaborator create another share link', async () => {
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({
      userId: ownerId,
      architecture: { bom: [] },
    } as never);
    const getSettings = jest.spyOn(usersService, 'getShareSettings');

    await expect(sharesService.createLink(sessionId, '55555555-5555-5555-5555-555555555555', {
      targetType: 'project',
      visibility: 'public',
    })).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    });
    expect(getSettings).not.toHaveBeenCalled();
  });

  it('snapshots the project architecture and read-only conversation at issuance', async () => {
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({
      userId: ownerId,
      architecture: { functionalBlock: { nodes: [{ id: 'n1' }] } },
      chatMessages: [
        { role: 'system', content: 'Do not expose this' },
        { role: 'user', content: 'A project brief' },
        { role: 'assistant', content: 'A response' },
      ],
    } as never);
    jest.spyOn(usersService, 'getShareSettings').mockResolvedValue({
      expiration: 'never',
    });
    const create = jest.spyOn(prisma.shareLink, 'create').mockImplementation(async (args) => ({
      id: '44444444-4444-4444-4444-444444444444',
      targetType: args.data.targetType,
      artifactKey: args.data.artifactKey,
      inviteeEmails: args.data.inviteeEmails,
      visibility: args.data.visibility,
      expirationPolicy: args.data.expirationPolicy,
      issuedAt: args.data.issuedAt,
      expiresAt: args.data.expiresAt,
    } as never));

    await sharesService.createLink(sessionId, ownerId, {
      targetType: 'project',
      visibility: 'public',
    });

    expect(create.mock.calls[0]![0].data.snapshot).toEqual({
      architecture: { functionalBlock: { nodes: [{ id: 'n1' }] } },
      messages: [
        { role: 'user', content: 'A project brief' },
        { role: 'assistant', content: 'A response' },
      ],
    });
  });

  it('rejects client-supplied link policy and expiration values', async () => {
    const token = authenticatedAs();
    const getSession = jest.spyOn(sessionsService, 'getSession');
    const response = await request(app)
      .post(`/api/v1/sessions/${sessionId}/share-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ targetType: 'project', visibility: 'public', expiration: 'never' });

    expect(response.status).toBe(400);
    expect(getSession).not.toHaveBeenCalled();
  });

  it('supports anonymous read-only viewing for a public Project link', async () => {
    jest.spyOn(prisma.shareLink, 'findUnique').mockResolvedValue(viewerRecord() as never);
    const response = await request(app).get(`/api/v1/share-links/${'a'.repeat(64)}`);

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(response.body.data).toMatchObject({
      targetType: 'project',
      project: {
        title: 'Read-only project',
        architecture: { projectMeta: { name: 'Viewer project' }, bom: [] },
        messages: [{ role: 'assistant', content: 'Shared conversation' }],
      },
    });
    expect(response.body.data).not.toHaveProperty('edit');
    expect(response.body.data).not.toHaveProperty('share');
    expect(response.body.data.project).toMatchObject({ canEdit: false });
    expect(response.body.data.project).not.toHaveProperty('sessionId');
  });

  it('supports anonymous read-only viewing for a public Artifact link', async () => {
    jest.spyOn(prisma.shareLink, 'findUnique').mockResolvedValue(viewerRecord({
      targetType: 'artifact',
      artifactKey: 'fbd',
      snapshot: { nodes: [{ id: 'fbd-node' }] },
    }) as never);
    const response = await request(app).get(`/api/v1/share-links/${'b'.repeat(64)}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      targetType: 'artifact',
      artifact: {
        key: 'fbd',
        title: 'Functional Block Diagram',
        format: 'json',
        content: { nodes: [{ id: 'fbd-node' }] },
      },
    });

    expect(response.body.data).not.toHaveProperty('edit');
    expect(response.body.data).not.toHaveProperty('share');
    expect(response.body.data.artifact).not.toHaveProperty('canEdit');
  });

  it('requires an authenticated invited email to read a private link', async () => {
      jest.spyOn(prisma.shareLink, 'findUnique').mockResolvedValue(viewerRecord({
        visibility: 'private',
        inviteeEmails: ['invited@example.test'],
      }) as never);
      const anonymous = await request(app).get(`/api/v1/share-links/${'c'.repeat(64)}`);
      expect(anonymous.status).toBe(404);

      const token = authenticatedAs(ownerId, 'not-invited@example.test');
      const denied = await request(app)
        .get(`/api/v1/share-links/${'c'.repeat(64)}`)
        .set('Authorization', `Bearer ${token}`);
      expect(denied.status).toBe(404);

      jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({
        id: ownerId,
        email: 'invited@example.test',
        role: 'user',
        suspendedAt: null,
      } as never);
      const allowed = await request(app)
        .get(`/api/v1/share-links/${'c'.repeat(64)}`)
        .set('Authorization', `Bearer ${token}`);
      expect(allowed.status).toBe(200);
      expect(allowed.body.data.visibility).toBe('private');
      expect(allowed.body.data).not.toHaveProperty('inviteeEmails');
    });
  it('does not make legacy /workspace project URLs public', async () => {
    const token = authenticatedAs();
    jest.spyOn(prisma.shareLink, 'findMany').mockResolvedValue([] as never);
    jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValue({
      id: sessionId,
      userId: '55555555-5555-5555-5555-555555555555',
      anonSessionToken: null,
      deletedAt: null,
      status: 'DONE',
    } as never);

    const response = await request(app)
      .get(`/api/v1/sessions/${sessionId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
  });

  it.each([
    ['24h', 24 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
    ['30d', 30 * 24 * 60 * 60 * 1000],
  ] as const)('expires %s after issuance', async (policy, duration) => {
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const expiresAt = new Date(issuedAt.getTime() + duration);
    jest.useFakeTimers().setSystemTime(new Date(expiresAt.getTime() - 1));
    jest.spyOn(prisma.shareLink, 'findUnique').mockResolvedValue(viewerRecord({
      expirationPolicy: policy,
      issuedAt,
      expiresAt,
    }) as never);
    await expect(sharesService.getViewer('public-token')).resolves.toMatchObject({ targetType: 'project' });

    jest.setSystemTime(expiresAt);
    await expect(sharesService.getViewer('public-token')).rejects.toMatchObject({
      statusCode: 404,
      code: 'SHARE_NOT_FOUND',
    });
  });

  it('supports Never links but denies revoked, deleted, and legacy ambiguous links', async () => {
    const findLink = jest.spyOn(prisma.shareLink, 'findUnique').mockResolvedValue(viewerRecord() as never);
    await expect(sharesService.getViewer('never-token')).resolves.toMatchObject({ targetType: 'project' });

    for (const invalid of [
      { revokedAt: new Date() },
      { visibility: null },
      { issuedAt: null },
      { expirationPolicy: null },
      { session: { ...viewerRecord().session, deletedAt: new Date() } },
    ]) {
      findLink.mockResolvedValueOnce(viewerRecord(invalid) as never);
      await expect(sharesService.getViewer('unavailable')).rejects.toMatchObject({
        statusCode: 404,
        code: 'SHARE_NOT_FOUND',
      });
    }
  });

  it('keeps already issued expiration policy unchanged when account settings change', async () => {
    const issuedAt = new Date(Date.now() - 1000);
    const issuedLink = viewerRecord({
      targetType: 'artifact',
      artifactKey: 'fbd',
      snapshot: { nodes: [{ id: 'original' }] },
      expirationPolicy: '7d',
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    jest.spyOn(prisma.shareLink, 'findUnique').mockResolvedValue(issuedLink as never);
    jest.spyOn(prisma.user, 'update').mockResolvedValue({
      shareVisibility: 'public',
      shareExpiration: '24h',
    } as never);

    await usersService.updateShareSettings(ownerId, { visibility: 'public', expiration: '24h' });
    const view = await sharesService.getViewer('snapshot-token');
    expect(issuedLink.expirationPolicy).toBe('7d');
    expect(issuedLink.visibility).toBe('public');
    expect(view.targetType).toBe('artifact');
    expect(view.artifact.content).toEqual({ nodes: [{ id: 'original' }] });
  });

  it('rejects guest issuance and ties revocation to the authenticated owner', async () => {
    const guest = await request(app)
      .post(`/api/v1/sessions/${sessionId}/share-links`)
      .send({ targetType: 'project' });
    expect(guest.status).toBe(401);

    const token = authenticatedAs();
    const revoke = jest.spyOn(prisma.shareLink, 'updateMany').mockResolvedValue({ count: 1 } as never);
    const response = await request(app)
      .delete('/api/v1/share-links/33333333-3333-3333-3333-333333333333')
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: '33333333-3333-3333-3333-333333333333', userId: ownerId, revokedAt: null },
    }));
  });
});
