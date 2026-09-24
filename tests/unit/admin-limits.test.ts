import { describe, it, expect, jest, afterEach } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { env } from '../../src/config/env.js';
import { DEFAULT_LIMITS, limitsService } from '../../src/modules/limits/limits.service.js';

describe('admin usage limits API', () => {
  const app = createApp();
  afterEach(() => jest.restoreAllMocks());

  const auth = (role: 'admin' | 'user') => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ id: 'a1', email: 'a@x.io', role, suspendedAt: null } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
    return { Authorization: `Bearer ${jwt.sign({ userId: 'a1', email: 'a@x.io', role }, env.JWT_ACCESS_SECRET)}` };
  };
  const plans = { guest: DEFAULT_LIMITS.guest, free: DEFAULT_LIMITS.free, paid: DEFAULT_LIMITS.paid };
  const good = { messagesPerSession: 40, maxInFlightSessions: 5, sessionsPerHour: 30 };

  describe('GET /plans', () => {
    it('returns the three plans with limits, defaults and bounds', async () => {
      const headers = auth('admin');
      jest.spyOn(limitsService, 'plans').mockResolvedValue(plans);
      jest.spyOn(prisma.planLimit, 'findMany').mockResolvedValue([{ plan: 'free', updatedAt: new Date('2026-09-24T10:00:00Z') }] as never);
      const res = await request(app).get('/api/v1/admin/plans').set(headers);
      expect(res.status).toBe(200);
      expect(res.body.plans.map((p: { plan: string }) => p.plan)).toEqual(['guest', 'free', 'paid']);
      expect(res.body.plans[1]).toMatchObject({ limits: DEFAULT_LIMITS.free, defaults: DEFAULT_LIMITS.free });
      expect(res.body.plans[1].updatedAt).toBe('2026-09-24T10:00:00.000Z');
      expect(res.body.bounds.messagesPerSession).toEqual([1, 100000]);
    });
  });

  describe('PUT /plans/:plan', () => {
    it('saves valid limits, records who changed what in the audit log', async () => {
      const headers = auth('admin');
      jest.spyOn(limitsService, 'plans').mockResolvedValue(plans);
      const update = jest.spyOn(limitsService, 'updatePlan').mockResolvedValue(good);
      const audit = jest.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as never);
      const res = await request(app).put('/api/v1/admin/plans/free').set(headers).send(good);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ plan: 'free', limits: good, previous: DEFAULT_LIMITS.free });
      expect(update).toHaveBeenCalledWith('free', good, 'a1');
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'PLAN_LIMITS_UPDATED', actorUserId: 'a1' }) }));
    });

    it.each([
      ['a limit below its minimum', { ...good, messagesPerSession: 0 }],
      ['a limit above its maximum', { ...good, sessionsPerHour: 1_000_000 }],
      ['a non-integer', { ...good, messagesPerSession: 10.5 }],
      ['a missing field', { messagesPerSession: 10 }],
      ['an unknown field', { ...good, extra: 1 }],
      ['a string number', { ...good, messagesPerSession: '10' }],
    ])('rejects %s', async (_label, body) => {
      const headers = auth('admin');
      const update = jest.spyOn(limitsService, 'updatePlan').mockResolvedValue(good);
      const res = await request(app).put('/api/v1/admin/plans/free').set(headers).send(body);
      expect(res.status).toBe(400);
      expect(update).not.toHaveBeenCalled();
    });

    it('rejects an unknown plan name', async () => {
      const headers = auth('admin');
      const res = await request(app).put('/api/v1/admin/plans/gold').set(headers).send(good);
      expect(res.status).toBe(400);
    });

    it('allows 0 for the in-flight cap (meaning no cap)', async () => {
      const headers = auth('admin');
      jest.spyOn(limitsService, 'plans').mockResolvedValue(plans);
      jest.spyOn(limitsService, 'updatePlan').mockResolvedValue({ ...good, maxInFlightSessions: 0 });
      jest.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as never);
      const res = await request(app).put('/api/v1/admin/plans/paid').set(headers).send({ ...good, maxInFlightSessions: 0 });
      expect(res.status).toBe(200);
    });
  });

  describe('PATCH /users/:id/limits', () => {
    const uid = '11111111-1111-4111-8111-111111111111';
    it('sets and clears per-user overrides and audits the change', async () => {
      const headers = auth('admin');
      const upd = jest.spyOn(limitsService, 'updateUserOverrides').mockResolvedValue({ planOverride: 'paid', limitOverrides: { messagesPerSession: 200 } });
      const audit = jest.spyOn(prisma.auditLog, 'create').mockResolvedValue({} as never);
      const res = await request(app).patch(`/api/v1/admin/users/${uid}/limits`).set(headers).send({ planOverride: 'paid', messagesPerSession: 200, sessionsPerHour: null });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ userId: uid, planOverride: 'paid', limitOverrides: { messagesPerSession: 200 } });
      expect(upd).toHaveBeenCalledWith(uid, { planOverride: 'paid', limits: { messagesPerSession: 200, maxInFlightSessions: undefined, sessionsPerHour: null } });
      expect(audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'USER_LIMITS_UPDATED', entityId: uid }) }));
    });

    it('rejects an empty body, an invalid plan, and out-of-range values', async () => {
      const headers = auth('admin');
      jest.spyOn(limitsService, 'updateUserOverrides').mockResolvedValue({ planOverride: null, limitOverrides: {} });
      for (const body of [{}, { planOverride: 'guest' }, { messagesPerSession: 0 }, { sessionsPerHour: 99999999 }, { bogus: 1 }]) {
        const res = await request(app).patch(`/api/v1/admin/users/${uid}/limits`).set(headers).send(body);
        expect(res.status).toBe(400);
      }
    });

    it('rejects a malformed user id and returns 404 for an unknown user', async () => {
      const headers = auth('admin');
      expect((await request(app).patch('/api/v1/admin/users/not-a-uuid/limits').set(headers).send({ messagesPerSession: 5 })).status).toBe(400);
      jest.spyOn(limitsService, 'updateUserOverrides').mockRejectedValue(new Error('USER_NOT_FOUND'));
      expect((await request(app).patch(`/api/v1/admin/users/${uid}/limits`).set(headers).send({ messagesPerSession: 5 })).status).toBe(404);
    });
  });

  describe('GET /usage/summary', () => {
    it('summarizes spend, calls and sessions', async () => {
      const headers = auth('admin');
      jest.spyOn(prisma, '$queryRaw')
        .mockResolvedValueOnce([{ spend24h: 1.23456789, spend7d: 5, spend_total: 12.5, calls24h: 40 }] as never)
        .mockResolvedValueOnce([{ guest24h: 7, registered24h: 3, in_flight: 1 }] as never);
      const res = await request(app).get('/api/v1/admin/usage/summary').set(headers);
      expect(res.status).toBe(200);
      expect(res.body.aiSpendUsd).toEqual({ last24h: 1.2346, last7d: 5, allTime: 12.5 });
      expect(res.body.aiCallsLast24h).toBe(40);
      expect(res.body.sessions).toEqual({ guestLast24h: 7, registeredLast24h: 3, inFlightNow: 1 });
    });
  });

  describe('access control', () => {
    it.each([
      ['get', '/api/v1/admin/plans'],
      ['put', '/api/v1/admin/plans/free'],
      ['get', '/api/v1/admin/usage/summary'],
      ['patch', '/api/v1/admin/users/11111111-1111-4111-8111-111111111111/limits'],
    ] as const)('%s %s rejects anonymous callers', async (method, path) => {
      expect((await request(app)[method](path).send({})).status).toBe(401);
    });

    it('rejects a non-admin user on every limits route', async () => {
      const headers = auth('user');
      expect((await request(app).get('/api/v1/admin/plans').set(headers)).status).toBe(403);
      expect((await request(app).put('/api/v1/admin/plans/free').set(headers).send(good)).status).toBe(403);
      expect((await request(app).patch('/api/v1/admin/users/11111111-1111-4111-8111-111111111111/limits').set(headers).send({ messagesPerSession: 5 })).status).toBe(403);
    });
  });
});
