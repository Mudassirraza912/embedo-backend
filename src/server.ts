import http from 'http';
import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { initSocketIO } from './modules/realtime/socket.js';
import { prisma } from './db/prisma.js';
import { redis } from './db/redis.js';
import { closeRealtimeConnections } from './modules/realtime/redis-events.js';

// Process-level safety nets: log with full context, then exit so PM2/Docker restarts a clean process.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection — shutting down');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — shutting down');
  process.exit(1);
});

const startServer = async () => {
  try {
    const app = createApp();
    const server = http.createServer(app);

    // Initialize Socket.IO (+ Redis adapter and worker->API event bridge)
    const io = initSocketIO(server);

    server.listen(env.PORT, () => {
      logger.info(`🚀 Embedo Backend API Server running on port ${env.PORT} (${env.NODE_ENV})`);
      logger.info(`👉 Health check: http://localhost:${env.PORT}${env.API_PREFIX}/health`);
      if (env.NODE_ENV !== 'production') {
        logger.warn(`NODE_ENV=${env.NODE_ENV}: development behaviour is enabled (verbose errors, non-secure cookies).`);
      }
    });

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Received ${signal}. Shutting down gracefully...`);

      // Force shutdown after 10s if connections hang
      const forceTimer = setTimeout(() => {
        logger.error('Could not close connections in time, forcefully shutting down');
        process.exit(1);
      }, 10000);
      forceTimer.unref();

      server.close(async () => {
        logger.info('HTTP server closed.');
        try {
          await io.close();
          await closeRealtimeConnections();
          await prisma.$disconnect();
          logger.info('Database connection closed.');
          await redis.quit().catch(() => undefined);
          logger.info('Redis connection closed.');
          process.exit(0);
        } catch (err) {
          logger.error({ err }, 'Error during graceful shutdown');
          process.exit(1);
        }
      });
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start API server');
    process.exit(1);
  }
};

void startServer();
