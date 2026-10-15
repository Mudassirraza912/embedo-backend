import { describe, it, expect, jest, afterEach, beforeAll } from '@jest/globals';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import {
  catalogueLine,
  PrototypeResolverError,
  resolvePrototype,
  resolverOutputSchema,
  validateResolverOutput,
} from '../../src/modules/sessions/prototype/prototype-resolver.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

const aiResult = (content: string) => ({
  content,
  inputTokens: 100,
  outputTokens: 50,
  cachedTokens: 0,
  latencyMs: 20,
  costUsd: 0.001,
  schemaPass: true,
  provider: 'openai',
  model: 'gpt-4o',
  aiCallId: 'call-1',
});

describe('prototype resolver contract', () => {
  let catalogue: LibraryEntity[];
  let byId: Map<string, LibraryEntity>;
  beforeAll(async () => {
    catalogue = await Promise.all(Object.values(FIXTURE_IDS).map((id) => loadFixtureEntity(id)));
    byId = new Map(catalogue.map((e) => [e.hardwareEntityId, e]));
  });
  afterEach(() => jest.restoreAllMocks());

  const valid = {
    understanding: 'Pico reads a BME280',
    isPrototypeRequest: true,
    controller: { hardwareEntityId: 'HW-FX01', role: 'main controller' },
    modules: [{ instanceId: 'bme1', hardwareEntityId: 'HW-FX03', role: 'environment', links: [{ interface: 'I2C' }] }],
    gaps: [],
    notes: '',
  };

  it('describes controllers without pins and peripherals with their pin names', () => {
    expect(catalogueLine(byId.get('HW-FX01')!)).toContain('controller: yes');
    expect(catalogueLine(byId.get('HW-FX01')!)).not.toContain('pins:');
    expect(catalogueLine(byId.get('HW-FX03')!)).toMatch(/pins: VIN,3Vo,GND,SCK,SDO,SDI,CS/);
    expect(catalogueLine(byId.get('HW-FX03')!)).toContain('PROVISIONAL');
  });

  it.each([
    ['an id outside the library', { modules: [{ ...valid.modules[0], hardwareEntityId: 'HW-9999' }] }, 'not in LIBRARY'],
    ['a peripheral as the controller', { controller: { hardwareEntityId: 'HW-FX03' } }, 'not a controller'],
    ['an interface the module lacks', { modules: [{ ...valid.modules[0], links: [{ interface: 'UART' }] }] }, 'not UART'],
    ['a GPIO pin the module lacks', { modules: [{ ...valid.modules[0], links: [{ interface: 'GPIO', pinName: 'INT' }] }] }, 'does not exist'],
    ['modules without a controller', { controller: null }, 'no controller'],
  ])('rejects %s', (_label, patch, message) => {
    const output = resolverOutputSchema.parse({ ...valid, ...patch });
    expect(validateResolverOutput(output, byId).join(' ')).toContain(message);
  });

  it('carries quick-refinement chips for the bench', () => {
    const out = resolverOutputSchema.parse({ ...valid, suggestedRefinements: ['Add a microSD data logger', 'Swap to a STEMMA QT sensor'] });
    expect(out.suggestedRefinements).toEqual(['Add a microSD data logger', 'Swap to a STEMMA QT sensor']);
    expect(resolverOutputSchema.parse(valid).suggestedRefinements).toEqual([]);
  });

  it('trims long prose instead of rejecting the selection (dev failure, 2026-10-15)', () => {
    const out = resolverOutputSchema.parse({
      ...valid,
      notes: 'n'.repeat(900),
      understanding: 'u'.repeat(900),
      gaps: [{ category: 'Storage', need: 'x'.repeat(300), suggestion: 's'.repeat(400) }],
      suggestedRefinements: Array.from({ length: 9 }, (_, i) => `Refinement ${i} `.repeat(8)),
    });
    expect(out.notes).toHaveLength(600);
    expect(out.understanding).toHaveLength(600);
    expect(out.gaps[0]!.suggestion).toHaveLength(200);
    expect(out.suggestedRefinements).toHaveLength(6);
    expect(out.suggestedRefinements.every((r) => r.length <= 60)).toBe(true);
    expect(validateResolverOutput(out, byId)).toEqual([]);
  });

  it('accepts a valid selection', () => {
    expect(validateResolverOutput(resolverOutputSchema.parse(valid), byId)).toEqual([]);
  });

  it('retries once with the exact problems, then succeeds', async () => {
    const spy = jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValueOnce(aiResult(JSON.stringify({ ...valid, controller: { hardwareEntityId: 'HW-0000' } })))
      .mockResolvedValueOnce(aiResult(JSON.stringify(valid)));
    jest.spyOn(aiRouterService, 'markSchemaResult').mockResolvedValue();

    const { output } = await resolvePrototype({ requestText: 'pico weather', history: [], catalogue, current: null, sessionId: 's1' });
    expect(output.controller?.hardwareEntityId).toBe('HW-FX01');
    expect(spy).toHaveBeenCalledTimes(2);
    const retry = spy.mock.calls[1]![0];
    expect(retry.taskCase).toBe('R');
    expect(retry.systemPrompt).toContain('HW-0000 is not in LIBRARY');
  });

  it('reports a missing controller as a gap instead of failing when the catalogue has none', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(aiResult(JSON.stringify({ ...valid, controller: null })));
    const peripheralsOnly = catalogue.filter((e) => !e.isController);
    const { output } = await resolvePrototype({ requestText: 'relay + oled', history: [], catalogue: peripheralsOnly, current: null, sessionId: 's1' });
    expect(output.modules).toEqual([]);
    expect(output.gaps[0]).toMatchObject({ category: 'Processing', need: 'a controller board' });
  });

  it('fails as a non-retryable resolver error after two invalid answers', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(aiResult('{"modules": "nope"}'));
    jest.spyOn(aiRouterService, 'markSchemaResult').mockResolvedValue();
    await expect(resolvePrototype({ requestText: 'x', history: [], catalogue, current: null, sessionId: 's1' })).rejects.toBeInstanceOf(
      PrototypeResolverError
    );
  });
});
