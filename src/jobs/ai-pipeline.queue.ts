import { Queue, Worker, Job, UnrecoverableError } from 'bullmq';
import { redis } from '../db/redis.js';
import { prisma } from '../db/prisma.js';
import { logger } from '../config/logger.js';
import { emitSessionEvent } from '../modules/realtime/socket.js';
import { AiRouterService } from '../modules/ai/ai-router.service.js';
import { RetryablePipelineError } from '../modules/sessions/pipeline/orchestrator.js';
import { runSessionPipeline } from '../modules/sessions/pipeline/dispatch.js';
import { SessionType, sessionTypeOf } from '../modules/sessions/session-type.js';
import { guestQuotaService } from '../modules/limits/guest-quota.service.js';
import { calculateCreditsForSession } from '../modules/sessions/credits-calculator.js';

import type { ApplyMode } from '../modules/sessions/version.service.js';

export const AI_PIPELINE_QUEUE_NAME = 'ai-pipeline';

export interface AiPipelineJobData {
  sessionId: string;
  forceGenerate?: boolean;
  iterationNotes?: string;
  /** `manual`: a revision is saved as a proposal awaiting approval instead of a version. */
  applyMode?: ApplyMode;
  /** For logs and the queue dashboard only: the pipeline dispatches on the session's stored type. */
  type?: SessionType;
  ipAddress?: string;
  userId?: string;
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

const markSessionFailed = async (
  sessionId: string,
  reason: string,
  retryable: boolean,
  ipAddress?: string,
  _userId?: string
): Promise<void> => {
  try {
    if (ipAddress) {
      await guestQuotaService.rollback(ipAddress);
      logger.info({ sessionId, ipAddress }, 'Guest credit rolled back after pipeline failure');
    }

    try {
      const lastUserMessage = await prisma.chatMessage.findFirst({
        where: { sessionId, role: 'user' },
        orderBy: { createdAt: 'desc' },
      });
      if (lastUserMessage) {
        const meta = (lastUserMessage.metadata as Record<string, unknown> | null) ?? {};
        await prisma.chatMessage.update({
          where: { id: lastUserMessage.id },
          data: { metadata: { ...meta, failure: true, refunded: true } },
        });
      }
    } catch (metaErr) {
      logger.warn({ err: metaErr, sessionId }, 'Failed to mark user message metadata as refunded');
    }
    // A failed refinement must not take down a session that already has a working architecture:
    // the last good version is still active and valid, so keep the session DONE (FAILED used to
    // make every later chat message go unanswered). Only a session that never produced an
    // architecture is actually FAILED.
    const existing = await prisma.designSession.findUnique({
      where: { id: sessionId },
      select: { architecture: true, applicationContext: true },
    });
    const hasArchitecture = Boolean(existing?.architecture);
    const isPrototype = sessionTypeOf(existing?.applicationContext) === 'prototype';
    const arch = existing?.architecture;
    const versionTag =
      arch && typeof arch === 'object' && !Array.isArray(arch) && typeof arch['versionTag'] === 'string' ? arch['versionTag'] : null;
    await prisma.designSession.update({ where: { id: sessionId }, data: { status: hasArchitecture ? 'DONE' : 'FAILED' } });

    const content = hasArchitecture
      ? `I couldn't apply that change this time — your current design${
          versionTag ? ` (${versionTag})` : ''
        } is unchanged. ${retryable ? 'Please try sending it again.' : 'Try rephrasing the change or asking for it in smaller steps.'}`
      : isPrototype
        ? retryable
          ? "I couldn't assemble this prototype on this attempt. Please send your request again — naming the controller board you want helps."
          : 'I couldn’t assemble a prototype from the hardware library for this request. Try naming the boards or sensors you want, or simplify the request.'
        : retryable
          ? "I couldn't complete this architecture on this attempt. Please send your request again — or add a detail or two (e.g. the main controller or power source) to help me pin it down."
          : 'Architecture generation could not be completed for this request. Please refine your description and try again.';

    await prisma.chatMessage.create({
      data: {
        sessionId,
        role: 'assistant',
        content,
        metadata: { failure: true, reason: reason.slice(0, 500), retryable, keptVersion: hasArchitecture },
      },
    });
  } catch (err: unknown) {
    logger.error({ err, sessionId }, 'Failed to mark session as FAILED');
  }
  emitSessionEvent.error(sessionId, retryable ? 'Temporary AI provider issue — please retry.' : 'Generation failed for this request.', retryable);
    try {
      const updatedCredits = await calculateCreditsForSession({ id: sessionId, userId: _userId }, ipAddress);
      emitSessionEvent.creditsUpdated(sessionId, updatedCredits);
    } catch (creditsErr) {
      logger.warn({ err: creditsErr, sessionId }, 'Failed to emit creditsUpdated after failure');
    }
};

export const createAiPipelineWorker = () => {
  const worker = new Worker<AiPipelineJobData>(
    AI_PIPELINE_QUEUE_NAME,
    async (job: Job<AiPipelineJobData>) => {
      logger.info(
        { jobId: job.id, sessionId: job.data.sessionId, type: job.data.type ?? 'architect', attempt: job.attemptsMade + 1 },
        'Processing AI Pipeline Job'
      );
      try {
        return await runSessionPipeline(job.data.sessionId, {
          forceGenerate: job.data.forceGenerate,
          iterationNotes: job.data.iterationNotes,
          applyMode: job.data.applyMode,
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
      // A single pipeline run should never exceed this; stalled jobs are re-queued. Prototype runs
      // that source hardware (vendor page fetch + extraction per module) need more than Architect.
      lockDuration: 300_000,
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
      void markSessionFailed(sessionId, err.message, retryable, job?.data?.ipAddress, job?.data?.userId);
    }
  });

  return worker;
};
