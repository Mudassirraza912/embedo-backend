import { prisma } from '../../../db/prisma.js';
import { logger } from '../../../config/logger.js';
import { emitSessionEvent } from '../../realtime/socket.js';
import { parseHardwareIntent, IntentExtractionError } from './intent-parser.js';
import { checkSufficiency, GENERATION_HOLD_MESSAGE, isGibberishOrSpam } from './sufficiency-gate.js';
import { getGroundingContext } from './rag-grounder.js';
import { buildCanonicalDesignGraph, DesignGraphSchemaError } from './design-graph-builder.js';
import { validateAndRepairDesignGraph } from './validator.js';
import { projectArchitecture } from './diagram-projector.js';
import { CanonicalDesignGraph, ProjectedArchitecture, StructuredIntent, structuredIntentSchema } from './types.js';
import { persistNewVersion } from '../version.service.js';
import { getAppliedChangeLineage, filterAppliedSuggestions, compactGraphForRevision } from './refinement-history.js';

const isDesignGraph = (value: unknown): value is CanonicalDesignGraph =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { nodes?: unknown }).nodes) &&
  Array.isArray((value as { edges?: unknown }).edges) &&
  Array.isArray((value as { powerRails?: unknown }).powerRails) &&
  Array.isArray((value as { bom?: unknown }).bom);
import { Prisma } from '@prisma/client';
import { env } from '../../../config/env.js';

export interface PipelineExecutionOptions {
  forceGenerate?: boolean;
  iterationNotes?: string;
}

export interface PipelineExecutionResult {
  status: 'completed' | 'clarification_needed' | 'already_completed';
  architecture?: ProjectedArchitecture;
  questions?: string[];
}

/** Thrown for failures that must NOT be retried by the queue (deterministic / user-caused). */
export class NonRetryablePipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryablePipelineError';
  }
}

/**
 * Thrown for failures worth one queue-level retry despite not being a ProviderError: the
 * failure stems from a single Sol sample rather than an exhausted schema-retry loop, so a
 * fresh generation attempt has a real chance of producing a valid result.
 */
export class RetryablePipelineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryablePipelineError';
  }
}

type StepStatus = 'running' | 'completed' | 'warning' | 'failed';

/**
 * 7-Step Agentic Embedded Hardware Architecture Generation Pipeline:
 * 1. Intent Parsing (Luna Tier)
 * 2. Sufficiency Gate (Deterministic + Heuristics)
 * 3. Component & Datasheet Grounding (pgvector / RAG)
 * 4. Relational Hardware Synthesis (Sol Tier)
 * 5. Case C Electrical & Topology Validation (Auto-Repair)
 * 6. Diagram Projection (Deterministic Layout matching mockArchitecture.js)
 * 7. Persistence & Real-time Event Streaming
 *
 * Failure semantics: this function THROWS on failure so BullMQ applies its retry/backoff policy.
 * The worker marks the session FAILED only once attempts are exhausted (see ai-pipeline.queue.ts).
 */
