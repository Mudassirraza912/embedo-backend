import { describe, it, expect, jest, afterEach } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { env } from '../../src/config/env.js';

describe('GET /api/v1/admin/components/:partNumber/revisions', () => {
  const app = createApp();
  afterEach(() => jest.restoreAllMocks());

  const asAdmin = () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'a1', email: 'a@x.io', role: 'admin', suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    return jwt.sign({ userId: 'a1', email: 'a@x.io', role: 'admin' }, env.JWT_ACCESS_SECRET);
  };

  const row = {
    id: 'r1',
    createdAt: new Date('2026-09-24T10:00:00Z'),
    action: 'COMPONENT_REVISION_ARCHIVED',
    metadata: {
      partNumber: 'ADS1115',
      chronologyKnown: true,
      archivedRevision: { label: 'Rev. D' },
      replacedByRevision: { label: 'Rev. E' },
      differences: [{ field: 'absoluteMaxRatings', previous: '{}', current: '{}' }],
      archivedSpecsSnapshot: { core: '16-bit ADC' },
    },
  };

  it('returns history newest-first without the large snapshot by default', async () => {
    const token = asAdmin();
    jest.spyOn(prisma.component, 'findUnique').mockResolvedValue({ id: 'c1', partNumber: 'ADS1115', specs: { _revision: { label: 'Rev. E' } } } as never);
    const findMany = jest.spyOn(prisma.auditLog, 'findMany').mockResolvedValue([row] as never);
    const res = await request(app).get('/api/v1/admin/components/ADS1115/revisions').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.current).toEqual({ label: 'Rev. E' });
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0]).toMatchObject({ action: 'COMPONENT_REVISION_ARCHIVED', chronologyKnown: true });
    expect(res.body.history[0].archivedSpecsSnapshot).toBeUndefined();
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { createdAt: 'desc' } }));
  });

  it('includes the snapshot only when asked', async () => {
    const token = asAdmin();
    jest.spyOn(prisma.component, 'findUnique').mockResolvedValue({ id: 'c1', partNumber: 'ADS1115', specs: null } as never);
    jest.spyOn(prisma.auditLog, 'findMany').mockResolvedValue([row] as never);
    const res = await request(app).get('/api/v1/admin/components/ADS1115/revisions?includeSnapshot=true').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.history[0].archivedSpecsSnapshot).toEqual({ core: '16-bit ADC' });
    expect(res.body.current).toBeNull();
  });

  it('returns 404 for an unknown component', async () => {
    const token = asAdmin();
    jest.spyOn(prisma.component, 'findUnique').mockResolvedValue(null as never);
    const res = await request(app).get('/api/v1/admin/components/NOPE/revisions').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it('rejects anonymous callers', async () => {
    const res = await request(app).get('/api/v1/admin/components/ADS1115/revisions');
    expect(res.status).toBe(401);
  });

  it('rejects non-admin users', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'u1', email: 'u@x.io', role: 'user', suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    const token = jwt.sign({ userId: 'u1', email: 'u@x.io', role: 'user' }, env.JWT_ACCESS_SECRET);
    const res = await request(app).get('/api/v1/admin/components/ADS1115/revisions').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });
});
