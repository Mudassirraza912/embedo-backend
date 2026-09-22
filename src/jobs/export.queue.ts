import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../db/redis.js';
import { logger } from '../config/logger.js';

export const EXPORT_QUEUE_NAME = 'export';

export interface ExportJobData {
  sessionId: string;
  format: 'kicad' | 'altium' | 'svg' | 'json';
  userId?: string;
}

export const exportQueue = new Queue<ExportJobData>(EXPORT_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: {
      type: 'fixed',
      delay: 1000,
    },
    removeOnComplete: true,
  },
});

export const createExportWorker = () => {
  const worker = new Worker<ExportJobData>(
    EXPORT_QUEUE_NAME,
    async (job: Job<ExportJobData>) => {
      logger.info({ jobId: job.id, sessionId: job.data.sessionId, format: job.data.format }, 'Processing Export Job');
      // Export pipeline will be wired here in Phase 1
      return { status: 'completed', sessionId: job.data.sessionId, format: job.data.format };
    },
    {
      connection: redis,
      concurrency: 3,
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, sessionId: job.data.sessionId }, 'Export Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Export Job failed');
  });

  return worker;
};
