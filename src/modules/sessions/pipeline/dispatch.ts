import { prisma } from '../../../db/prisma.js';
import { sessionTypeOf } from '../session-type.js';
import { runPrototypePipeline } from '../prototype/prototype-pipeline.js';
import { NonRetryablePipelineError, PipelineExecutionOptions, PipelineExecutionResult, runGenerationPipeline } from './orchestrator.js';

/**
 * Entry point for the ai-pipeline worker. The session's stored type decides the pipeline, not the
 * job payload, so a job queued before a type switch can never run the wrong one.
 */
export async function runSessionPipeline(sessionId: string, options: PipelineExecutionOptions = {}): Promise<PipelineExecutionResult> {
  const session = await prisma.designSession.findUnique({ where: { id: sessionId }, select: { applicationContext: true } });
  if (!session) throw new NonRetryablePipelineError('Session not found');
  return sessionTypeOf(session.applicationContext) === 'prototype'
    ? runPrototypePipeline(sessionId, options)
    : runGenerationPipeline(sessionId, options);
}
