import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { StructuredIntent } from '../../src/modules/sessions/pipeline/types.js';
import { buildCanonicalDesignGraph } from '../../src/modules/sessions/pipeline/design-graph-builder.js';
import { aiRouterService, ExecuteTaskResult } from '../../src/modules/ai/ai-router.service.js';
import { GroundingContext } from '../../src/modules/sessions/pipeline/rag-grounder.js';

describe('Architect Dynamic Engine — Specification Fidelity & Raw Brief Preservation', () => {
  afterEach(() => jest.restoreAllMocks());

  const mockGraphJson = JSON.stringify({
    projectMeta: { name: 'Industrial Node', tagline: 'Monitoring', controller: 'STM32L431' },
    controller: { partNumber: 'STM32L431', manufacturer: 'STMicroelectronics', rationale: 'Ultra-low power M4 MCU' },
    nodes: [
      { id: 'mcu', label: 'MCU', sublabel: 'Cortex-M4', category: 'control', partNumber: 'STM32L431' },
      { id: 'battery', label: 'Li-SOCl2 D-Cell', sublabel: '3.6V nominal', category: 'power', partNumber: 'TL-5930' },
    ],
    edges: [{ from: 'battery', to: 'mcu', label: '3.3V', type: 'power' }],
    powerRails: [{ name: '3.3V', voltageV: 3.3, source: 'battery', consumers: ['mcu'] }],
    bom: [],
    engineeringDecisions: ['Duty cycle proof: 7.2 years runtime on 38000 mAh'],
    suggestedRefinements: ['Add external watchdog'],
  });

  it('embeds the full untruncated rawBrief into the Sol synthesizer prompt without lossy compression', async () => {
    const rawBrief = 'Design an ultra-low-power industrial sensor node with 2x Li-SOCl2 D-cells (38,000 mAh), HPC pulse capacitor, LoRaWAN SX1262, GNSS, NFC, and 3-wire PT100 RTD with 24-bit delta-sigma ADC.';
    const mockIntent: StructuredIntent = {
      deviceType: 'environmental monitor',
      purpose: 'industrial sensor node',
      subsystems: { sensing: ['temperature'], connectivity: ['lora'], power: ['battery'], storage: null, ui: null, audio: null, actuation: null },
      constraints: { powerSource: '2x_d_cell', environment: 'outdoor_weatherproof', formFactor: null, batteryLifeHours: 61320, costTargetUsd: null },
      mustHaveInterfaces: [],
      isOffTopic: false,
    };
    const mockGrounding: GroundingContext = { datasheetSnippets: [], designGuidelines: [] };

    let capturedUserPrompt = '';
    let capturedSystemPrompt = '';

    jest.spyOn(aiRouterService, 'executeTask').mockImplementation(async (params: unknown) => {
      const p = params as { userPrompt: string; systemPrompt: string };
      capturedUserPrompt = p.userPrompt;
      capturedSystemPrompt = p.systemPrompt;
      return {
        content: mockGraphJson,
        inputTokens: 100,
        outputTokens: 200,
        latencyMs: 150,
        costUsd: 0.001,
        rawResponse: mockGraphJson,
        aiCallId: 'call-test',
      } as ExecuteTaskResult;
    });

    const { graph } = await buildCanonicalDesignGraph(
      mockIntent,
      mockGrounding,
      'test-session',
      undefined,
      undefined,
      [],
      undefined,
      rawBrief
    );

    expect(graph.controller.partNumber).toBe('STM32L431');
    expect(capturedUserPrompt).toContain('ORIGINAL USER ENGINEERING SPECIFICATION:');
    expect(capturedUserPrompt).toContain(rawBrief);
    expect(capturedUserPrompt).toContain('EXTRACTED STRUCTURED INTENT:');
    expect(capturedSystemPrompt).toContain('Dynamic Specification Fidelity & Zero Instruction Dropping');
    expect(capturedSystemPrompt).toContain('Dynamic Power Topology Matching');
    expect(capturedSystemPrompt).toContain('Dynamic Mathematical Calculations & Proofs');
  });

  it('falls back cleanly to intent.purpose when rawBrief is omitted', async () => {
    const mockIntent: StructuredIntent = {
      deviceType: 'wearable',
      purpose: 'smart fitness tracker',
      subsystems: null,
      constraints: { powerSource: null, environment: null, formFactor: null, batteryLifeHours: null, costTargetUsd: null },
      mustHaveInterfaces: [],
      isOffTopic: false,
    };
    const mockGrounding: GroundingContext = { datasheetSnippets: [], designGuidelines: [] };

    let capturedUserPrompt = '';

    jest.spyOn(aiRouterService, 'executeTask').mockImplementation(async (params: unknown) => {
      const p = params as { userPrompt: string };
      capturedUserPrompt = p.userPrompt;
      return {
        content: mockGraphJson,
        inputTokens: 100,
        outputTokens: 200,
        latencyMs: 150,
        costUsd: 0.001,
        rawResponse: mockGraphJson,
        aiCallId: 'call-test-fallback',
      } as ExecuteTaskResult;
    });

    await buildCanonicalDesignGraph(mockIntent, mockGrounding, 'test-session');

    expect(capturedUserPrompt).toContain('ORIGINAL USER ENGINEERING SPECIFICATION:');
    expect(capturedUserPrompt).toContain('smart fitness tracker');
  });
});