export async function runGenerationPipeline(
  sessionId: string,
  options: PipelineExecutionOptions = {}
): Promise<PipelineExecutionResult> {
  const log = logger.child({ sessionId, pipeline: 'ai-generation' });

  const session = await prisma.designSession.findUnique({
    where: { id: sessionId },
    include: { chatMessages: { orderBy: { createdAt: 'asc' }, take: 200 } },
  });

  if (!session) {
    throw new NonRetryablePipelineError('Session not found');
  }

  // Idempotency guard: a retried job for a session that already completed (and is not an
  // explicit iteration) must not re-spend tokens or create a duplicate version.
  if (session.status === 'DONE' && !options.iterationNotes && session.architecture) {
    log.info('Session already DONE; skipping duplicate pipeline run');
    return { status: 'already_completed', architecture: session.architecture as unknown as ProjectedArchitecture };
  }

  const executionSteps: Array<{ stepId: string; label: string; detail?: string; status: StepStatus }> = [];
  const recordStep = (stepId: string, label: string, status: StepStatus, detail?: string) => {
    const existing = executionSteps.find((s) => s.stepId === stepId);
    if (existing) {
      existing.status = status;
      if (detail) existing.detail = detail;
    } else {
      executionSteps.push({ stepId, label, detail, status });
    }
    emitSessionEvent.pipelineStep(sessionId, { stepId, label, detail, status });
  };

  try {
    // Step 1: Reading Intent (Luna Tier)
    recordStep('reading_intent', 'Reading intent', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 1, label: 'Parsing hardware specifications & constraints', progress: 15 });

    await prisma.designSession.update({ where: { id: sessionId }, data: { status: 'PROCESSING' } });

    const conversationHistory = session.chatMessages.map((m) => ({
      role: m.role as 'user' | 'assistant' | 'system',
      content: m.content,
    }));

    // A session whose opening message was rejected (gibberish / off-topic) has no usable brief in
    // intentText — the user's first real brief arrives later as iterationNotes. Parsing and gating
    // the rejected original instead made recovery impossible: the gate re-flagged "asdasd…" as
    // gibberish on every attempt, however clear the new brief was. Promote the new brief to be the
    // session's intent (persisted, so later runs and the title agree). Underspecified-but-real
    // briefs are left alone — their answers build on the original via the conversation history.
    let intentText = session.intentText;
    const openingReply = session.chatMessages.find((m) => m.role === 'assistant');
    const openingMeta = (openingReply?.metadata ?? {}) as { isGibberish?: unknown; isOffTopic?: unknown };
    const openingRejected = isGibberishOrSpam(session.intentText) || openingMeta.isGibberish === true || openingMeta.isOffTopic === true;
    if (!session.architecture && options.iterationNotes && openingRejected && !isGibberishOrSpam(options.iterationNotes)) {
      intentText = options.iterationNotes;
      await prisma.designSession.update({ where: { id: sessionId }, data: { intentText, intentStructured: Prisma.DbNull } });
      log.info('Opening message was rejected; using the first real brief as the session intent');
    }

    let structuredIntent: StructuredIntent;
    const cachedIntent = structuredIntentSchema.safeParse(session.intentStructured);
    if (cachedIntent.success && session.intentStructured && !options.forceGenerate && !options.iterationNotes) {
      structuredIntent = cachedIntent.data;
    } else {
      emitSessionEvent.aiCallStarted(sessionId, 'B');
      const parsedResult = await parseHardwareIntent(intentText, conversationHistory, sessionId);
      structuredIntent = parsedResult.structured;
      emitSessionEvent.aiCallCompleted(sessionId, { taskCase: 'B', schemaPass: true, latencyMs: parsedResult.latencyMs });

      await prisma.designSession.update({
        where: { id: sessionId },
        data: { intentStructured: structuredIntent as unknown as Prisma.InputJsonValue },
      });
    }
    recordStep('reading_intent', 'Reading intent', 'completed');

    // Step 2: Sufficiency Gate
    const sufficiency = checkSufficiency(structuredIntent, intentText);

    if (!sufficiency.sufficient && !options.forceGenerate) {
      log.info(
        { missing: sufficiency.missingFields, isGibberish: sufficiency.isGibberish, isOffTopic: sufficiency.isOffTopic },
        'Sufficiency gate triggered - clarification needed'
      );
      recordStep('reading_intent', 'Clarification required', 'warning', sufficiency.clarificationQuestions[0]);

      // Off-topic gets its own complete, professional message as-is — not the numbered
      // "please clarify the following" wrapper, which only makes sense for genuine hardware
      // requests that are merely underspecified.
      const questionText = sufficiency.isOffTopic
        ? sufficiency.clarificationQuestions[0]
        : `To produce the most accurate hardware architecture, please clarify the following:\n${sufficiency.clarificationQuestions
            .map((q, idx) => `${idx + 1}. ${q}`)
            .join('\n')}`;

      await prisma.$transaction([
        prisma.designSession.update({ where: { id: sessionId }, data: { status: 'CLARIFICATION_REQUIRED' } }),
        prisma.chatMessage.create({
          data: {
            sessionId,
            role: 'assistant',
            content: questionText,
            metadata: {
              clarificationQuestions: sufficiency.clarificationQuestions,
              missingFields: sufficiency.missingFields,
              suggestedDefaults: sufficiency.suggestedDefaults ?? null,
              isOffTopic: sufficiency.isOffTopic ?? false,
              executionSteps,
            } as unknown as Prisma.InputJsonValue,
          },
        }),
      ]);

      emitSessionEvent.clarificationNeeded(sessionId, sufficiency.clarificationQuestions);
      return { status: 'clarification_needed', questions: sufficiency.clarificationQuestions };
    }

    // Architecture-synthesis kill switch (GENERATION_ENABLED in src/config/env.ts). Intent
    // parsing, the sufficiency gate above, and moderation (screened earlier, at the route layer)
    // all still run in full — only the Sol-tier design-graph build and everything downstream of
    // it is withheld. Reuses the existing clarification_needed plumbing so no frontend change is
    // required; the session simply stays in a normal, non-error state until this is re-enabled.
    if (!env.GENERATION_ENABLED) {
      log.info('Architecture synthesis withheld (GENERATION_ENABLED=false)');

      const holdMessage = GENERATION_HOLD_MESSAGE;

      await prisma.$transaction([
        prisma.designSession.update({ where: { id: sessionId }, data: { status: 'CLARIFICATION_REQUIRED' } }),
        prisma.chatMessage.create({
          data: {
            sessionId,
            role: 'assistant',
            content: holdMessage,
            metadata: { executionSteps } as unknown as Prisma.InputJsonValue,
          },
        }),
      ]);

      emitSessionEvent.clarificationNeeded(sessionId, [holdMessage]);
      return { status: 'clarification_needed', questions: [holdMessage] };
    }

    // Step 3: Resolving Modules (RAG + pgvector)
    recordStep('resolving_modules', 'Resolving modules', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 3, label: 'Resolving hardware modules & microcontrollers', progress: 35 });

    const keywords = [
      structuredIntent.deviceType,
      ...(structuredIntent.subsystems?.sensing || []),
      ...(structuredIntent.subsystems?.connectivity || []),
      ...(structuredIntent.subsystems?.power || []),
      ...(structuredIntent.subsystems?.storage || []),
    ].filter((k): k is string => typeof k === 'string' && k.length > 0);

    const grounding = await getGroundingContext(keywords, intentText, sessionId);
    recordStep('resolving_modules', 'Resolving modules', 'completed', `${grounding.datasheetSnippets.length} reference snippets matched`);

    // Step 4: Checking Library Coverage — Sol-tier synthesis
    recordStep('checking_library', 'Checking library coverage', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 4, label: 'Checking footprint library & pinout compatibility', progress: 55 });

    // A refinement revises the ACTIVE design. It used to regenerate from the original intent plus only
    // the latest request, so earlier refinements silently vanished (seen live: "Add battery backup"
    // dropped the ESD protection and Wi-Fi module added two versions earlier, and the chips then
    // offered "Add ESD protection" again). Give Sol the current graph and the full applied lineage.
    const appliedLineage = await getAppliedChangeLineage(sessionId);
    const baselineGraph = isDesignGraph(session.designGraph) ? session.designGraph : null;
    const revision =
      options.iterationNotes && baselineGraph
        ? { baseline: compactGraphForRevision(baselineGraph), appliedChanges: appliedLineage }
        : undefined;

    emitSessionEvent.aiCallStarted(sessionId, 'A');
    const { graph: rawGraph } = await buildCanonicalDesignGraph(structuredIntent, grounding, sessionId, options.iterationNotes, revision);
    emitSessionEvent.aiCallCompleted(sessionId, { taskCase: 'A', schemaPass: true });
    recordStep('checking_library', 'Checking library coverage', 'completed', `Controller: ${rawGraph.controller.partNumber}`);

    // Step 5: Assigning Pins & Electrical Validation (Case C)
    recordStep('assigning_pins', 'Assigning pins', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 5, label: 'Assigning bus interfaces & validating electrical rails', progress: 75 });

    const validation = validateAndRepairDesignGraph(rawGraph);
    if (!validation.isValid) {
      // Critical topology errors (no controller / no rails) cannot be repaired deterministically,
      // but this is a single, un-retried Sol sample (unlike the schema-exhaustion path in
      // design-graph-builder.ts, which has already retried once) — a fresh generation attempt
      // has a real chance of succeeding, so this is explicitly retryable.
      const critical = validation.issues.filter((i) => i.severity === 'error').map((i) => i.code);
      recordStep('assigning_pins', 'Assigning pins', 'failed', `Critical validation errors: ${critical.join(', ')}`);
      throw new RetryablePipelineError(`Design graph failed electrical validation: ${critical.join(', ')}`);
    }
    const finalizedGraph = validation.repairedGraph;
    // Never offer a chip for a change this design already has (including the one just applied).
    finalizedGraph.suggestedRefinements = filterAppliedSuggestions(finalizedGraph.suggestedRefinements, [
      ...appliedLineage,
      ...(options.iterationNotes ? [options.iterationNotes] : []),
    ]);
    if (revision && baselineGraph) {
      const kept = new Set(finalizedGraph.nodes.map((n) => n.id));
      const dropped = baselineGraph.nodes.filter((n) => !kept.has(n.id)).map((n) => n.id);
      if (dropped.length > 0) log.warn({ dropped, request: options.iterationNotes }, 'Refinement removed baseline nodes');
    }
    const warningCount = validation.issues.length;
    recordStep(
      'assigning_pins',
      'Assigning pins',
      warningCount > 0 ? 'warning' : 'completed',
      warningCount > 0
        ? `${finalizedGraph.edges.length} connections routed, ${warningCount} auto-repair(s) applied`
        : `${finalizedGraph.edges.length} connections routed`
    );

    // Step 6: Rendering Diagrams
    recordStep('rendering', 'Rendering', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 6, label: 'Projecting functional, power & protocol diagrams', progress: 90 });

    const projectedArchitecture = projectArchitecture(finalizedGraph);
    projectedArchitecture.validation = {
      isValid: validation.isValid,
      errorCount: validation.issues.filter((i) => i.severity === 'error').length,
      warningCount: validation.issues.filter((i) => i.severity === 'warning').length,
      issues: validation.issues,
    };
    recordStep('rendering', 'Rendering', 'completed');

    // Step 7: Persistence (atomic, serialized per session) & real-time streaming
    emitSessionEvent.stageUpdate(sessionId, { step: 7, label: 'Finalizing system architecture & Bill of Materials', progress: 100 });

    const changeSummary = options.iterationNotes
      ? options.iterationNotes.slice(0, 200)
      : 'Initial architecture generated';
    const appliedChanges: string[] = options.iterationNotes
      ? [options.iterationNotes.slice(0, 500)]
      : ['Initial architecture generated'];

    const { versionTag } = await persistNewVersion({
      sessionId,
      designGraph: finalizedGraph,
      architecture: projectedArchitecture,
      changeSummary,
      appliedChanges,
      sessionStatus: 'DONE',
      buildChatMessage: (tag) => ({
        content: `✨ **Hardware Architecture Synthesized (${tag})**\n\n- **Controller**: ${projectedArchitecture.projectMeta.controller}\n- **Tagline**: ${projectedArchitecture.projectMeta.tagline}\n- **Total BOM Components**: ${projectedArchitecture.bom.length}\n- **Diagrams Generated**: Functional Block, Power Tree, Protocol Map${
          warningCount > 0 ? `\n- **Auto-repairs applied**: ${warningCount}` : ''
        }`,
        metadata: {
          versionTag: tag,
          projectMeta: projectedArchitecture.projectMeta,
          controller: finalizedGraph.controller,
          engineeringDecisions: finalizedGraph.engineeringDecisions ?? [],
          suggestedRefinements: finalizedGraph.suggestedRefinements ?? [],
          validationPass: validation.isValid,
          validationIssues: validation.issues,
          executionSteps,
        },
      }),
    });

    projectedArchitecture.versionTag = versionTag;
    emitSessionEvent.done(sessionId, projectedArchitecture as unknown as Record<string, unknown>);
    log.info({ versionTag }, 'AI generation pipeline & version snapshot successfully saved');

    return { status: 'completed', architecture: projectedArchitecture };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : 'Unknown generation pipeline error';
    log.error({ err }, 'Generation pipeline failed');
    recordStep('pipeline', 'Generation', 'failed', errorMsg);
    if (err instanceof IntentExtractionError || err instanceof DesignGraphSchemaError) {
      throw new NonRetryablePipelineError(errorMsg);
    }
    throw err;
  }
}
