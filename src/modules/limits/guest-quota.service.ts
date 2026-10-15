import { redis } from '../../db/redis.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/AppError.js';
import { limitsService } from './limits.service.js';

/**
 * Guest message allowance per IP over a rolling 24-hour window that starts at the first message.
 *
 * The plan's guest limit used to be counted per session only, so every new tab — a new session —
 * started again from zero. Counting by IP across all of a guest's projects makes the limit real,
 * and the window's end is a concrete time the UI can show ("try again after 3:45 PM").
 */
const WINDOW_SECONDS = 24 * 60 * 60;
const quotaKey = (ip: string) => `quota:guest:messages:${ip}`;

export interface GuestQuotaStatus {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string | null;
  unit: 'credits';
}

async function status(ip: string): Promise<GuestQuotaStatus> {
  const { limits } = await limitsService.forGuest();
  const [count, ttl] = await Promise.all([redis.get(quotaKey(ip)), redis.ttl(quotaKey(ip))]);
  const used = Number(count ?? 0);
  const limit = limits.messagesPerSession;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null,
    unit: 'credits',
  };
}

export const guestQuotaService = {
  status,

  /** Throws GUEST_QUOTA_EXCEEDED (with the reset time and credits details) once this IP has used its allowance. */
  async assertAvailable(ip: string | undefined): Promise<void> {
    if (!ip) return;
    let current: GuestQuotaStatus;
    try {
      current = await status(ip);
    } catch (err) {
      // Redis being down must not lock guests out entirely; the per-session cap still applies.
      logger.warn({ err }, 'Guest quota unavailable — skipping the per-IP check');
      return;
    }
    if (current.used >= current.limit) {
      throw new AppError(
        403,
        'GUEST_QUOTA_EXCEEDED',
        `You've used all your guest credits for today. Sign in (it's free) to keep going with your account allowance, or come back after the credits reset.`,
        { limit: current.limit, used: current.used, remaining: 0, resetAt: current.resetAt, unit: 'credits' }
      );
    }
  },

  /** Records guest operation credits; the first one in a window starts the 24-hour clock. */
  async consume(ip: string | undefined, amount = 1): Promise<void> {
    if (!ip || amount <= 0) return;
    try {
      const used = amount === 1 ? await redis.incr(quotaKey(ip)) : await redis.incrby(quotaKey(ip), amount);
      if (used === amount) await redis.expire(quotaKey(ip), WINDOW_SECONDS);
    } catch (err) {
      logger.warn({ err }, 'Guest quota could not be recorded');
    }
  },

  /** Rolls back consumed credits if the operation failed. */
  async rollback(ip: string | undefined, amount = 1): Promise<void> {
    if (!ip || amount <= 0) return;
    try {
      const current = await redis.decrby(quotaKey(ip), amount);
      if (current < 0) await redis.set(quotaKey(ip), 0);
    } catch (err) {
      logger.warn({ err }, 'Guest quota rollback failed');
    }
  },
};
