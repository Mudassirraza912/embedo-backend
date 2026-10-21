import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { swaggerDocument } from './config/swagger.js';
import { requestIdMiddleware } from './common/middlewares/request-id.middleware.js';
import { buildInfo } from './config/build-info.js';
import { errorHandlerMiddleware } from './common/middlewares/error-handler.middleware.js';
import { authenticate, requireDashboardAccess } from './common/middlewares/auth.middleware.js';
import { AppError } from './common/errors/AppError.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import { usersRoutes } from './modules/users/users.routes.js';
import { sessionsRoutes } from './modules/sessions/sessions.routes.js';
import { adminRoutes } from './modules/admin/admin.routes.js';
import { hardwareRoutes } from './modules/hardware/hardware.routes.js';

import { prisma } from './db/prisma.js';
import { redis } from './db/redis.js';
import { bullBoardRouter } from './jobs/bull-board.js';
import { logger } from './config/logger.js';
import { computeLiveServiceTelemetry, addSubscriber, removeSubscriber, unsubscribeByToken } from './modules/status/status.service.js';

import { rateLimitGlobal } from './common/middlewares/rate-limit.middleware.js';

export const createApp = (): Express => {
  const app = express();

  // Behind Nginx (see DEPLOY.md). Port 4000 must NOT be reachable except via the proxy,
  // otherwise X-Forwarded-For can be spoofed to defeat IP-based limits.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  const explicitOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
  const corsOriginValidator = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return callback(null, true);
    if (explicitOrigins.includes(origin)) return callback(null, true);
    try {
      const url = new URL(origin);
      if (
        url.hostname === 'embedo.ai' ||
        url.hostname.endsWith('.embedo.ai') ||
        url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1'
      ) {
        return callback(null, true);
      }
    } catch {
      // invalid origin URL
    }
    return callback(new Error(`Origin ${origin} not allowed by CORS`));
  };

  // Security & standard middlewares
  app.use(
    helmet({
      // Swagger UI needs inline scripts; CSP stays on in production (docs are admin-gated there).
      contentSecurityPolicy: env.NODE_ENV === 'production' ? undefined : false,
    })
  );
  app.use(cors({ origin: corsOriginValidator, credentials: true, exposedHeaders: ['X-Embedo-Version', 'X-Request-Id'] }));
  app.use(cookieParser());
  app.use(`${env.API_PREFIX}/admin/components/ingest/json`, express.json({ limit: '12mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(requestIdMiddleware);
  // Every response says which build answered it (support, bug reports, deploy checks).
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Embedo-Version', buildInfo.version);
    next();
  });

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
      version: buildInfo.version,
      commit: buildInfo.commit,
      builtAt: buildInfo.builtAt,
      channel: buildInfo.channel,
      requestId: req.id,
    });
  });

  // Public Service Status endpoint for status.embedo.ai (ESD-2 / ESD-3 / ESD-4 / ESD-5)
  // Status page is public telemetry: allow all origins with preflight support
  const publicCors = cors({ origin: '*', methods: ['GET', 'OPTIONS'] });
  const subscribeCors = cors({ origin: '*', methods: ['POST', 'DELETE', 'OPTIONS'] });

  app.options(`${env.API_PREFIX}/status`, publicCors);
  app.get(`${env.API_PREFIX}/status`, publicCors, async (_req: Request, res: Response) => {
    try {
      const telemetry = await computeLiveServiceTelemetry();
      res.status(200).json(telemetry);
    } catch (err) {
      logger.error({ err }, 'Failed to compute live service telemetry');
      res.status(500).json({ error: 'Failed to compute service status' });
    }
  });

  // Public status subscription endpoints (ESD-8)
  app.options(`${env.API_PREFIX}/status/subscribe`, subscribeCors);
  app.post(`${env.API_PREFIX}/status/subscribe`, subscribeCors, async (req: Request, res: Response) => {
    const { email, webhookUrl, topics } = (req.body || {}) as { email?: string; webhookUrl?: string; topics?: string[] };
    if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const result = await addSubscriber('email', email, topics);
      res.status(200).json({
        success: true,
        message: 'Subscribed to status updates successfully.',
        unsubscribeToken: result.unsubscribeToken,
      });
      return;
    }
    if (webhookUrl && /^https?:\/\//i.test(webhookUrl)) {
      const result = await addSubscriber('webhook', webhookUrl, topics);
      res.status(200).json({
        success: true,
        message: 'Webhook subscribed successfully.',
        unsubscribeToken: result.unsubscribeToken,
      });
      return;
    }
    res.status(400).json({ error: 'Valid email address or webhook URL required.' });
  });

  app.delete(`${env.API_PREFIX}/status/subscribe`, subscribeCors, async (req: Request, res: Response) => {
    const { email, webhookUrl, token } = (req.body || {}) as { email?: string; webhookUrl?: string; token?: string };
    if (token) {
      await unsubscribeByToken(token);
      res.status(200).json({ success: true, message: 'Unsubscribed successfully.' });
      return;
    }
    if (email) await removeSubscriber('email', email);
    if (webhookUrl) await removeSubscriber('webhook', webhookUrl);
    res.status(200).json({ success: true, message: 'Unsubscribed successfully.' });
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
  app.use(`${env.API_PREFIX}/hardware`, hardwareRoutes);
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
