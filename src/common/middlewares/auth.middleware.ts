import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../errors/AppError.js';
import { prisma } from '../../db/prisma.js';
import { redis } from '../../db/redis.js';
import { logger } from '../../config/logger.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      anonSessionToken?: string;
    }
  }
}

interface AccessTokenPayload {
  userId: string;
  email: string;
  role: string;
}

/** Redis key used by the moderation service for temporary (24h) user suspensions. */
export const userSuspensionKey = (userId: string): string => `mod:suspend:user:${userId}`;

/**
 * Optional authentication. Populates req.user when a valid Bearer token is present.
 * - Invalid/expired tokens -> 401
 * - Database failures are NOT masked as 401; they propagate to the error handler.
 */
export const authenticate = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;
  const anonHeader = req.headers['x-anon-session-token'];

  if (typeof anonHeader === 'string' && anonHeader.length > 0 && anonHeader.length <= 255) {
    req.anonSessionToken = anonHeader;
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.slice(7).trim();

  let payload: AccessTokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
  } catch {
    return next(new AppError(401, 'UNAUTHORIZED', 'Invalid or expired access token'));
  }

  if (!payload || typeof payload.userId !== 'string') {
    return next(new AppError(401, 'UNAUTHORIZED', 'Invalid access token payload'));
  }

  try {
    const user = await prisma.user.findFirst({
      where: { id: payload.userId, deletedAt: null },
      select: { id: true, email: true, role: true, suspendedAt: true },
    });

    if (!user) {
      return next(new AppError(401, 'UNAUTHORIZED', 'User not found or deleted'));
    }

    if (user.suspendedAt) {
      return next(new AppError(403, 'ACCOUNT_SUSPENDED', 'Account has been suspended'));
    }

    // Temporary moderation suspension (24h window, see moderation.service.ts)
    const tempSuspended = await redis.get(userSuspensionKey(user.id)).catch((err: unknown) => {
      logger.warn({ err }, 'Could not check temporary suspension state in Redis');
      return null;
    });
    if (tempSuspended) {
      return next(
        new AppError(403, 'ACCOUNT_SUSPENDED', 'Account temporarily suspended due to repeated policy violations')
      );
    }

    req.user = { id: user.id, email: user.email, role: user.role };
    return next();
  } catch (err) {
    // Genuine infrastructure failure — surface it, do not disguise as an auth failure.
    return next(err);
  }
};

export const requireAuth = (req: Request, _res: Response, next: NextFunction): void => {
  if (!req.user) {
    return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required for this action'));
  }
  next();
};

export const requireRole = (role: string) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError(401, 'UNAUTHORIZED', 'Authentication required'));
    }
    if (req.user.role !== role && req.user.role !== 'admin') {
      return next(new AppError(403, 'FORBIDDEN', 'Insufficient permissions'));
    }
    next();
  };
};

const timingSafeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/**
 * Guard for browser-facing operator dashboards (Bull Board, Swagger in production).
 * Accepts either:
 *   - an admin JWT (Authorization: Bearer ...), or
 *   - HTTP Basic credentials matching DASHBOARD_USER / DASHBOARD_PASSWORD.
 * If Basic credentials are not configured, only admin JWTs are accepted.
 */
export const requireDashboardAccess = (req: Request, res: Response, next: NextFunction): void => {
  if (req.user?.role === 'admin') {
    return next();
  }

  const basicUser = env.DASHBOARD_USER || (env.NODE_ENV !== 'production' ? 'admin' : undefined);
  const basicPass = env.DASHBOARD_PASSWORD || (env.NODE_ENV !== 'production' ? 'admin' : undefined);
  const header = req.headers.authorization;

  if (basicUser && basicPass && header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const user = sep >= 0 ? decoded.slice(0, sep) : '';
    const pass = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (timingSafeEqual(user, basicUser) && timingSafeEqual(pass, basicPass)) {
      return next();
    }
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Embedo Operator Dashboard"');
  return next(new AppError(401, 'UNAUTHORIZED', 'Operator dashboard requires admin credentials'));
};
