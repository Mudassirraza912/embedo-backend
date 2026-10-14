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
  resetAt: string | null;
}

async function status(ip: string): Promise<GuestQuotaStatus> {
  const { limits } = await limitsService.forGuest();
  const [count, ttl] = await Promise.all([redis.get(quotaKey(ip)), redis.ttl(quotaKey(ip))]);
  return {
    used: Number(count ?? 0),
    limit: limits.messagesPerSession,
    resetAt: ttl > 0 ? new Date(Date.now() + ttl * 1000).toISOString() : null,
  };
}

export const guestQuotaService = {
  status,

  /** Throws GUEST_QUOTA_EXCEEDED (with the reset time) once this IP has used its allowance. */
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
        `You've used all ${current.limit} free guest messages for today. Sign in (it's free) to keep going, or come back after the limit resets.`,
        { limit: current.limit, resetAt: current.resetAt }
      );
    }
  },

  /** Records one guest message; the first one in a window starts the 24-hour clock. */
  async consume(ip: string | undefined): Promise<void> {
    if (!ip) return;
    try {
      const used = await redis.incr(quotaKey(ip));
      if (used === 1) await redis.expire(quotaKey(ip), WINDOW_SECONDS);
    } catch (err) {
      logger.warn({ err }, 'Guest quota could not be recorded');
    }
  },
};
