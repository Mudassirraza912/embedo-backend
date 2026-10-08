import { describe, it, expect, jest, afterEach } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { env } from '../../src/config/env.js';
import { modelProviderService } from '../../src/modules/ai/model-provider.service.js';

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

  it('requires admin authentication for uploaded JSON ingestion', async () => {
    const res = await request(app)
      .post('/api/v1/admin/components/ingest/json')
      .send({ filename: 'parts.json', content: [{ partNumber: 'INA219' }] });
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

  it('rejects non-JSON filenames before indexing', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'a1', email: 'a@x.io', role: 'admin', suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    const token = jwt.sign({ userId: 'a1', email: 'a@x.io', role: 'admin' }, env.JWT_ACCESS_SECRET);
    const res = await request(app)
      .post('/api/v1/admin/components/ingest/json')
      .set('Authorization', 'Bearer ' + token)
      .send({ filename: 'parts.txt', content: { partNumber: 'INA219' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('embeds and stores an uploaded JSON document for retrieval', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'a1', email: 'a@x.io', role: 'admin', suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    jest.spyOn(modelProviderService, 'embedBatch').mockResolvedValue({ embeddings: [Array(1536).fill(0.1)], totalTokens: 8, latencyMs: 12 });
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const executeRaw = jest.fn().mockResolvedValue(1);
    const tx = { knowledgeChunk: { deleteMany }, $executeRaw: executeRaw };
    jest.spyOn(prisma, '$transaction').mockImplementation((async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)) as never);
    const token = jwt.sign({ userId: 'a1', email: 'a@x.io', role: 'admin' }, env.JWT_ACCESS_SECRET);

    const res = await request(app)
      .post('/api/v1/admin/components/ingest/json')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'parts.json', content: [{ partNumber: 'INA219', summary: 'Current sensor' }] });

    expect(res.status).toBe(200);
    expect(res.body.chunksIngested).toBe(1);
    expect(modelProviderService.embedBatch).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('ingests JSON documents producing more than 100 complete-record chunks in bounded database batches', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'a1', email: 'a@x.io', role: 'admin', suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    jest.spyOn(modelProviderService, 'embedBatch').mockImplementation(async (texts) => ({
      embeddings: texts.map(() => Array(1536).fill(0.1)),
      totalTokens: texts.length,
      latencyMs: 12,
    }));
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const executeRaw = jest.fn().mockResolvedValue(1);
    const tx = { knowledgeChunk: { deleteMany }, $executeRaw: executeRaw };
    jest.spyOn(prisma, '$transaction').mockImplementation((async (callback: (tx: typeof tx) => Promise<unknown>) => callback(tx)) as never);
    const token = jwt.sign({ userId: 'a1', email: 'a@x.io', role: 'admin' }, env.JWT_ACCESS_SECRET);
    const content = {
      components: Array.from({ length: 400 }, (_, index) => ({
        partNumber: `PART-${index}`,
        description: 'hardware reference '.repeat(160),
      })),
    };

    const res = await request(app)
      .post('/api/v1/admin/components/ingest/json')
      .auth(token, { type: 'bearer' })
      .send({ filename: 'large-parts.json', content });

    expect(res.status).toBe(200);
    expect(res.body.chunksIngested).toBeGreaterThan(100);
    expect(modelProviderService.embedBatch).toHaveBeenCalledTimes(1);
    const embeddedChunks = (modelProviderService.embedBatch as jest.Mock).mock.calls[0]?.[0] as string[];
    expect(embeddedChunks).toHaveLength(res.body.chunksIngested);
    for (const chunk of embeddedChunks) {
      expect(chunk).toContain('Record: components[');
      expect(chunk).toContain('"partNumber":"PART-');
    }
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(Math.ceil(res.body.chunksIngested / 100));
  });

  it('returns uploaded JSON knowledge documents separately from datasheet components', async () => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'a1', email: 'a@x.io', role: 'admin', suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    jest.spyOn(prisma.component, 'findMany').mockResolvedValue([] as never);
    jest.spyOn(prisma.auditLog, 'findMany').mockResolvedValue([] as never);
    jest.spyOn(prisma.knowledgeChunk, 'groupBy').mockResolvedValue([
      {
        sourceUrl: 'upload://json/abc',
        title: 'parts.json',
        _count: { _all: 62 },
        _max: { createdAt: new Date('2026-10-07T10:00:00.000Z') },
      },
    ] as never);
    const token = jwt.sign({ userId: 'a1', email: 'a@x.io', role: 'admin' }, env.JWT_ACCESS_SECRET);

    const res = await request(app)
      .get('/api/v1/admin/components')
      .set('Authorization', 'Bearer ' + token);

    expect(res.status).toBe(200);
    expect(res.body.uploadedJsonDocuments).toEqual([
      {
        sourceUrl: 'upload://json/abc',
        filename: 'parts.json',
        totalChunks: 62,
        lastIndexedAt: '2026-10-07T10:00:00.000Z',
      },
    ]);
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
