import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';

describe('Health Check API', () => {
  const app = createApp();
  let querySpy: any;
  let pingSpy: any;

  beforeEach(() => {
    querySpy = jest.spyOn(prisma, '$queryRaw').mockResolvedValue([{ '?column?': 1 }] as never);
    pingSpy = jest.spyOn(redis, 'ping').mockResolvedValue('PONG');
  });

  afterEach(() => {
    querySpy.mockRestore();
    pingSpy.mockRestore();
  });

  it('should return 200 OK with status "ok" and service health when DB and Redis are up', async () => {
    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('status', 'ok');
    expect(response.body.services).toEqual({ database: 'up', redis: 'up' });
    expect(response.body).toHaveProperty('timestamp');
    expect(response.body).toHaveProperty('requestId');
    expect(typeof response.body.requestId).toBe('string');
  });

  it('should return 503 with status "degraded" when database is unreachable', async () => {
    querySpy.mockRejectedValueOnce(new Error('DB unreachable'));

    const response = await request(app).get('/api/v1/health');

    expect(response.status).toBe(503);
    expect(response.body).toHaveProperty('status', 'degraded');
    expect(response.body.services).toEqual({ database: 'down', redis: 'up' });
  });

  it('should return 404 for unknown endpoints with the standard error envelope', async () => {
    const response = await request(app).get('/api/v1/unknown-endpoint');

    expect(response.status).toBe(404);
    expect(response.body).toHaveProperty('error');
    expect(response.body.error).toHaveProperty('code', 'NOT_FOUND');
    expect(response.body.error).toHaveProperty('requestId');
  });

  it('should serve OpenAPI JSON specification at /docs/openapi.json', async () => {
    const response = await request(app).get('/docs/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('openapi', '3.0.3');
    expect(response.body.info).toHaveProperty('title', 'Embedo.ai Backend API');
    expect(response.body.paths).toHaveProperty('/sessions');
    expect(response.body.paths).toHaveProperty('/sessions/{id}/architecture');
  });
});
