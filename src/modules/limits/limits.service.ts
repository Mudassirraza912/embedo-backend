import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';

/**
 * Usage limits per plan, editable from the admin panel (table plan_limits) with optional per-user
 * overrides (users.limit_overrides / users.plan_override). Enforcement points read from here instead of
 * hard-coded constants, so changing a limit never needs a deploy.
 */
export const PLAN_NAMES = ['guest', 'free', 'paid'] as const;
export type PlanName = (typeof PLAN_NAMES)[number];

export interface Limits {
  /** User messages allowed in one project/session. */
  messagesPerSession: number;
  /** Architectures generating at once. 0 = no cap. */
  maxInFlightSessions: number;
  /** New sessions per hour (per user; per IP for guests). */
  sessionsPerHour: number;
}
export type LimitOverrides = Partial<Limits>;

/** The values that were hard-coded before this became editable; also the fallback if the DB read fails. */
export const DEFAULT_LIMITS: Record<PlanName, Limits> = {
  guest: { messagesPerSession: 6, maxInFlightSessions: 0, sessionsPerHour: 5 },
  free: { messagesPerSession: 20, maxInFlightSessions: 3, sessionsPerHour: 20 },
  paid: { messagesPerSession: 500, maxInFlightSessions: 0, sessionsPerHour: 20 },
};

/** Inclusive bounds. They keep a typo (or a compromised admin session) from disabling a cost guard entirely. */
export const LIMIT_BOUNDS: Record<keyof Limits, readonly [number, number]> = {
  messagesPerSession: [1, 100_000],
  maxInFlightSessions: [0, 1_000],
  sessionsPerHour: [1, 100_000],
};
export const LIMIT_KEYS = Object.keys(LIMIT_BOUNDS) as Array<keyof Limits>;

export const isPlanName = (v: unknown): v is PlanName => typeof v === 'string' && (PLAN_NAMES as readonly string[]).includes(v);

const validValue = (key: keyof Limits, v: unknown): v is number => {
  const [min, max] = LIMIT_BOUNDS[key];
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
};

/** Keeps only the recognised keys whose values are integers within bounds; everything else is dropped. */
export function sanitizeOverrides(input: unknown): LimitOverrides {
  const out: LimitOverrides = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of LIMIT_KEYS) {
    const v = (input as Record<string, unknown>)[key];
    if (validValue(key, v)) out[key] = v;
  }
  return out;
}

export function applyOverrides(base: Limits, overrides: unknown): Limits {
  return { ...base, ...sanitizeOverrides(overrides) };
}

/** Which registered plan applies: an admin override wins, otherwise an active subscription means paid. */
export function derivePlan(user: { planOverride?: string | null; activeSubscriptions: number }): Exclude<PlanName, 'guest'> {
  if (user.planOverride === 'free' || user.planOverride === 'paid') return user.planOverride;
  return user.activeSubscriptions > 0 ? 'paid' : 'free';
}

export interface EffectiveLimits {
  plan: PlanName;
  limits: Limits;
  /** The per-user overrides actually in force (after validation). */
  overrides: LimitOverrides;
}

export function computeEffective(
  plans: Record<PlanName, Limits>,
  user: { planOverride?: string | null; limitOverrides?: unknown; activeSubscriptions: number }
): EffectiveLimits {
  const plan = derivePlan(user);
  const overrides = sanitizeOverrides(user.limitOverrides);
  return { plan, limits: applyOverrides(plans[plan], overrides), overrides };
}

const CACHE_TTL_MS = 15_000;

export class LimitsService {
  private cache: { at: number; plans: Record<PlanName, Limits> } | null = null;

  invalidate(): void {
    this.cache = null;
  }

  /** All three plans. Rows with missing or out-of-range values fall back per key to the defaults. */
  async plans(): Promise<Record<PlanName, Limits>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_TTL_MS) return this.cache.plans;
    const plans: Record<PlanName, Limits> = {
      guest: { ...DEFAULT_LIMITS.guest },
      free: { ...DEFAULT_LIMITS.free },
      paid: { ...DEFAULT_LIMITS.paid },
    };
    try {
      const rows = await prisma.planLimit.findMany();
      for (const row of rows) {
        if (isPlanName(row.plan)) plans[row.plan] = applyOverrides(DEFAULT_LIMITS[row.plan], row);
      }
    } catch (err) {
      // A limits-table problem must never take generation down or, worse, silently lift every cap.
      logger.warn({ err }, 'Could not read plan_limits; enforcing built-in defaults');
      this.cache = { at: Date.now() - CACHE_TTL_MS + 5_000, plans }; // retry in ~5s
      return plans;
    }
    this.cache = { at: Date.now(), plans };
    return plans;
  }

  async forGuest(): Promise<EffectiveLimits> {
    const plans = await this.plans();
    return { plan: 'guest', limits: plans.guest, overrides: {} };
  }

  async forUser(userId: string): Promise<EffectiveLimits> {
    const [plans, user] = await Promise.all([
      this.plans(),
      prisma.user.findFirst({
        where: { id: userId, deletedAt: null },
        select: { planOverride: true, limitOverrides: true, _count: { select: { subscriptions: { where: { status: 'active' } } } } },
      }),
    ]);
    return computeEffective(plans, {
      planOverride: user?.planOverride,
      limitOverrides: user?.limitOverrides,
      activeSubscriptions: user?._count.subscriptions ?? 0,
    });
  }

  async updatePlan(plan: PlanName, limits: Limits, adminId?: string): Promise<Limits> {
    const clean = applyOverrides(DEFAULT_LIMITS[plan], limits);
    await prisma.planLimit.upsert({
      where: { plan },
      create: { plan, ...clean, updatedBy: adminId ?? null },
      update: { ...clean, updatedBy: adminId ?? null },
    });
    this.invalidate();
    return clean;
  }

  /** Merges a per-user patch: a number sets an override, null removes it (inherit the plan). */
  async updateUserOverrides(
    userId: string,
    patch: { planOverride?: 'free' | 'paid' | null; limits?: Partial<Record<keyof Limits, number | null>> }
  ): Promise<{ planOverride: string | null; limitOverrides: LimitOverrides }> {
    const existing = await prisma.user.findFirst({ where: { id: userId, deletedAt: null }, select: { planOverride: true, limitOverrides: true } });
    if (!existing) throw new Error('USER_NOT_FOUND');
    const merged: LimitOverrides = sanitizeOverrides(existing.limitOverrides);
    for (const key of LIMIT_KEYS) {
      const v = patch.limits?.[key];
      if (v === null) delete merged[key];
      else if (v !== undefined && validValue(key, v)) merged[key] = v;
    }
    const planOverride = patch.planOverride === undefined ? existing.planOverride : patch.planOverride;
    await prisma.user.update({
      where: { id: userId },
      data: {
        planOverride,
        limitOverrides: Object.keys(merged).length > 0 ? (merged as Prisma.InputJsonValue) : Prisma.JsonNull,
      },
    });
    return { planOverride, limitOverrides: merged };
  }
}

export const limitsService = new LimitsService();
