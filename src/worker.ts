import { logger } from './config/logger.js';
import { env } from './config/env.js';
import { createAiPipelineWorker } from './jobs/ai-pipeline.queue.js';
import { createExportWorker } from './jobs/export.queue.js';
import { createComponentRefreshWorker } from './jobs/component-refresh.queue.js';
import { createDatasheetIngestWorker } from './jobs/datasheet-ingest.queue.js';
import { prisma } from './db/prisma.js';
import { redis } from './db/redis.js';
import { closeRealtimeConnections } from './modules/realtime/redis-events.js';

process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection in worker — shutting down');
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception in worker — shutting down');
  process.exit(1);
});

const startWorker = async () => {
  try {
    logger.info(`⚡ Starting BullMQ Queue Workers in ${env.NODE_ENV} mode...`);

    const aiWorker = createAiPipelineWorker();
    const exportWorker = createExportWorker();
    const componentWorker = createComponentRefreshWorker();
    const datasheetWorker = createDatasheetIngestWorker();

    logger.info('✓ All BullMQ workers initialized and listening for jobs.');

    let shuttingDown = false;
    const shutdown = async (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info(`Received ${signal}. Closing workers gracefully...`);

      const forceTimer = setTimeout(() => {
        logger.error('Workers did not close in time, forcefully shutting down');
        process.exit(1);
      }, 30000);
      forceTimer.unref();

      try {
        await Promise.all([aiWorker.close(), exportWorker.close(), componentWorker.close(), datasheetWorker.close()]);
        logger.info('Workers closed.');

        await closeRealtimeConnections();
        await prisma.$disconnect();
        await redis.quit().catch(() => undefined);
        logger.info('DB & Redis connections closed.');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during worker shutdown');
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start BullMQ workers');
    process.exit(1);
  }
};

void startWorker();
