import { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis, RateLimiterMemory, RateLimiterAbstract } from 'rate-limiter-flexible';
import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { AppError } from '../errors/AppError.js';
import { logger } from '../../config/logger.js';
import { limitsService, DEFAULT_LIMITS } from '../../modules/limits/limits.service.js';

/**
 * Dedicated, lazily-connected Redis client for rate limiting.
 * enableOfflineQueue=false makes commands fail fast when Redis is unavailable so the
 * in-memory insurance limiter takes over instead of every request hanging or 429-ing.
 */
let redisClient: Redis | null = null;
const getRedisClient = (): Redis => {
  if (!redisClient) {
    redisClient = new Redis(env.REDIS_URL, {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    redisClient.on('error', (err: unknown) => logger.warn({ err }, 'Rate limiter Redis error'));
    redisClient.connect().catch((err: unknown) => logger.warn({ err }, 'Rate limiter Redis connect failed'));
  }
  return redisClient;
};

interface LimiterSpec {
  keyPrefix: string;
  points: number;
  duration: number; // seconds
}

const buildLimiter = (spec: LimiterSpec): RateLimiterAbstract => {
  const insurance = new RateLimiterMemory({ keyPrefix: `${spec.keyPrefix}:mem`, points: spec.points, duration: spec.duration });
  return new RateLimiterRedis({
    storeClient: getRedisClient(),
    keyPrefix: spec.keyPrefix,
    points: spec.points,
    duration: spec.duration,
    insuranceLimiter: insurance,
  });
};

// Lazily constructed so importing this module (e.g. in tests) does not open Redis connections.
let limiters: {
  global: RateLimiterAbstract;
  auth: RateLimiterAbstract;
  refresh: RateLimiterAbstract;
  sessionDailyIp: RateLimiterAbstract;
  discuss: RateLimiterAbstract;
  passwordReset: RateLimiterAbstract;
} | null = null;

const getLimiters = () => {
  if (!limiters) {
    limiters = {
      // Global per-IP limiter, configurable via RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS
      global: buildLimiter({ keyPrefix: 'rl:global', points: env.RATE_LIMIT_MAX, duration: Math.max(1, Math.round(env.RATE_LIMIT_WINDOW_MS / 1000)) }),
      // Auth endpoints: 10 attempts / minute / IP (anti brute-force)
      auth: buildLimiter({ keyPrefix: 'rl:auth', points: 10, duration: 60 }),
      // Token refresh gets its own bucket. It used to share the 10/min brute-force budget above,
      // but the SPA calls it on every page load (guests included), so a few page views used up the
      // allowance and blocked the next real login from that IP — worse behind a shared office NAT.
      // A refresh needs the httpOnly refresh cookie, so it is not a password-guessing vector.
      refresh: buildLimiter({ keyPrefix: 'rl:refresh', points: 60, duration: 60 }),
      // Absolute daily ceiling per IP regardless of auth state (cost circuit breaker)
      sessionDailyIp: buildLimiter({ keyPrefix: 'rl:session:daily', points: env.SESSION_CREATE_DAILY_MAX_PER_IP, duration: 86400 }),
      // Discuss refinement: 30 / hour / session (plus the global IP limiter)
      discuss: buildLimiter({ keyPrefix: 'rl:discuss', points: 30, duration: 3600 }),
      // Password reset requests: 3 / hour / IP
      passwordReset: buildLimiter({ keyPrefix: 'rl:pwreset', points: 3, duration: 3600 }),
    };
  }
  return limiters;
};

// Hourly session-creation limits are editable per plan (and per user) from the admin panel, so the
// point count is not fixed at startup. One limiter per (bucket, points): a changed limit gets a fresh
// counter under a new key instead of mutating a live limiter.
const hourlyLimiters = new Map<string, RateLimiterAbstract>();
const hourlyLimiter = (bucket: 'user' | 'guest', points: number): RateLimiterAbstract => {
  const key = `${bucket}:${points}`;
  let limiter = hourlyLimiters.get(key);
  if (!limiter) {
    limiter = buildLimiter({ keyPrefix: `rl:session:${bucket}:${points}`, points, duration: 3600 });
    hourlyLimiters.set(key, limiter);
  }
  return limiter;
};

const clientIp = (req: Request): string => req.ip || req.socket.remoteAddress || 'unknown-ip';

const isBypassed = (): boolean => env.NODE_ENV === 'test' && process.env.RATE_LIMIT_FORCE_IN_TEST !== 'true';

const consumeOr429 = async (
  limiter: RateLimiterAbstract,
  key: string,
  message: string,
  next: NextFunction,
  res: Response
): Promise<boolean> => {
  try {
    await limiter.consume(key);
    return true;
  } catch (rej: unknown) {
    const msBeforeNext = typeof rej === 'object' && rej !== null && 'msBeforeNext' in rej ? Number((rej as { msBeforeNext: number }).msBeforeNext) : 0;
    if (msBeforeNext > 0) {
      res.setHeader('Retry-After', String(Math.ceil(msBeforeNext / 1000)));
    }
    next(new AppError(429, 'RATE_LIMITED', message));
    return false;
  }
};

export const rateLimitGlobal = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (isBypassed()) return next();
  const ok = await consumeOr429(getLimiters().global, clientIp(req), 'Too many requests. Please slow down.', next, res);
  if (ok) next();
};

export const rateLimitAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (isBypassed()) return next();
  const ok = await consumeOr429(
    getLimiters().auth,
    clientIp(req),
    'Too many authentication attempts. Please try again later.',
    next,
    res
  );
  if (ok) next();
};

