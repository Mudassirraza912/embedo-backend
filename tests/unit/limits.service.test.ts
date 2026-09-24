import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import {
  DEFAULT_LIMITS,
  LimitsService,
  applyOverrides,
  computeEffective,
  derivePlan,
  sanitizeOverrides,
} from '../../src/modules/limits/limits.service.js';

describe('sanitizeOverrides / applyOverrides', () => {
  it('keeps valid integers in bounds and drops everything else', () => {
    expect(sanitizeOverrides({ messagesPerSession: 50, sessionsPerHour: 0, maxInFlightSessions: 2.5, junk: 1 })).toEqual({ messagesPerSession: 50 });
  });
  it('rejects out-of-range and non-numeric values so a typo cannot disable a cap', () => {
    expect(sanitizeOverrides({ messagesPerSession: 0 })).toEqual({});
    expect(sanitizeOverrides({ messagesPerSession: 10_000_000 })).toEqual({});
    expect(sanitizeOverrides({ sessionsPerHour: '5' })).toEqual({});
    expect(sanitizeOverrides(null)).toEqual({});
    expect(sanitizeOverrides([1, 2])).toEqual({});
  });
  it('allows 0 only where 0 means "no cap"', () => {
    expect(sanitizeOverrides({ maxInFlightSessions: 0 })).toEqual({ maxInFlightSessions: 0 });
  });
  it('overlays overrides on the plan base without mutating it', () => {
    const base = { ...DEFAULT_LIMITS.free };
    expect(applyOverrides(base, { messagesPerSession: 99 })).toEqual({ ...base, messagesPerSession: 99 });
    expect(base.messagesPerSession).toBe(20);
  });
});

describe('derivePlan', () => {
  it('an admin override wins over subscriptions', () => {
    expect(derivePlan({ planOverride: 'paid', activeSubscriptions: 0 })).toBe('paid');
    expect(derivePlan({ planOverride: 'free', activeSubscriptions: 3 })).toBe('free');
  });
  it('otherwise an active subscription means paid, none means free', () => {
    expect(derivePlan({ planOverride: null, activeSubscriptions: 1 })).toBe('paid');
    expect(derivePlan({ planOverride: null, activeSubscriptions: 0 })).toBe('free');
  });
  it('ignores an unrecognised override (e.g. "guest" cannot be assigned to a registered user)', () => {
    expect(derivePlan({ planOverride: 'guest', activeSubscriptions: 0 })).toBe('free');
  });
});

describe('computeEffective', () => {
  const plans = { guest: DEFAULT_LIMITS.guest, free: { messagesPerSession: 40, maxInFlightSessions: 5, sessionsPerHour: 20 }, paid: DEFAULT_LIMITS.paid };
  it('uses the (admin-edited) plan limits, then the per-user override on top', () => {
    const e = computeEffective(plans, { activeSubscriptions: 0, limitOverrides: { messagesPerSession: 100 } });
    expect(e.plan).toBe('free');
    expect(e.limits).toEqual({ messagesPerSession: 100, maxInFlightSessions: 5, sessionsPerHour: 20 });
    expect(e.overrides).toEqual({ messagesPerSession: 100 });
  });
});

describe('LimitsService', () => {
  afterEach(() => jest.restoreAllMocks());

  const row = (plan: string, m: number, f: number, h: number) => ({ plan, messagesPerSession: m, maxInFlightSessions: f, sessionsPerHour: h, updatedBy: null, updatedAt: new Date() });

  it('reads the DB, merges onto defaults, and caches', async () => {
    const svc = new LimitsService();
    const find = jest.spyOn(prisma.planLimit, 'findMany').mockResolvedValue([row('free', 45, 7, 30)] as never);
    const a = await svc.plans();
    const b = await svc.plans();
    expect(a.free).toEqual({ messagesPerSession: 45, maxInFlightSessions: 7, sessionsPerHour: 30 });
    expect(a.paid).toEqual(DEFAULT_LIMITS.paid);
    expect(b).toBe(a);
    expect(find).toHaveBeenCalledTimes(1);
    svc.invalidate();
    await svc.plans();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('falls back per key to the default when a stored value is out of range', async () => {
    const svc = new LimitsService();
    jest.spyOn(prisma.planLimit, 'findMany').mockResolvedValue([row('guest', -5, 0, 9)] as never);
    const p = await svc.plans();
    expect(p.guest.messagesPerSession).toBe(DEFAULT_LIMITS.guest.messagesPerSession);
    expect(p.guest.sessionsPerHour).toBe(9);
  });

  it('enforces the built-in defaults (never "unlimited") when the table cannot be read', async () => {
    const svc = new LimitsService();
    jest.spyOn(prisma.planLimit, 'findMany').mockRejectedValue(new Error('db down') as never);
    const p = await svc.plans();
    expect(p).toEqual(DEFAULT_LIMITS);
  });

  it('forUser combines subscription state, plan limits and the user override', async () => {
    const svc = new LimitsService();
    jest.spyOn(prisma.planLimit, 'findMany').mockResolvedValue([] as never);
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ planOverride: null, limitOverrides: { sessionsPerHour: 60 }, _count: { subscriptions: 1 } } as never);
    const e = await svc.forUser('u1');
    expect(e.plan).toBe('paid');
    expect(e.limits).toEqual({ ...DEFAULT_LIMITS.paid, sessionsPerHour: 60 });
  });

  it('updatePlan persists clamped values and invalidates the cache so the change applies at once', async () => {
    const svc = new LimitsService();
    const find = jest.spyOn(prisma.planLimit, 'findMany').mockResolvedValue([] as never);
    const upsert = jest.spyOn(prisma.planLimit, 'upsert').mockResolvedValue({} as never);
    await svc.plans();
    const saved = await svc.updatePlan('free', { messagesPerSession: 60, maxInFlightSessions: 4, sessionsPerHour: 25 }, 'admin-1');
    expect(saved).toEqual({ messagesPerSession: 60, maxInFlightSessions: 4, sessionsPerHour: 25 });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { plan: 'free' }, update: expect.objectContaining({ updatedBy: 'admin-1' }) }));
    await svc.plans();
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('updateUserOverrides sets numbers, clears on null, and leaves untouched keys alone', async () => {
    const svc = new LimitsService();
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ planOverride: 'paid', limitOverrides: { messagesPerSession: 80, sessionsPerHour: 40 } } as never);
    const update = jest.spyOn(prisma.user, 'update').mockResolvedValue({} as never);
    const r = await svc.updateUserOverrides('u1', { limits: { messagesPerSession: null, maxInFlightSessions: 9 } });
    expect(r.limitOverrides).toEqual({ sessionsPerHour: 40, maxInFlightSessions: 9 });
    expect(r.planOverride).toBe('paid');
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('updateUserOverrides can clear the plan override', async () => {
    const svc = new LimitsService();
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({ planOverride: 'paid', limitOverrides: null } as never);
    jest.spyOn(prisma.user, 'update').mockResolvedValue({} as never);
    expect((await svc.updateUserOverrides('u1', { planOverride: null })).planOverride).toBeNull();
  });
});
