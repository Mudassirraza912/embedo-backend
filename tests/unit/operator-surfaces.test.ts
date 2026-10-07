import { describe, it, expect, jest, afterEach } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { env } from '../../src/config/env.js';

/**
 * Regression guards for operator-only surfaces. These would have caught the unauthenticated
 * Bull Board mount and the unguarded admin routes.
 */
describe('Operator surfaces are never public', () => {
  const app = createApp();

  afterEach(() => jest.restoreAllMocks());

  it('rejects anonymous access to the Bull Board dashboard', async () => {
    const res = await request(app).get('/admin/queues/');
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Basic');
  });

  it('rejects a non-admin user JWT on the Bull Board dashboard', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'u1', email: 'u@x.io', role: 'user', suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    const token = jwt.sign({ userId: 'u1', email: 'u@x.io', role: 'user' }, env.JWT_ACCESS_SECRET);
    const res = await request(app).get('/admin/queues/').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  it('rejects anonymous access to admin ingestion routes', async () => {
    const res = await request(app).post('/api/v1/admin/components/ingest').send({ url: 'https://example.com/x.pdf' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-admin user on admin ingestion routes with 403', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'u1', email: 'u@x.io', role: 'user', suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    const token = jwt.sign({ userId: 'u1', email: 'u@x.io', role: 'user' }, env.JWT_ACCESS_SECRET);
    const res = await request(app).get('/api/v1/admin/components').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it('rejects ingestion URLs that are not https', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'a1', email: 'a@x.io', role: 'admin', suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    const token = jwt.sign({ userId: 'a1', email: 'a@x.io', role: 'admin' }, env.JWT_ACCESS_SECRET);
    const res = await request(app)
      .post('/api/v1/admin/components/ingest')
      .set('Authorization', `Bearer ${token}`)
      .send({ url: 'http://169.254.169.254/latest/meta-data' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Export honesty', () => {
  const app = createApp();
  afterEach(() => jest.restoreAllMocks());

  it('reports unimplemented formats as 501 instead of returning JSON under another name', async () => {
    const token = 'a'.repeat(64);
    jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      userId: null,
      anonSessionToken: token,
      status: 'DONE',
      architecture: { projectMeta: { name: 'x', tagline: 'y', controller: 'z' }, bom: [] },
      designGraph: {},
      chatMessages: [],
      userFeedback: [],
      designOutcome: null,
    } as never);

    const res = await request(app)
      .post('/api/v1/sessions/11111111-1111-4111-8111-111111111111/export')
      .set('x-anon-session-token', token)
      .send({ format: 'kicad' });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe('EXPORT_FORMAT_UNSUPPORTED');
  });
});
