import { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { emitSessionEvent } from '../../realtime/socket.js';
import { hardwareLibraryService } from '../../hardware/hardware-library.service.js';
import { persistNewVersion } from '../version.service.js';
import { GENERATION_HOLD_MESSAGE } from '../pipeline/sufficiency-gate.js';
import { NonRetryablePipelineError, PipelineExecutionOptions, PipelineExecutionResult } from '../pipeline/orchestrator.js';
import { PrototypeResolverError, RESOLVER_TASK_CASE, resolvePrototype, selectCatalogue } from './prototype-resolver.js';
import { assemblePrototype } from './prototype-assembler.js';
import { isPrototypeArchitecture, isPrototypeComposition, PrototypeArchitecture, PrototypeComposition } from './prototype.types.js';

/**
 * Prototype pipeline (plan D5), run by the ai-pipeline worker for sessions of type "prototype".
 * Same step ids, socket events, version snapshots and failure semantics as the Architect pipeline,
 * so the existing chat and progress UI work unchanged:
 *
 *   reading_intent     gather the brief, or the requested change to the current bench
 *   resolving_modules  route R picks a controller + modules from the hardware library
 *   checking_library   needs with no library module become gaps (never substituted)
 *   assigning_pins     deterministic allocator + compatibility rules
 *   rendering          module diagram geometry, detailed pin list, hardware library entries
 */

type StepStatus = 'running' | 'completed' | 'warning' | 'failed';

const LLM_HISTORY_TURNS = 12;

export async function runPrototypePipeline(sessionId: string, options: PipelineExecutionOptions = {}): Promise<PipelineExecutionResult> {
  const log = logger.child({ sessionId, pipeline: 'prototype' });

  const session = await prisma.designSession.findUnique({
    where: { id: sessionId },
    include: { chatMessages: { orderBy: { createdAt: 'asc' }, take: 200 } },
  });
  if (!session) throw new NonRetryablePipelineError('Session not found');

  const current = isPrototypeArchitecture(session.architecture) ? session.architecture : null;
  const currentComposition = isPrototypeComposition(session.designGraph) ? session.designGraph : null;

  // Idempotency: a retried job for a finished session must not spend tokens or add a version.
  if (session.status === 'DONE' && !options.iterationNotes && current) {
    log.info('Prototype session already DONE; skipping duplicate pipeline run');
    return { status: 'already_completed', architecture: current as unknown as PipelineExecutionResult['architecture'] };
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

  /** Ends the run without a new version: a reply the user can answer, design (if any) unchanged. */
  const replyWithoutDesign = async (content: string, metadata: Record<string, unknown>): Promise<PipelineExecutionResult> => {
    await prisma.$transaction([
      prisma.designSession.update({
        where: { id: sessionId },
        // A bench that already exists stays the active design; only a project with none waits on the user.
        data: { status: current ? 'DONE' : 'CLARIFICATION_REQUIRED' },
      }),
      prisma.chatMessage.create({
        data: {
          sessionId,
          role: 'assistant',
          content,
          metadata: { clarificationQuestions: [content], executionSteps, ...metadata } as unknown as Prisma.InputJsonValue,
        },
      }),
    ]);
    emitSessionEvent.clarificationNeeded(sessionId, [content]);
    return { status: 'clarification_needed', questions: [content] };
  };

  try {
    // Step 1: what is being asked for.
    recordStep('reading_intent', 'Reading intent', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 1, label: 'Reading what you want to build', progress: 15 });
    await prisma.designSession.update({ where: { id: sessionId }, data: { status: 'PROCESSING' } });

    const turns = session.chatMessages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content.slice(0, 2000) }));
    const lastVersionCard = session.chatMessages.reduce((last, m, i) => {
      const meta = (m.metadata ?? {}) as { versionTag?: unknown };
      return m.role === 'assistant' && typeof meta.versionTag === 'string' ? i : last;
    }, -1);
    const userTurnsSinceCard = session.chatMessages
      .slice(lastVersionCard + 1)
      .filter((m) => m.role === 'user' && m.content.trim())
      .map((m) => m.content.trim());
    const revisionNotes = current && userTurnsSinceCard.length > 0 ? [...new Set(userTurnsSinceCard)].join('\n') : undefined;
    // First build: the brief plus every answer since; refinement: just the requested change.
    const requestText = revisionNotes ?? ([...new Set([session.intentText, ...userTurnsSinceCard])].join('\n').slice(0, 4000) || session.intentText);
    recordStep('reading_intent', 'Reading intent', 'completed');

    if (!env.PROTOTYPE_ENABLED) {
      recordStep('resolving_modules', 'Resolving modules', 'warning', 'Prototype mode is turned off');
      return await replyWithoutDesign('Prototype mode is turned off on this server right now, so I can’t assemble a bench. Architect mode is still available in a new project.', {});
    }
    if (!env.GENERATION_ENABLED) {
      log.info('Prototype generation withheld (GENERATION_ENABLED=false)');
      return await replyWithoutDesign(GENERATION_HOLD_MESSAGE, {});
    }

    // Step 2: choose modules from the library.
    recordStep('resolving_modules', 'Resolving modules', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 2, label: 'Choosing modules from the hardware library', progress: 35 });
    const library = await hardwareLibraryService.listEligible(sessionId);
    if (library.length === 0) {
      log.warn({ allowProvisional: env.PROTOTYPE_ALLOW_PROVISIONAL }, 'Prototype library has no eligible boards');
      recordStep('resolving_modules', 'Resolving modules', 'warning', 'No eligible boards in the hardware library');
      return await replyWithoutDesign(
        'The hardware library has no boards available for prototyping yet — every board is still waiting for review. I can’t assemble a bench without real modules, and I won’t invent one. Please try again once the library has been reviewed.',
        { prototypeLibraryEmpty: true }
      );
    }

    const keepIds = currentComposition
      ? [currentComposition.controller?.hardwareEntityId, ...currentComposition.modules.map((m) => m.hardwareEntityId)].filter((id): id is string => Boolean(id))
      : [];
    const catalogue = selectCatalogue(library, `${requestText}\n${turns.slice(-4).map((t) => t.content).join('\n')}`, keepIds);

    emitSessionEvent.aiCallStarted(sessionId, RESOLVER_TASK_CASE);
    const { output, latencyMs } = await resolvePrototype({
      requestText,
      history: turns.slice(-LLM_HISTORY_TURNS - 1, -1),
      catalogue,
      current: currentComposition,
      sessionId,
    });
    emitSessionEvent.aiCallCompleted(sessionId, { taskCase: RESOLVER_TASK_CASE, schemaPass: true, latencyMs });

    const prototypeGaps = output.gaps.map((g, i) => ({ gapId: `g${i + 1}`, ...g }));
    if (!output.isPrototypeRequest || !output.controller) {
      recordStep('resolving_modules', 'Resolving modules', 'warning', output.isPrototypeRequest ? 'No suitable controller in the library' : 'Not a prototype request');
      const gapLines = prototypeGaps.map((g) => `- **${g.category}**: ${g.need}${g.suggestion ? ` (e.g. ${g.suggestion})` : ''}`);
      const content = [
        output.understanding || 'I couldn’t turn that into a bench prototype.',
        gapLines.length > 0 ? `\n**Not in the library:**\n${gapLines.join('\n')}` : null,
        output.isPrototypeRequest ? null : '\nDescribe the device you want to prototype — e.g. “Pico W weather station with a BME280” — and I’ll pick the modules and wire them.',
      ]
        .filter(Boolean)
        .join('\n');
      return await replyWithoutDesign(content, { prototypeGaps, isPrototypeRequest: output.isPrototypeRequest });
    }

    const controllerRationale = output.controller.role ?? null;
    const composition: PrototypeComposition = {
      kind: 'prototype_composition',
      controller: { instanceId: 'mcu', hardwareEntityId: output.controller.hardwareEntityId },
      modules: output.modules.map((m) => ({ instanceId: m.instanceId, hardwareEntityId: m.hardwareEntityId, role: m.role, links: m.links })),
      gaps: output.gaps,
    };
    recordStep('resolving_modules', 'Resolving modules', 'completed', `${composition.modules.length + 1} module(s) selected`);

    // Step 3: library coverage.
    recordStep('checking_library', 'Checking library coverage', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 3, label: 'Checking library coverage', progress: 50 });
    recordStep(
      'checking_library',
      'Checking library coverage',
      prototypeGaps.length > 0 ? 'warning' : 'completed',
      prototypeGaps.length > 0 ? `${prototypeGaps.length} need(s) not in the library: ${prototypeGaps.map((g) => g.need).join('; ')}` : 'Every need is covered'
    );

    // Steps 4 + 5: pins, rules, geometry, pin list, library entries (one deterministic pass).
    recordStep('assigning_pins', 'Assigning pins', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 4, label: 'Assigning pins and checking compatibility', progress: 70 });
    const entities = new Map(library.map((e) => [e.hardwareEntityId, e]));
    const payload = assemblePrototype(composition, entities, {
      allowProvisional: env.PROTOTYPE_ALLOW_PROVISIONAL,
      svgBasePath: `${env.API_PREFIX}/hardware/entities`,
      projectName: session.title ?? 'Prototype',
      understanding: output.understanding,
      notes: output.notes,
    });
    const counts = payload.compatibility.counts;
    const cables = payload.connections.filter((c) => c.kind === 'cable').length;
    const wires = payload.connections.length - cables;
    recordStep(
      'assigning_pins',
      'Assigning pins',
      counts.BLOCKER + counts.UNKNOWN > 0 ? 'warning' : 'completed',
      `${payload.nets.length} nets, ${wires} wire(s), ${cables} cable(s) · ${counts.BLOCKER} blocker(s), ${counts.WARNING} warning(s), ${counts.UNKNOWN} unknown`
    );

    recordStep('rendering', 'Rendering', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 5, label: 'Drawing the module diagram and pin list', progress: 90 });
    recordStep('rendering', 'Rendering', 'completed', `${payload.pinList.summary.rows} pin rows`);

    // Persist (atomic, serialized per session) and announce.
    emitSessionEvent.stageUpdate(sessionId, { step: 6, label: 'Saving the prototype version', progress: 100 });
    const changeSummary = revisionNotes ? revisionNotes.slice(0, 200) : 'Initial prototype assembled';
    const { versionTag } = await persistNewVersion({
      sessionId,
      designGraph: composition,
      architecture: payload,
      changeSummary,
      appliedChanges: [revisionNotes ? revisionNotes.slice(0, 500) : 'Initial prototype assembled'],
      sessionStatus: 'DONE',
      buildChatMessage: (tag) => ({
        content: summaryMessage(payload, tag, env.PROTOTYPE_ALLOW_PROVISIONAL),
        metadata: {
          versionTag: tag,
          prototypeVersionTag: tag,
          sessionType: 'prototype',
          projectMeta: payload.projectMeta,
          controller: { name: payload.projectMeta.controller, partNumber: composition.controller?.hardwareEntityId ?? null, rationale: controllerRationale },
          engineeringDecisions: decisionsFor(payload),
          suggestedRefinements: [],
          prototypeGaps: payload.gaps,
          prototypeSummary: {
            modules: payload.instances.length,
            nets: payload.nets.length,
            wires,
            cables,
            pinRows: payload.pinList.summary,
            compatibility: counts,
          },
          validationPass: counts.BLOCKER === 0,
          executionSteps,
        },
      }),
    });

    payload.versionTag = versionTag;
    emitSessionEvent.done(sessionId, payload as unknown as Record<string, unknown>);
    log.info({ versionTag, modules: payload.instances.length, gaps: payload.gaps.length, counts }, 'Prototype version saved');
    return { status: 'completed', architecture: payload as unknown as PipelineExecutionResult['architecture'] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown prototype pipeline error';
    log.error({ err }, 'Prototype pipeline failed');
    recordStep('pipeline', 'Generation', 'failed', message);
    if (err instanceof PrototypeResolverError) throw new NonRetryablePipelineError(message);
    throw err;
  }
}

