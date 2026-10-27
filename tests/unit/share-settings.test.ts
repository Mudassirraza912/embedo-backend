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

const app = createApp();
const ownerId = '11111111-1111-1111-1111-111111111111';
const sessionId = '22222222-2222-2222-2222-222222222222';
const accessToken = (userId = ownerId) =>
  jwt.sign({ userId, email: 'owner@example.test', role: 'user' }, env.JWT_ACCESS_SECRET);

const authenticatedAs = (userId = ownerId) => {
  jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({
    id: userId,
    email: 'owner@example.test',
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
  visibility: 'public',
  expirationPolicy: 'never',
  issuedAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: null,
  revokedAt: null,
  session: {
    id: sessionId,
    title: 'Read-only project',
    architecture: { projectMeta: { name: 'Viewer project' }, bom: [] },
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

  it('returns only the saved expiry even if an older visibility value exists', async () => {
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

  it('persists only expiration for the authenticated identity and returns the persisted shape', async () => {
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
    const clientIdentity = await request(app)
      .patch('/api/v1/users/me/share-settings')
      .set('Authorization', `Bearer ${token}`)
      .send({ expiration: 'never', visibility: 'private' });

    expect(invalidValue.status).toBe(400);
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
  it('requires the authenticated owner and explicit public settings before issuing either link type', async () => {
    const token = authenticatedAs();
    const ownerCheck = jest.spyOn(sessionsService, 'getSession').mockRejectedValue(
      new AppError(403, 'FORBIDDEN', 'You do not have permission to access this design session')
    );
    const denied = await request(app)
      .post(`/api/v1/sessions/${sessionId}/share-links`)
      .set('Authorization', `Bearer ${token}`)
      .send({ targetType: 'project' });
    expect(denied.status).toBe(403);
    expect(ownerCheck).toHaveBeenCalledWith(sessionId, ownerId);

    jest.restoreAllMocks();
    const ownerToken = authenticatedAs();
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({ architecture: { bom: [] } } as never);
    jest.spyOn(usersService, 'getShareSettings').mockResolvedValue(null);
    const unset = await request(app)
      .post(`/api/v1/sessions/${sessionId}/share-links`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ targetType: 'artifact' });
    expect(unset.status).toBe(409);
    expect(unset.body.error.code).toBe('SHARE_SETTINGS_REQUIRED');
  });

  it('issues a public link using an immutable settings snapshot and exact expiry measured from issuance', async () => {
    const getSession = jest.spyOn(sessionsService, 'getSession').mockResolvedValue({
      architecture: { bom: [] },
    } as never);
    const getSettings = jest.spyOn(usersService, 'getShareSettings').mockResolvedValue({
      visibility: 'public',
      expiration: '24h',
    });

    const create = jest.spyOn(prisma.shareLink, 'create').mockImplementation(async (args) => ({
      id: '44444444-4444-4444-4444-444444444444',
      targetType: args.data.targetType,
      visibility: args.data.visibility,
      expirationPolicy: args.data.expirationPolicy,
      issuedAt: args.data.issuedAt,
      expiresAt: args.data.expiresAt,
    } as never));

    const before = Date.now();
    const result = await sharesService.createLink(sessionId, ownerId, { targetType: 'artifact' }, 'claimed-guest-session');
    const persisted = create.mock.calls[0]![0].data;

    expect(getSession).toHaveBeenCalledWith(sessionId, ownerId, 'claimed-guest-session');
    expect(getSettings).toHaveBeenCalledWith(ownerId);
    expect(persisted).toMatchObject({
      sessionId,
      userId: ownerId,
      targetType: 'artifact',
      visibility: 'public',
      expirationPolicy: '24h',
    });
    expect(persisted.issuedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(persisted.expiresAt!.getTime() - persisted.issuedAt!.getTime()).toBe(24 * 60 * 60 * 1000);
    expect(result.viewerUrl).toMatch(/^http:\/\/localhost:5173\/share\/[a-f0-9]{64}$/);
    expect(JSON.stringify(create.mock.calls)).not.toContain(result.viewerUrl.split('/').pop());
  });

  it('does not infer visibility from an expiry-only preference', async () => {
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({ architecture: { bom: [] } } as never);
    jest.spyOn(usersService, 'getShareSettings').mockResolvedValue({
      visibility: null,
      expiration: '7d',
    });
    const create = jest.spyOn(prisma.shareLink, 'create');

    await expect(sharesService.createLink(sessionId, ownerId, { targetType: 'project' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SHARE_VISIBILITY_REQUIRED' });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not issue private links until an enforceable authorization policy is approved', async () => {
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({ architecture: { bom: [] } } as never);
    jest.spyOn(usersService, 'getShareSettings').mockResolvedValue({
      visibility: 'private',
      expiration: 'never',
    });
    const create = jest.spyOn(prisma.shareLink, 'create');

    await expect(sharesService.createLink(sessionId, ownerId, { targetType: 'project' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PRIVATE_SHARING_UNAVAILABLE' });
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects client-supplied link visibility and expiration policies', async () => {
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
      project: { title: 'Read-only project', architecture: { bom: [] } },
    });
    expect(response.body.data).not.toHaveProperty('edit');
    expect(response.body.data).not.toHaveProperty('share');
  });

  it('supports anonymous read-only viewing for a public Artifact link', async () => {
    jest.spyOn(prisma.shareLink, 'findUnique').mockResolvedValue(viewerRecord({
      targetType: 'artifact',
    }) as never);
    const response = await request(app).get(`/api/v1/share-links/${'b'.repeat(64)}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      targetType: 'artifact',
      artifact: { format: 'json', architecture: { bom: [] } },
    });
    expect(response.body.data).not.toHaveProperty('edit');
    expect(response.body.data).not.toHaveProperty('share');
  });

  it('does not make legacy /workspace project URLs public', async () => {
    const token = authenticatedAs();
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

  it('supports Never links but denies revoked, deleted, private, and legacy ambiguous links', async () => {
    const findLink = jest.spyOn(prisma.shareLink, 'findUnique').mockResolvedValue(viewerRecord() as never);
    await expect(sharesService.getViewer('never-token')).resolves.toMatchObject({ targetType: 'project' });

    for (const invalid of [
      { revokedAt: new Date() },
      { visibility: 'private' },
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
      expirationPolicy: '7d',
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 7 * 24 * 60 * 60 * 1000),
    });
    jest.spyOn(prisma.shareLink, 'findUnique').mockResolvedValue(issuedLink as never);
    jest.spyOn(prisma.user, 'update').mockResolvedValue({
      shareVisibility: 'private',
      shareExpiration: '24h',
    } as never);

    await usersService.updateShareSettings(ownerId, { expiration: '24h' });
    const view = await sharesService.getViewer('snapshot-token');
    expect(issuedLink.expirationPolicy).toBe('7d');
    expect(issuedLink.visibility).toBe('public');
    expect(view.targetType).toBe('project');
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
