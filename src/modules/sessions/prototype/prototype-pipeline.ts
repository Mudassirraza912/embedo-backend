import { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { emitSessionEvent } from '../../realtime/socket.js';
import { hardwareLibraryService } from '../../hardware/hardware-library.service.js';
import { persistNewVersion } from '../version.service.js';
import { GENERATION_HOLD_MESSAGE } from '../pipeline/sufficiency-gate.js';
import { NonRetryablePipelineError, PipelineExecutionOptions, PipelineExecutionResult } from '../pipeline/orchestrator.js';
import { catalogueLine, PrototypeResolverError, RESOLVER_TASK_CASE, resolvePrototype, retrieveCatalogue } from './prototype-resolver.js';
import { SOURCING_TASK_CASE, sourceHardware, SourcingResult } from '../../hardware/discovery/hardware-sourcer.js';
import { assemblePrototype } from './prototype-assembler.js';
import { filterAppliedSuggestions, getAppliedChangeLineage } from '../pipeline/refinement-history.js';
import { isPrototypeArchitecture, isPrototypeComposition, PrototypeArchitecture, PrototypeComposition } from './prototype.types.js';
import { describeBench, diffBenches } from './prototype-diff.js';

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
    let library = await hardwareLibraryService.listEligible(sessionId);
    const keepIds = currentComposition
      ? [currentComposition.controller?.hardwareEntityId, ...currentComposition.modules.map((m) => m.hardwareEntityId)].filter((id): id is string => Boolean(id))
      : [];
    const retrievalText = `${requestText}\n${turns.slice(-4).map((t) => t.content).join('\n')}`;
    const resolve = async () => {
      const catalogue = await retrieveCatalogue(library, retrievalText, keepIds);
      emitSessionEvent.aiCallStarted(sessionId, RESOLVER_TASK_CASE);
      const resolved = await resolvePrototype({
        requestText,
        history: turns.slice(-LLM_HISTORY_TURNS - 1, -1),
        catalogue,
        current: currentComposition,
        currentBench: current ? describeBench(current) : null,
        sessionId,
      });
      emitSessionEvent.aiCallCompleted(sessionId, { taskCase: RESOLVER_TASK_CASE, schemaPass: true, latencyMs: resolved.latencyMs });
      return resolved.output;
    };

    // Without any controller in the library the resolver cannot build anything; go straight to sourcing.
    let output = library.some((e) => e.isController) ? await resolve() : null;
    // Declared via a cast so the closures and loop below see the full type, not the initial null.
    let sourcing = null as SourcingResult | null;

    // Library gaps are filled from vendor product pages: the boards found are private to this
    // project (drawn as unverified) and queued for admin review before anyone else can use them.
    // Up to two rounds: the second one fills gaps the first resolve still reported.
    const MAX_SOURCING_ROUNDS = 2;
    for (let round = 1; round <= MAX_SOURCING_ROUNDS && env.PROTOTYPE_SOURCING_ENABLED; round++) {
      const needsSourcing = !output || (output.isPrototypeRequest && (output.gaps.length > 0 || !output.controller));
      if (!needsSourcing) break;
      recordStep('checking_library', 'Checking library coverage', 'running', 'Searching vendor sites for modules the library is missing');
      emitSessionEvent.stageUpdate(sessionId, { step: 3, label: 'Sourcing missing modules from vendor sites', progress: round === 1 ? 45 : 60 });
      emitSessionEvent.aiCallStarted(sessionId, SOURCING_TASK_CASE);
      let roundResult: SourcingResult | null = null;
      try {
        roundResult = await sourceHardware({
          sessionId,
          requestText,
          library,
          catalogueLines: library.slice(0, 80).map(catalogueLine),
          gaps: output?.gaps ?? [],
          needController: !output?.controller,
          exclude: sourcing?.sourced.map((b) => `${b.productName} (${b.vendor})`) ?? [],
        });
      } catch (err) {
        log.warn({ err, round }, 'Hardware sourcing failed; continuing with the library only');
      }
      emitSessionEvent.aiCallCompleted(sessionId, { taskCase: SOURCING_TASK_CASE, schemaPass: Boolean(roundResult) });
      if (!roundResult) break;
      const previous: SourcingResult | null = sourcing;
      sourcing = previous
        ? {
            ...previous,
            sourced: [...previous.sourced, ...roundResult.sourced],
            entities: [...previous.entities, ...roundResult.entities],
            failures: [...previous.failures, ...roundResult.failures],
          }
        : roundResult;
      log.info({ round, sourced: roundResult.sourced.map((b) => `${b.hardwareEntityId}:${b.factsSource}`), failures: roundResult.failures }, 'Hardware sourcing round finished');
      if (!roundResult.isPrototypeRequest || roundResult.entities.length === 0) break;
      library = [...library, ...roundResult.entities.filter((e) => !library.some((l) => l.hardwareEntityId === e.hardwareEntityId))];
      output = await resolve();
    }

    if (!output) {
      const notPrototype = Boolean(sourcing && !sourcing.isPrototypeRequest);
      recordStep('resolving_modules', 'Resolving modules', 'warning', notPrototype ? 'Not a prototype request' : 'No boards available');
      return await replyWithoutDesign(
        notPrototype
          ? `${sourcing?.understanding || 'That does not read as a prototype request.'}\n\nDescribe the device you want to prototype, e.g. "Pico W weather station with a BME280", and I will pick the modules and wire them.`
          : 'I could not find boards for this yet: the hardware library has none that fit, and I could not source a suitable module from the vendor sites this time. Try naming the controller or modules you want (e.g. "Raspberry Pi Pico with a BME280"), or try again shortly.',
        { prototypeLibraryEmpty: library.length === 0, ...(sourcing ? { sourcingFailures: sourcing.failures } : {}) }
      );
    }

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
    emitSessionEvent.stageUpdate(sessionId, { step: 3, label: 'Checking library coverage', progress: 55 });
    const sourcedCount = sourcing?.sourced.length ?? 0;
    recordStep(
      'checking_library',
      'Checking library coverage',
      prototypeGaps.length > 0 ? 'warning' : 'completed',
      [
        sourcedCount > 0 ? `${sourcedCount} module(s) sourced from vendor sites (unverified, sent for review)` : null,
        prototypeGaps.length > 0 ? `${prototypeGaps.length} need(s) still not covered: ${prototypeGaps.map((g) => g.need).join('; ')}` : 'Every need is covered',
      ]
        .filter(Boolean)
        .join(' · ')
    );

    // Steps 4 + 5: pins, rules, geometry, pin list, library entries (one deterministic pass).
    recordStep('assigning_pins', 'Assigning pins', 'running');
    emitSessionEvent.stageUpdate(sessionId, { step: 4, label: 'Assigning pins and checking compatibility', progress: 70 });
    const entities = new Map(library.map((e) => [e.hardwareEntityId, e]));
    const payload = assemblePrototype(composition, entities, {
      // Unreviewed wiring (sourced or provisional boards) is drawn dashed and labelled, never hidden:
      // the user asked to see the bench, and the dashed style + warnings say it is not verified.
      allowProvisional: true,
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

    // A revision is described by what actually changed in the graph, never by the request text.
    // When nothing changed, no version is saved and the chat says so: "Updated the bench" on an
    // identical bench is exactly the false success this must never report.
    const diff = current && revisionNotes ? diffBenches(current, payload) : null;
    if (diff && !diff.changed) {
      log.info('Prototype revision produced an identical bench; no version saved');
      // Most serious first; UNKNOWN matters here (a supply missing from a record is exactly why a
      // module cannot be rewired), and power problems lead because most corrections are about power.
      const rank = { BLOCKER: 0, UNKNOWN: 1, WARNING: 2, PASS: 3 } as const;
      const open = payload.compatibility.results
        .filter((r) => r.status !== 'PASS' && r.ruleType !== 'dependency_presence')
        .sort((a, b) => rank[a.status] - rank[b.status] || Number(b.ruleType === 'required_power_rail') - Number(a.ruleType === 'required_power_rail'))
        .slice(0, 4);
      const power = payload.nets.filter((n) => n.class === 'power').map((n) => `- ${n.name}: ${n.members.map((m) => `${m.instanceId}.${m.pinName}`).join(' ↔ ')}`);
      const content = [
        `**No change to the bench.** I re-ran your request against the hardware library and the wiring rules, and the result is identical to ${current?.versionTag ?? 'the current version'}, so I did not save a new version.`,
        output.understanding ? `\nWhat I understood: ${output.understanding}` : null,
        power.length > 0 ? `\nPower wiring as it stands:\n${power.join('\n')}` : null,
        open.length > 0 ? `\nWhat still stands in the way:\n${open.map((r) => `- ${r.message}`).join('\n')}` : null,
        '\nTell me the specific change, e.g. which module to add or swap, or which board should power which.',
      ]
        .filter(Boolean)
        .join('\n');
      recordStep('rendering', 'Rendering', 'warning', 'No change to the bench');
      return await replyWithoutDesign(content, { prototypeNoChange: true, sessionType: 'prototype' });
    }
    const changesApplied = diff?.lines.slice(0, 12) ?? [];

    // Persist (atomic, serialized per session) and announce.
    emitSessionEvent.stageUpdate(sessionId, { step: 6, label: 'Saving the prototype version', progress: 100 });
    const changeSummary = changesApplied.length > 0 ? changesApplied.join('; ').slice(0, 200) : 'Initial prototype assembled';
    // Quick-refinement chips, minus anything this bench already received (same rule as Architect).
    const appliedLineage = await getAppliedChangeLineage(sessionId);
    const quickRefinements = filterAppliedSuggestions(output.suggestedRefinements, [...appliedLineage, ...(revisionNotes ? [revisionNotes] : [])]).slice(0, 5);
    const { versionTag } = await persistNewVersion({
      sessionId,
      designGraph: composition,
      architecture: payload,
      changeSummary,
      // The request is kept first so quick-refinement filtering still sees what was asked for.
      appliedChanges: revisionNotes ? [revisionNotes.slice(0, 500), ...changesApplied] : ['Initial prototype assembled'],
      sessionStatus: 'DONE',
      buildChatMessage: (tag) => ({
        content: summaryMessage(payload, tag, sourcing, changesApplied),
        metadata: {
          versionTag: tag,
          prototypeVersionTag: tag,
          sessionType: 'prototype',
          changesApplied,
          projectMeta: payload.projectMeta,
          controller: { name: payload.projectMeta.controller, partNumber: composition.controller?.hardwareEntityId ?? null, rationale: controllerRationale },
          engineeringDecisions: decisionsFor(payload),
          suggestedRefinements: quickRefinements,
          prototypeGaps: payload.gaps,
          prototypeSourced: sourcing?.sourced ?? [],
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
function summaryMessage(payload: PrototypeArchitecture, tag: string, sourcing: SourcingResult | null, changes: string[] = []): string {
  const modules = payload.instances.filter((i) => !i.isController).map((i) => `${i.label} (${i.instanceId})`);
  const cables = payload.connections.filter((c) => c.kind === 'cable').length;
  const wires = payload.connections.length - cables;
  const { summary } = payload.pinList;
  const counts = payload.compatibility.counts;
  const unreviewed = payload.instances.some((i) => i.reviewStatus !== 'confirmed' || i.assetReadiness !== 'wiring_ready');
  return [
    `🧩 **Prototype bench assembled (${tag})**`,
    '',
    changes.length > 0 ? `**What changed**\n${changes.map((c) => `- ${c}`).join('\n')}\n` : null,
    `- **Controller**: ${payload.projectMeta.controller}`,
    `- **Modules**: ${modules.length > 0 ? modules.join(', ') : 'none'}`,
    `- **Connections**: ${wires} jumper wire(s)${cables > 0 ? `, ${cables} STEMMA QT / Qwiic cable(s)` : ''}`,
    `- **Pin list**: ${summary.rows} contacts · ${summary.assigned + summary.proposed} connected · ${summary.blocking} blocking`,
    `- **Checks**: ${counts.PASS} pass · ${counts.WARNING} warning · ${counts.BLOCKER} blocker · ${counts.UNKNOWN} unknown`,
    payload.gaps.length > 0 ? `- **Not in library**: ${payload.gaps.map((g) => `${g.category} — ${g.need}`).join('; ')}` : null,
    sourcing && sourcing.sourced.length > 0
      ? `- **Sourced for this project** (not in the library yet, sent to admin review): ${sourcing.sourced
          .map((b) => `${b.productName} (${b.factsSource === 'vendor_page' ? 'pinout read from the vendor page' : 'pinout from model knowledge, unverified'})`)
          .join('; ')}`
      : null,
    unreviewed ? '- ⚠️ Boards awaiting review are drawn with dashed wiring: check every connection against the board before powering up.' : null,
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
  const blockers = payload.compatibility.counts.BLOCKER;
  if (blockers > 0) out.push(`${blockers} blocker${blockers > 1 ? 's' : ''} to resolve — see Checks on the module diagram`);
  return out.slice(0, 4);
}