export const rateLimitTokenRefresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (isBypassed()) return next();
  const ok = await consumeOr429(
    getLimiters().refresh,
    clientIp(req),
    'Too many session refresh requests. Please try again shortly.',
    next,
    res
  );
  if (ok) next();
};

export const rateLimitPasswordReset = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (isBypassed()) return next();
  const ok = await consumeOr429(
    getLimiters().passwordReset,
    clientIp(req),
    'Too many password reset requests. Please try again later.',
    next,
    res
  );
  if (ok) next();
};

export const rateLimitSessionCreation = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (isBypassed()) return next();
  const ip = clientIp(req);
  const l = getLimiters();

  // 1. Hard daily ceiling per IP (applies to everyone)
  const dailyOk = await consumeOr429(
    l.sessionDailyIp,
    ip,
    'Daily architecture generation limit reached for this network. Please try again tomorrow.',
    next,
    res
  );
  if (!dailyOk) return;

  // 2. Hourly bucket: registered users by userId, guests by IP (never by client-supplied token)
  const message = 'Session creation rate limit exceeded. Please sign in or wait before creating new hardware architectures.';
  const userId = req.user?.id;
  let perHour = userId ? DEFAULT_LIMITS.free.sessionsPerHour : DEFAULT_LIMITS.guest.sessionsPerHour;
  try {
    perHour = (userId ? await limitsService.forUser(userId) : await limitsService.forGuest()).limits.sessionsPerHour;
  } catch (err) {
    logger.warn({ err }, 'Could not resolve session-creation limit; using the built-in default');
  }
  const ok = userId
    ? await consumeOr429(hourlyLimiter('user', perHour), userId, message, next, res)
    : await consumeOr429(hourlyLimiter('guest', perHour), ip, message, next, res);
  if (ok) next();
};

export const rateLimitDiscuss = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  if (isBypassed()) return next();
  const sessionId = typeof req.params.id === 'string' ? req.params.id : clientIp(req);
  const ok = await consumeOr429(
    getLimiters().discuss,
    sessionId,
    'Refinement rate limit exceeded for this session. Please wait a bit.',
    next,
    res
  );
  if (ok) next();
};
