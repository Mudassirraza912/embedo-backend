import { describe, it, expect, jest, afterEach } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { env } from '../../src/config/env.js';
import { modelProviderService } from '../../src/modules/ai/model-provider.service.js';
import { hardwareEmbeddingService } from '../../src/modules/hardware/hardware-embedding.service.js';
import { retrieveCatalogue } from '../../src/modules/sessions/prototype/prototype-resolver.js';
import { FIXTURE_IDS, fixtureUpload, loadFixtureEntity } from './prototype-fixtures.js';

describe('admin hardware library API (database + embeddings, no files)', () => {
  const app = createApp();
  afterEach(() => jest.restoreAllMocks());

  const auth = (role: 'admin' | 'user') => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'a1', email: 'a@x.io', role, suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    return { Authorization: `Bearer ${jwt.sign({ userId: 'a1', email: 'a@x.io', role }, env.JWT_ACCESS_SECRET)}` };
  };

  it('requires an admin', async () => {
    expect((await request(app).post('/api/v1/admin/hardware').send(fixtureUpload(FIXTURE_IDS.gps))).status).toBe(401);
    const res = await request(app).post('/api/v1/admin/hardware').set(auth('user')).send(fixtureUpload(FIXTURE_IDS.gps));
    expect(res.status).toBe(403);
  });

  it('validates an upload without saving it', async () => {
    const headers = auth('admin');
    const create = jest.spyOn(prisma.hardwareEntity, 'create');
    const res = await request(app).post('/api/v1/admin/hardware/validate').set(headers).send(fixtureUpload(FIXTURE_IDS.bme280));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ valid: true, hardwareEntityId: 'HW-FX03' });
    expect(create).not.toHaveBeenCalled();
  });

  it('stores a new board in the database, audits it and embeds it', async () => {
    const headers = auth('admin');
    jest.spyOn(prisma.hardwareEntity, 'findUnique')
      .mockResolvedValueOnce(null as never) // save(): does it exist?
      .mockResolvedValueOnce({ metadataJson: fixtureUpload(FIXTURE_IDS.gps).record, embeddingInputHash: null, embeddedAt: null } as never); // embedEntity()
    const tx = jest.spyOn(prisma, '$transaction').mockResolvedValue(undefined as never);
    const auditLog = jest.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as never);
    Object.defineProperty(modelProviderService, 'embeddingsConfigured', { get: () => true, configurable: true });
    const embed = jest.spyOn(modelProviderService, 'embedBatch').mockResolvedValue({ embeddings: [new Array(1536).fill(0.01)], totalTokens: 50, latencyMs: 5 });
    const write = jest.spyOn(prisma, '$executeRaw').mockResolvedValue(1 as never);

    const res = await request(app).post('/api/v1/admin/hardware').set(headers).send(fixtureUpload(FIXTURE_IDS.gps));

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ hardwareEntityId: 'HW-FX04', outcome: 'created', embedding: 'embedded' });
    expect(tx).toHaveBeenCalledTimes(1);
    expect(auditLog.mock.calls[0]![0].data).toMatchObject({ action: 'HARDWARE_CREATED', entityType: 'HardwareEntity' });
    expect(embed.mock.calls[0]![0][0]).toContain('Adafruit Ultimate GPS Breakout v3');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('refuses to create a board that already exists, and an invalid record', async () => {
    const headers = auth('admin');
    jest.spyOn(prisma.hardwareEntity, 'findUnique').mockResolvedValue({ contentHash: 'sha256:old', scope: 'shared_library' } as never);
    const dupe = await request(app).post('/api/v1/admin/hardware').set(headers).send(fixtureUpload(FIXTURE_IDS.gps));
    expect(dupe.status).toBe(409);

    const upload = fixtureUpload(FIXTURE_IDS.gps);
    const bad = await request(app)
      .post('/api/v1/admin/hardware')
      .set(headers)
      .send({ ...upload, svg: upload.svg.replace('<svg', '<svg onload="alert(1)"') });
    expect(bad.status).toBe(422);
    expect(JSON.stringify(bad.body.error.details.issues)).toContain('event handler');
  });

  it('does not re-embed a record whose facts did not change', async () => {
    const record = fixtureUpload(FIXTURE_IDS.bme280).record;
    jest.spyOn(prisma.hardwareEntity, 'findUnique').mockResolvedValueOnce({ metadataJson: record, embeddingInputHash: null, embeddedAt: null } as never);
    Object.defineProperty(modelProviderService, 'embeddingsConfigured', { get: () => true, configurable: true });
    jest.spyOn(modelProviderService, 'embedBatch').mockResolvedValue({ embeddings: [new Array(1536).fill(0.02)], totalTokens: 50, latencyMs: 5 });
    const write = jest.spyOn(prisma, '$executeRaw').mockResolvedValue(1 as never);
    expect((await hardwareEmbeddingService.embedEntity('HW-FX03')).outcome).toBe('embedded');
    const storedHash = (write.mock.calls[0] as unknown[]).find((v) => typeof v === 'string' && v.startsWith('sha256:')) as string;

    jest.spyOn(prisma.hardwareEntity, 'findUnique').mockResolvedValueOnce({ metadataJson: record, embeddingInputHash: storedHash, embeddedAt: new Date() } as never);
    expect((await hardwareEmbeddingService.embedEntity('HW-FX03')).outcome).toBe('unchanged');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('shortlists a large library by vector similarity, always keeping controllers', async () => {
    const base = await loadFixtureEntity(FIXTURE_IDS.bme280);
    const controller = await loadFixtureEntity(FIXTURE_IDS.pico);
    const many = Array.from({ length: 120 }, (_, i) => ({ ...base, hardwareEntityId: `HW-T${String(i).padStart(3, '0')}` }));
    const rank = jest.spyOn(hardwareEmbeddingService, 'rank').mockResolvedValue(['HW-T117', 'HW-T003']);
    const catalogue = await retrieveCatalogue([controller, ...many], 'humidity sensor');
    expect(rank).toHaveBeenCalled();
    expect(catalogue[0]!.hardwareEntityId).toBe('HW-FX01');
    expect(catalogue.slice(1, 3).map((e) => e.hardwareEntityId)).toEqual(['HW-T117', 'HW-T003']);
    expect(catalogue.length).toBeLessThanOrEqual(80);
  });
});
