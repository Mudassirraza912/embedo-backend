import { describe, it, expect, jest, afterEach } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { Prisma } from '@prisma/client';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { env } from '../../src/config/env.js';
import { MAX_ENTRIES, normaliseNetwork } from '../../src/modules/admin-portal-access/admin-portal-access.service.js';

describe('admin portal access (trusted IP allowlist)', () => {
  const app = createApp();
  afterEach(() => jest.restoreAllMocks());

  const auth = (role: 'admin' | 'user') => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'a1', email: 'a@x.io', role, suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    return { Authorization: `Bearer ${jwt.sign({ userId: 'a1', email: 'a@x.io', role }, env.JWT_ACCESS_SECRET)}` };
  };

  /** Postgres normalises; here $queryRaw returns what network()/family()/masklen() would. */
  const pg = (cidr: string, family: 4 | 6, len: number) => jest.spyOn(prisma, '$queryRaw').mockResolvedValue([{ cidr, family, len }] as never);

  /** Runs the transaction callback against the same mocked client. */
  const tx = () => jest.spyOn(prisma, '$transaction').mockImplementation(((fn: (t: typeof prisma) => unknown) => fn(prisma)) as never);

  const row = (over: Record<string, unknown> = {}) => ({
    id: '6f1c2b1e-0000-4000-8000-000000000001',
    cidr: '203.0.113.7/32',
    label: 'Office',
    enabled: true,
    expiresAt: null,
    createdBy: 'a1',
    updatedBy: 'a1',
    createdAt: new Date('2026-10-22T10:00:00Z'),
    updatedAt: new Date('2026-10-22T10:00:00Z'),
    ...over,
  });

  it('is admin-only', async () => {
    expect((await request(app).get('/api/v1/admin/portal-access')).status).toBe(401);
    expect((await request(app).get('/api/v1/admin/portal-access').set(auth('user'))).status).toBe(403);
  });

  it('lists entries with the caller IP and marks expired ones inactive', async () => {
    const headers = auth('admin');
    jest.spyOn(prisma.adminPortalAllowedIp, 'findMany').mockResolvedValue([row(), row({ id: 'x2', cidr: '198.51.100.0/24', expiresAt: new Date('2020-01-01T00:00:00Z') })] as never);
    const res = await request(app).get('/api/v1/admin/portal-access').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { active: boolean }) => e.active)).toEqual([true, false]);
    expect(res.body).toHaveProperty('yourIp');
    expect(res.body.maxEntries).toBe(MAX_ENTRIES);
  });

  it('adds a normalised network and writes the audit log in the same transaction', async () => {
    const headers = auth('admin');
    pg('203.0.113.0/24', 4, 24);
    tx();
    jest.spyOn(prisma.adminPortalAllowedIp, 'count').mockResolvedValue(0);
    const create = jest.spyOn(prisma.adminPortalAllowedIp, 'create').mockResolvedValue(row({ cidr: '203.0.113.0/24' }) as never);
    const audit = jest.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as never);
    const res = await request(app).post('/api/v1/admin/portal-access').set(headers).send({ cidr: '203.0.113.9/24', label: 'Office' });
    expect(res.status).toBe(201);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ cidr: '203.0.113.0/24', createdBy: 'a1' }) }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'ADMIN_PORTAL_IP_ADDED', actorUserId: 'a1' }) }));
  });

  it.each([
    ['a too broad IPv4 range', '10.0.0.0/8', 4, 8],
    ['the whole internet', '0.0.0.0/0', 4, 0],
    ['a too broad IPv6 range', '2001::/16', 6, 16],
  ])('refuses %s', async (_label, cidr, family, len) => {
    pg(cidr, family as 4 | 6, len);
    await expect(normaliseNetwork(cidr)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses IPv4-mapped IPv6 (Nginx would never match it)', async () => {
    pg('::ffff:203.0.113.7/128', 6, 128);
    await expect(normaliseNetwork('::ffff:203.0.113.7')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses something that is not an address', async () => {
    jest.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('invalid input syntax for type inet'));
    await expect(normaliseNetwork('not-an-ip')).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a duplicate and a full list', async () => {
    const headers = auth('admin');
    pg('203.0.113.7/32', 4, 32);
    tx();
    jest.spyOn(prisma.adminPortalAllowedIp, 'count').mockResolvedValue(0);
    jest.spyOn(prisma.adminPortalAllowedIp, 'create').mockRejectedValue(new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' }));
    expect((await request(app).post('/api/v1/admin/portal-access').set(headers).send({ cidr: '203.0.113.7', label: 'Office' })).status).toBe(409);

    jest.spyOn(prisma.adminPortalAllowedIp, 'count').mockResolvedValue(MAX_ENTRIES);
    expect((await request(app).post('/api/v1/admin/portal-access').set(headers).send({ cidr: '203.0.113.7', label: 'Office' })).status).toBe(409);
  });

  it('validates the body', async () => {
    const headers = auth('admin');
    for (const body of [{ cidr: '203.0.113.7' }, { cidr: '203.0.113.7', label: 'x' }, { cidr: '203.0.113.7', label: 'Office', extra: 1 }, { cidr: '203.0.113.7', label: 'Office', expiresAt: '2020-01-01T00:00:00Z' }]) {
      expect((await request(app).post('/api/v1/admin/portal-access').set(headers).send(body)).status).toBe(400);
    }
    expect((await request(app).patch('/api/v1/admin/portal-access/6f1c2b1e-0000-4000-8000-000000000001').set(headers).send({})).status).toBe(400);
  });

  it('disables and removes with audit entries', async () => {
    const headers = auth('admin');
    tx();
    jest.spyOn(prisma.adminPortalAllowedIp, 'findUnique').mockResolvedValue(row() as never);
    jest.spyOn(prisma.adminPortalAllowedIp, 'update').mockResolvedValue(row({ enabled: false }) as never);
    jest.spyOn(prisma.adminPortalAllowedIp, 'delete').mockResolvedValue(row() as never);
    const audit = jest.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as never);
    const off = await request(app).patch(`/api/v1/admin/portal-access/${row().id}`).set(headers).send({ enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.entry.active).toBe(false);
    expect((await request(app).delete(`/api/v1/admin/portal-access/${row().id}`).set(headers)).status).toBe(200);
    expect(audit.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action)).toEqual(['ADMIN_PORTAL_IP_UPDATED', 'ADMIN_PORTAL_IP_REMOVED']);
  });
});
