import { Queue, Worker, Job, QueueEvents, UnrecoverableError } from 'bullmq';
import { redis } from '../db/redis.js';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';
import { datasheetIngestionService, IngestionProgress, isNonRetryableIngestionFailure } from '../modules/components/datasheet-ingestion.service.js';
import { Redis } from 'ioredis';

export const DATASHEET_INGEST_QUEUE_NAME = 'datasheet-ingest';

export interface DatasheetIngestJobData {
  datasheetUrl: string;
  componentId?: string;
  actorUserId?: string;
}

export const datasheetIngestQueue = new Queue<DatasheetIngestJobData>(DATASHEET_INGEST_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: 500,
    removeOnFail: 1000,
  },
});

/**
 * Shared QueueEvents (dedicated connection, created lazily) so API handlers can stream a job's
 * progress/completion to clients without executing the work in the API process.
 */
let queueEvents: QueueEvents | null = null;
export const getDatasheetIngestQueueEvents = (): QueueEvents => {
  if (!queueEvents) {
    const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false, lazyConnect: true });
    connection.on('error', (err: unknown) => logger.error({ err }, 'Datasheet ingest QueueEvents Redis error'));
    connection.connect().catch((err: unknown) => logger.error({ err }, 'Datasheet ingest QueueEvents failed to connect'));
    queueEvents = new QueueEvents(DATASHEET_INGEST_QUEUE_NAME, { connection });
  }
  return queueEvents;
};

export const createDatasheetIngestWorker = () => {
  const worker = new Worker<DatasheetIngestJobData>(
    DATASHEET_INGEST_QUEUE_NAME,
    async (job: Job<DatasheetIngestJobData>) => {
      logger.info({ jobId: job.id, url: job.data.datasheetUrl, attempt: job.attemptsMade + 1 }, 'Processing datasheet ingest job');

      const onProgress = async (progress: IngestionProgress) => {
        // Progress payload is the full IngestionProgress object so QueueEvents consumers can stream it.
        await job.updateProgress(progress as unknown as Record<string, unknown>);
        await job.log(`[Stage ${progress.step}/${progress.totalSteps}] ${progress.stage}: ${progress.message}`);
      };

      try {
        const result = await datasheetIngestionService.ingestFromUrl(job.data.datasheetUrl, {
          actorUserId: job.data.actorUserId,
          onProgress,
        });

        await job.log(`Completed: Ingested ${result.partNumber} with ${result.chunksIngested} vector chunks.`);
        return result;
      } catch (err) {
        // Some failures (password-protected, malformed, scanned/OCR-only, non-hardware domain) can
        // never succeed by retrying the same PDF — burning 3 exponential-backoff attempts on them
        // just delays surfacing the real problem. UnrecoverableError tells BullMQ to fail immediately.
        if (isNonRetryableIngestionFailure(err)) {
          throw new UnrecoverableError(err instanceof Error ? err.message : String(err));
        }
        throw err;
      }
    },
    { connection: redis, concurrency: 2, lockDuration: 300_000 }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, result: job.returnvalue }, 'Datasheet ingestion job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, url: job?.data?.datasheetUrl, err: err.message }, 'Datasheet ingestion job failed');
  });

  return worker;
};
