import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../db/redis.js';
import { logger } from '../config/logger.js';

export const COMPONENT_REFRESH_QUEUE_NAME = 'component-refresh';

export interface ComponentRefreshJobData {
  partNumber: string;
  source?: string;
}

export const componentRefreshQueue = new Queue<ComponentRefreshJobData>(COMPONENT_REFRESH_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 5000,
    },
    removeOnComplete: 100,
  },
});

export const createComponentRefreshWorker = () => {
  const worker = new Worker<ComponentRefreshJobData>(
    COMPONENT_REFRESH_QUEUE_NAME,
    async (job: Job<ComponentRefreshJobData>) => {
      logger.info({ partNumber: job.data.partNumber }, 'Processing Component Refresh Job');
      return { status: 'refreshed', partNumber: job.data.partNumber };
    },
    { connection: redis, concurrency: 2 }
  );

  return worker;
};
