import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';
import { redis } from '../db/redis.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';
import { emitSessionEvent } from '../modules/realtime/socket.js';
import { AiRouterService } from '../modules/ai/ai-router.service.js';
import { runGenerationPipeline, RetryablePipelineError } from '../modules/sessions/pipeline/orchestrator.js';

export const AI_PIPELINE_QUEUE_NAME = 'ai-pipeline';

export interface AiPipelineJobData {
  sessionId: string;
  forceGenerate?: boolean;
  iterationNotes?: string;
}

const MAX_ATTEMPTS = 3;

export const aiPipelineQueue = new Queue<AiPipelineJobData>(AI_PIPELINE_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/** Deterministic job id so a session never has two concurrent pipeline runs queued. */
export const pipelineJobId = (sessionId: string, kind: 'initial' | 'iteration'): string =>
  kind === 'initial' ? `session_${sessionId}` : `session_${sessionId}_iter`;

const markSessionFailed = async (sessionId: string, reason: string, retryable: boolean): Promise<void> => {
  try {
    await prisma.designSession.update({ where: { id: sessionId }, data: { status: 'FAILED' } });
    await prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content: retryable
          ? 'Architecture generation could not be completed right now due to a temporary AI provider issue. Please try again in a moment.'
          : 'Architecture generation could not be completed for this request. Please refine your description and try again.',
        metadata: { failure: true, reason: reason.slice(0, 500), retryable },
      },
    });
  } catch (err: unknown) {
    logger.error({ err, sessionId }, 'Failed to mark session as FAILED');
  }
  emitSessionEvent.error(sessionId, retryable ? 'Temporary AI provider issue — please retry.' : 'Generation failed for this request.', retryable);
};

export const createAiPipelineWorker = () => {
  const worker = new Worker<AiPipelineJobData>(
    AI_PIPELINE_QUEUE_NAME,
    async (job: Job<AiPipelineJobData>) => {
      logger.info({ jobId: job.id, sessionId: job.data.sessionId, attempt: job.attemptsMade + 1 }, 'Processing AI Pipeline Job');
      try {
        return await runGenerationPipeline(job.data.sessionId, {
          forceGenerate: job.data.forceGenerate,
          iterationNotes: job.data.iterationNotes,
        });
      } catch (err: unknown) {
        // Rule #8: do not blanket-retry. Only provider rate limits / timeouts / 5xx, and the
        // explicit single-Sol-sample topology-validation case (RetryablePipelineError), are
        // retried — every other failure (schema exhaustion, unexpected bugs) defaults to
        // non-retryable, since a BullMQ retry re-runs the whole 7-step pipeline (re-spending
        // Sol/Luna tokens) and a deterministic failure will just reproduce itself.
        const retryable = AiRouterService.isRetryable(err) || err instanceof RetryablePipelineError;
        if (!retryable) {
          throw new UnrecoverableError(err instanceof Error ? err.message : 'Non-retryable pipeline failure');
        }
        throw err;
      }
    },
    {
      connection: redis,
      concurrency: 5,
      // A single pipeline run should never exceed this; stalled jobs are re-queued.
      lockDuration: 120_000,
    }
  );

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id, sessionId: job.data.sessionId }, 'AI Pipeline Job completed');
  });

  worker.on('failed', (job, err) => {
    const sessionId = job?.data?.sessionId;
    const attempts = job?.opts?.attempts ?? MAX_ATTEMPTS;
    const exhausted = !job || err instanceof UnrecoverableError || job.attemptsMade >= attempts;
    logger.error({ jobId: job?.id, sessionId, attempt: job?.attemptsMade, exhausted, err: err.message }, 'AI Pipeline Job failed');

    if (sessionId && exhausted) {
      const retryable = !(err instanceof UnrecoverableError);
      void markSessionFailed(sessionId, err.message, retryable);
    }
  });

  return worker;
};
