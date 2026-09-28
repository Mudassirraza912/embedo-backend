import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { routeMessage } from '../../src/modules/sessions/conversation-router.service.js';
import { buildCanonicalDesignGraph, DesignGraphSchemaError } from '../../src/modules/sessions/pipeline/design-graph-builder.js';
import { validateAndRepairDesignGraph } from '../../src/modules/sessions/pipeline/validator.js';
import { getAppliedChangeLineage, filterAppliedSuggestions, isSameChange } from '../../src/modules/sessions/pipeline/refinement-history.js';
import type { CanonicalDesignGraph, StructuredIntent } from '../../src/modules/sessions/pipeline/types.js';
import type { GroundingContext } from '../../src/modules/sessions/pipeline/rag-grounder.js';

type ExecuteTask = typeof aiRouterService.executeTask;

const aiResult = (content: string) => ({
  content,
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 0,
  latencyMs: 10,
  costUsd: 0.0001,
  schemaPass: true,
  provider: 'openai',
  model: 'gpt-4o',
  aiCallId: 'call-1',
});

const history = [
  { role: 'user' as const, content: 'IoT socket to switch a water motor with a relay' },
  { role: 'assistant' as const, content: 'Architecture generated successfully!' },
];

describe('routeMessage — design-change follow-ups are never rejected as off-topic', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each(['Implement solar charging', 'Add power monitoring', 'Include temperature sensor', 'please integrate Bluetooth connectivity'])(
    'overrides off_topic -> generate for "%s" inside a conversation',
    async (message) => {
      jest
        .spyOn(aiRouterService, 'executeTask')
        .mockResolvedValue(aiResult(JSON.stringify({ mode: 'off_topic', projectTitle: '', isGibberish: false, reply: 'Embedo focuses on hardware.' })));
      const result = await routeMessage(message, 'session-1', history);
      expect(result.mode).toBe('generate');
      expect(result.reply).toBe('');
    }
  );

  it('does not override a genuinely off-topic message', async () => {
    jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValue(aiResult(JSON.stringify({ mode: 'off_topic', projectTitle: '', isGibberish: false, reply: 'Embedo focuses on hardware.' })));
    const result = await routeMessage('tell me a joke about cats', 'session-1', history);
    expect(result.mode).toBe('off_topic');
  });

  it('does not override on the very first message (no conversation yet)', async () => {
    jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValue(aiResult(JSON.stringify({ mode: 'off_topic', projectTitle: '', isGibberish: false, reply: 'Embedo focuses on hardware.' })));
    const result = await routeMessage('Add some fun to my weekend', 'session-1', []);
    expect(result.mode).toBe('off_topic');
  });

  it('does not override gibberish', async () => {
    jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValue(aiResult(JSON.stringify({ mode: 'off_topic', projectTitle: '', isGibberish: true, reply: "Couldn't read that." })));
    const result = await routeMessage('add qwxzvbnmplk', 'session-1', history);
    expect(result.mode).toBe('off_topic');
  });

  it('classifies at a low, stable temperature', async () => {
    const spy = jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValue(aiResult(JSON.stringify({ mode: 'generate', projectTitle: '', isGibberish: false, reply: '' })));
    await routeMessage('Add power monitoring', 'session-1', history);
    const call = spy.mock.calls[0]?.[0] as Parameters<ExecuteTask>[0];
    expect(call.temperature).toBeLessThanOrEqual(0.4);
  });
});

describe('buildCanonicalDesignGraph — near-miss enum values', () => {
  afterEach(() => jest.restoreAllMocks());

  const intent = {} as unknown as StructuredIntent;
  const grounding = { datasheetSnippets: [], designGuidelines: [] } as unknown as GroundingContext;
  const graph = (category: string, edgeType: string) =>
    JSON.stringify({
      projectMeta: { name: 'Smart Socket', tagline: 't', controller: 'ESP32-S3-MINI-1' },
      controller: { partNumber: 'ESP32-S3-MINI-1', manufacturer: 'Espressif', rationale: 'r' },
      nodes: [
        { id: 'mcu', label: 'MCU', sublabel: 'ESP32', category: 'control', partNumber: 'ESP32-S3-MINI-1' },
        { id: 'relay', label: 'Relay', sublabel: 'G5LE', category, partNumber: 'G5LE-1A' },
      ],
      edges: [{ from: 'mcu', to: 'relay', label: 'drive', type: edgeType }],
      powerRails: [],
      bom: [],
    });

  it('maps "actuation" -> "motor" and "PWM" -> "gpio" instead of failing the whole generation', async () => {
    const spy = jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(aiResult(graph('actuation', 'PWM')));
    const { graph: g } = await buildCanonicalDesignGraph(intent, grounding, 'session-1');
    expect(g.nodes[1]?.category).toBe('motor');
    expect(g.edges[0]?.type).toBe('gpio');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries with the concrete schema problems in the prompt, then fails if still invalid', async () => {
    jest.spyOn(aiRouterService, 'markSchemaResult').mockResolvedValue(undefined as never);
    const spy = jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(aiResult(graph('teleportation', 'gpio')));
    await expect(buildCanonicalDesignGraph(intent, grounding, 'session-1')).rejects.toBeInstanceOf(DesignGraphSchemaError);
    expect(spy).toHaveBeenCalledTimes(2);
    const retryPrompt = (spy.mock.calls[1]?.[0] as Parameters<ExecuteTask>[0]).userPrompt;
    expect(retryPrompt).toContain('CORRECTION');
    expect(retryPrompt).toContain('nodes.1.category');
  });
});

