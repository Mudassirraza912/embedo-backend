import { Queue, Worker, Job } from 'bullmq';
import { redis } from '../db/redis.js';
import { logger } from '../config/logger.js';
import { ekabReleaseService } from '../modules/ekab/ekab-release.service.js';
import { ekabScrapeService } from '../modules/ekab/scrape/ekab-scrape.service.js';

/**
 * EKAB background work (Track B releases). Runs only in the worker process, one job at a time, so
 * a large release or a scrape never competes with API traffic.
 *  - stage:   validate + load + round-trip + embed a RECEIVED release
 *  - recheck: re-run round-trip + embeddings of a loaded release
 *  - scrape:  fetch a scrape job's sources and extract candidates (deterministic, no AI)
 */
export const EKAB_QUEUE_NAME = 'ekab';

export type EkabJobData = { kind: 'stage'; releasePk: string } | { kind: 'recheck'; releasePk: string } | { kind: 'scrape'; jobId: string };

export const ekabQueue = new Queue<EkabJobData>(EKAB_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'exponential', delay: 10_000 },
    removeOnComplete: 200,
    removeOnFail: 500,
  },
});

/** Every kind is idempotent (stage only touches a RECEIVED release, scrape a queued job), so duplicates are harmless. */
export const enqueueEkab = (data: EkabJobData) =>
  ekabQueue.add(data.kind, data, { jobId: `${data.kind}_${'releasePk' in data ? data.releasePk : data.jobId}_${Date.now()}` });

export const createEkabWorker = () => {
  const worker = new Worker<EkabJobData>(
    EKAB_QUEUE_NAME,
    async (job: Job<EkabJobData>) => {
      switch (job.data.kind) {
        case 'stage':
          return ekabReleaseService.stage(job.data.releasePk);
        case 'recheck':
          return ekabReleaseService.recheck(job.data.releasePk);
        case 'scrape':
          return ekabScrapeService.run(job.data.jobId);
      }
    },
    { connection: redis, concurrency: 1, lockDuration: 300_000 }
  );
  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, data: job?.data, err: err.message }, 'EKAB job failed'));
  return worker;
};