/** Short, factual card text: what was placed, how it connects, and what is not in the library. */
function summaryMessage(payload: PrototypeArchitecture, tag: string, devOverride: boolean): string {
  const modules = payload.instances.filter((i) => !i.isController).map((i) => `${i.label} (${i.instanceId})`);
  const cables = payload.connections.filter((c) => c.kind === 'cable').length;
  const wires = payload.connections.length - cables;
  const { summary } = payload.pinList;
  const counts = payload.compatibility.counts;
  const unreviewed = payload.instances.some((i) => i.reviewStatus !== 'confirmed' || i.assetReadiness !== 'wiring_ready');
  return [
    `🧩 **Prototype bench assembled (${tag})**`,
    '',
    `- **Controller**: ${payload.projectMeta.controller}`,
    `- **Modules**: ${modules.length > 0 ? modules.join(', ') : 'none'}`,
    `- **Connections**: ${wires} jumper wire(s)${cables > 0 ? `, ${cables} STEMMA QT / Qwiic cable(s)` : ''}`,
    `- **Pin list**: ${summary.rows} contacts · ${summary.assigned + summary.proposed} connected · ${summary.blocking} blocking`,
    `- **Checks**: ${counts.PASS} pass · ${counts.WARNING} warning · ${counts.BLOCKER} blocker · ${counts.UNKNOWN} unknown`,
    payload.gaps.length > 0 ? `- **Not in library**: ${payload.gaps.map((g) => `${g.category} — ${g.need}`).join('; ')}` : null,
    unreviewed
      ? devOverride
        ? '- ⚠️ Some boards are not reviewed yet: their wiring is shown dashed and must be checked against the board before use.'
        : '- ⚠️ Some boards are awaiting wiring review: their connections are listed but not drawn.'
      : null,
    payload.notes ? `\n${payload.notes}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

function decisionsFor(payload: PrototypeArchitecture): string[] {
  const out: string[] = [];
  for (const c of payload.connections.filter((x) => x.kind === 'cable')) {
    const from = payload.instances.find((i) => i.instanceId === c.from.instanceId)?.label ?? c.from.instanceId;
    const to = payload.instances.find((i) => i.instanceId === c.to.instanceId)?.label ?? c.to.instanceId;
    out.push(`${from} → ${to} over a STEMMA QT / Qwiic cable`);
  }
  for (const r of payload.compatibility.results.filter((x) => x.status === 'BLOCKER' || x.status === 'UNKNOWN')) {
    out.push(`${r.status === 'BLOCKER' ? 'Blocker' : 'Unknown'}: ${r.message}`);
  }
  return out.slice(0, 6);
}