describe('validateAndRepairDesignGraph — controller filed under another category', () => {
  const base = (mcuCategory: string, controllerPart = 'ESP32-S3-MINI-1'): CanonicalDesignGraph =>
    ({
      projectMeta: { name: 'Smart Socket', tagline: 't', controller: controllerPart },
      controller: { partNumber: controllerPart, manufacturer: 'Espressif', rationale: 'r' },
      nodes: [
        { id: 'esp', label: 'Wi-Fi SoC', sublabel: 'ESP32-S3', category: mcuCategory, partNumber: 'ESP32-S3-MINI-1-N8' },
        { id: 'relay', label: 'Relay', sublabel: 'G5LE', category: 'motor', partNumber: 'G5LE-1A' },
      ],
      edges: [{ from: 'esp', to: 'relay', label: 'drive', type: 'gpio' }],
      powerRails: [],
      bom: [],
    }) as unknown as CanonicalDesignGraph;

  it('repairs the declared controller\'s category instead of failing NO_CONTROLLER_NODE', () => {
    const report = validateAndRepairDesignGraph(base('connectivity'));
    expect(report.issues.some((i) => i.code === 'NO_CONTROLLER_NODE')).toBe(false);
    expect(report.issues.some((i) => i.code === 'CONTROLLER_CATEGORY_REPAIRED' && i.nodeId === 'esp')).toBe(true);
    expect(report.repairedGraph.nodes.find((n) => n.id === 'esp')?.category).toBe('control');
  });

  it('still fails when no node can be identified as the controller', () => {
    const report = validateAndRepairDesignGraph(base('connectivity', 'STM32F411CEU6'));
    expect(report.issues.some((i) => i.code === 'NO_CONTROLLER_NODE')).toBe(true);
  });
});

describe('refinement history — applied changes are not suggested again', () => {
  it('treats verb, plural and word-order variants as the same change', () => {
    expect(isSameChange('Add ESD protection', 'Include ESD protection')).toBe(true);
    expect(isSameChange('Add battery backup', 'Add a battery backup')).toBe(true);
    expect(isSameChange('Add ESD protection', 'Include ESD protections for USB')).toBe(true);
    expect(isSameChange('Add battery backup', 'Include Bluetooth connectivity')).toBe(false);
    expect(isSameChange('Enhance power measurement accuracy', 'Include power monitoring')).toBe(false);
  });

  it('drops suggestions already applied in the lineage, and duplicates within the list', () => {
    const applied = ['Include ESD protection', 'Add battery backup'];
    const out = filterAppliedSuggestions(
      ['Add ESD protection', 'Include Bluetooth connectivity', 'Add a battery backup', 'Add user interface', 'Integrate Bluetooth connectivity'],
      applied
    );
    expect(out).toEqual(['Include Bluetooth connectivity', 'Add user interface']);
  });

  it('follows restores: refinements made after the restored version leave the lineage', async () => {
    const { prisma } = await import('../../src/db/prisma.js');
    jest.spyOn(prisma.sessionVersion, 'findMany').mockResolvedValue([
      { versionTag: 'v1.0', appliedChanges: ['Initial architecture generated'] },
      { versionTag: 'v1.1', appliedChanges: ['Include ESD protection'] },
      { versionTag: 'v1.2', appliedChanges: ['Add battery backup'] },
      { versionTag: 'v1.3', appliedChanges: ['Restored snapshot from v1.1'] },
      { versionTag: 'v1.4', appliedChanges: ['Add status LED'] },
    ] as never);
    await expect(getAppliedChangeLineage('s1')).resolves.toEqual(['Include ESD protection', 'Add status LED']);
    jest.restoreAllMocks();
  });
});
