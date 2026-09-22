import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { swaggerDocument } from './config/swagger.js';
import { requestIdMiddleware } from './common/middlewares/request-id.middleware.js';
import { errorHandlerMiddleware } from './common/middlewares/error-handler.middleware.js';
import { authenticate, requireDashboardAccess } from './common/middlewares/auth.middleware.js';
import { AppError } from './common/errors/AppError.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';
import { sessionsRoutes } from './modules/sessions/sessions.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';

import { prisma } from './db/prisma.js';
import { redis } from './db/redis.js';
import { bullBoardRouter } from './jobs/bull-board.js';
import { logger } from './config/logger.js';

import { rateLimitGlobal } from './common/middlewares/rate-limit.middleware.js';

export const createApp = (): Express => {
  const app = express();

  // Behind Nginx (see DEPLOY.md). Port 4000 must NOT be reachable except via the proxy,
  // otherwise X-Forwarded-For can be spoofed to defeat IP-based limits.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

  // Security & standard middlewares
  app.use(
    helmet({
      // Swagger UI needs inline scripts; CSP stays on in production (docs are admin-gated there).
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
    })
  );
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(requestIdMiddleware);

  // Deep Health Check — mounted BEFORE the rate limiter so monitoring never competes with user traffic.
  app.get(`${env.API_PREFIX}/health`, async (req: Request, res: Response) => {
    let dbStatus = 'down';
    let redisStatus = 'down';

    try {
      await prisma.$queryRaw`SELECT 1`;
      dbStatus = 'up';
    } catch {
      dbStatus = 'down';
    }

    try {
      const pong = await redis.ping();
      if (pong === 'PONG') redisStatus = 'up';
    } catch {
      redisStatus = 'down';
    }

    const isHealthy = dbStatus === 'up' && redisStatus === 'up';
    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'ok' : 'degraded',
      services: { database: dbStatus, redis: redisStatus },
      timestamp: new Date().toISOString(),
      env: env.NODE_ENV,
      requestId: req.id,
    });
  });

  // Rate limiting runs BEFORE authentication so throttled requests never hit the database.
  app.use(rateLimitGlobal);
  app.use(authenticate);

  // Operator-only surfaces. In production these require an admin JWT or dashboard Basic credentials.
  const dashboardGuard = env.NODE_ENV === 'production' ? [requireDashboardAccess] : [];

  // Swagger OpenAPI Documentation UI & JSON spec
  app.get('/docs/openapi.json', ...dashboardGuard, (_req: Request, res: Response) => {
    res.status(200).json(swaggerDocument);
  });
  app.use('/docs', ...dashboardGuard, swaggerUi.serve, swaggerUi.setup(swaggerDocument));
  app.use(`${env.API_PREFIX}/docs`, ...dashboardGuard, swaggerUi.serve, swaggerUi.setup(swaggerDocument));

  // API Routes
  app.use(`${env.API_PREFIX}/auth`, authRoutes);
  app.use(`${env.API_PREFIX}/users`, usersRoutes);
  app.use(`${env.API_PREFIX}/sessions`, sessionsRoutes);
  app.use(`${env.API_PREFIX}/admin`, adminRoutes);

  // BullMQ dashboard — ALWAYS guarded (admin JWT or DASHBOARD_USER/PASSWORD Basic auth).
  if (env.NODE_ENV === 'production' && !env.DASHBOARD_PASSWORD) {
    logger.warn('DASHBOARD_PASSWORD not set: Bull Board is reachable only with an admin JWT.');
  }
  app.use('/admin/queues', requireDashboardAccess, bullBoardRouter);

  // 404 Route Handler
  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
  });

  // Global Error Handler
  app.use(errorHandlerMiddleware);

  return app;
};
