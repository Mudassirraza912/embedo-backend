import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { prepareBundle } from '../../src/modules/hardware/hardware-admin.service.js';
import { hardwareLibraryService } from '../../src/modules/hardware/hardware-library.service.js';
import { hardwareProposalService } from '../../src/modules/hardware/hardware-proposal.service.js';
import { checkFacts, factsToBoard, sourceHardware, SourcedFacts } from '../../src/modules/hardware/discovery/hardware-sourcer.js';
import { buildRecord, buildSvg } from '../../src/modules/hardware/discovery/record-builder.js';
import { htmlToText, isAllowedVendorUrl } from '../../src/modules/hardware/discovery/vendor-page.js';
import { allocatePins } from '../../src/modules/sessions/prototype/prototype-allocator.js';
import { isControllerRecord } from '../../src/modules/hardware/hardware.schema.js';
import { parseModuleSvg } from '../../src/modules/hardware/hardware-svg.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

const aiResult = (content: string) => ({
  content,
  inputTokens: 100,
  outputTokens: 100,
  cachedTokens: 0,
  latencyMs: 10,
  costUsd: 0,
  schemaPass: true,
  provider: 'openai',
  model: 'gpt-4o',
  aiCallId: 'x1',
});

/** A real-shaped relay breakout: GPIO-driven, with switched-load screw terminals. */
const relayFacts: SourcedFacts = {
  product_name: 'Adafruit STEMMA Non-Latching Mini Relay',
  vendor: 'Adafruit',
  vendor_sku: '4409',
  is_controller: false,
  functional_categories: ['Motor/Actuation'],
  prototype_role: 'Switch a load from a GPIO',
  main_silicon: 'HK4100F-DC3V relay',
  secondary_ics: [],
  supply_voltage_min_v: 3.0,
  supply_voltage_max_v: 5.0,
  logic_level_summary: '3-5V',
  power_source_types: ['header_vin'],
  required_host_interfaces: ['GPIO'],
  pins: [
    { name: 'SIG', signal_class: 'control', direction: 'input', voltage_domain: 'VIN', functions: [] },
    { name: 'VIN', signal_class: 'power', direction: 'power_in', voltage_domain: 'VIN', functions: [] },
    { name: 'GND', signal_class: 'ground', direction: 'ground', voltage_domain: null, functions: [] },
    { name: 'NO', signal_class: 'other', direction: 'bidirectional', voltage_domain: null, functions: [] },
    { name: 'COM', signal_class: 'other', direction: 'bidirectional', voltage_domain: null, functions: [] },
    { name: 'NC', signal_class: 'other', direction: 'bidirectional', voltage_domain: null, functions: [] },
  ],
  connectors: [
    { ref: 'JP1', kind: 'header', edge: 'bottom', pins: ['SIG', 'VIN', 'GND'] },
    { ref: 'TB1', kind: 'screw_terminal', edge: 'top', pins: ['NO', 'COM', 'NC'] },
  ],
  interfaces: [],
  required_accessories: [],
  notes: ['Relay contacts are rated for low-voltage DC loads only.'],
  facts_source: 'vendor_page',
};

describe('hardware sourcing (vendor pages → private board + review queue)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads vendor pages as text that keeps table rows, and only fetches allowlisted vendor sites', () => {
    const text = htmlToText('<html><head><title>x</title><script>evil()</script></head><body><h1>Relay</h1><table><tr><td>VIN</td><td>3-5V</td></tr><tr><td>SIG</td><td>signal</td></tr></table></body></html>');
    expect(text).toContain('VIN | 3-5V');
    expect(text).toContain('SIG | signal');
    expect(text).not.toContain('evil');
    expect(isAllowedVendorUrl('https://www.adafruit.com/product/4409')).toBe(true);
    expect(isAllowedVendorUrl('https://learn.sparkfun.com/tutorials/x')).toBe(true);
    expect(isAllowedVendorUrl('http://www.adafruit.com/product/4409')).toBe(false);
    expect(isAllowedVendorUrl('https://evil.example/adafruit.com')).toBe(false);
    expect(isAllowedVendorUrl('https://169.254.169.254/latest')).toBe(false);
  });

  it('rejects extracted facts that contradict themselves', () => {
    expect(checkFacts(relayFacts)).toEqual([]);
    const broken = { ...relayFacts, connectors: [{ ref: 'JP1', kind: 'header' as const, pins: ['SIG', 'VIN', 'GND', 'XYZ'] }] };
    const problems = checkFacts(broken);
    expect(problems).toContain('connector JP1 uses unknown pin XYZ');
    expect(problems).toContain('pin NO is not on any connector');
  });

  it('turns sourced facts into a valid private record the allocator can wire', async () => {
    const board = factsToBoard(relayFacts, 'HWP-TEST0001', 'FAM-SRC-ADAFRUIT-4409', 'https://www.adafruit.com/product/4409');
    const record = buildRecord(board, { scope: 'private_project', project_id: '11111111-1111-1111-1111-111111111111', record_origin: 'vendor_agent', verification_method: 'vendor_live' });
    const { svg } = buildSvg(board);
    const { bundle, issues } = prepareBundle({ record, svg });
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(bundle!.record.status_governance).toMatchObject({ scope: 'private_project', review_status: 'provisional', record_origin: 'vendor_agent' });

    const relay = {
      ...(await loadFixtureEntity(FIXTURE_IDS.bme280)),
      hardwareEntityId: 'HWP-TEST0001',
      scope: 'private_project',
      isController: isControllerRecord(bundle!.record),
      record: bundle!.record,
      svg: { hash: 'h', markup: bundle!.svg, parsed: parseModuleSvg(bundle!.svg) },
    };
    const pico = await loadFixtureEntity(FIXTURE_IDS.pico);
    const result = allocatePins({ instanceId: 'mcu', entity: pico, links: [] }, [{ instanceId: 'relay1', entity: relay, links: [{ interface: 'GPIO', pinName: 'SIG' }] }]);
    const sig = result.nets.find((n) => n.name === 'RELAY1_SIG')!;
    expect(sig.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:GP0', 'HWP-TEST0001:SIG']);
    expect(result.nets.find((n) => n.name === '3V3')!.members.map((m) => m.pinId)).toContain('HWP-TEST0001:VIN');
    // The switched-load contacts are never wired to the controller.
    expect(result.nets.flatMap((n) => n.members).some((m) => /:(NO|COM|NC)$/.test(m.pinId))).toBe(false);
  });

  it('sources a missing module end to end: vendor page, private record, review-queue candidate', async () => {
    const execute = jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValueOnce(
        aiResult(
          JSON.stringify({
            isPrototypeRequest: true,
            understanding: 'Pico switching a relay',
            products: [{ role: 'module', need: 'switch a lamp', product_name: relayFacts.product_name, vendor: 'Adafruit', vendor_sku: '4409', product_url: 'https://www.adafruit.com/product/4409', reason: 'GPIO relay' }],
          })
        )
      )
      .mockResolvedValueOnce(aiResult(JSON.stringify(relayFacts)));
    const page = '<html><body><h1>Adafruit STEMMA Non-Latching Mini Relay</h1>' + '<p>Pinout: SIG VIN GND, NO COM NC screw terminal. Works with 3V or 5V logic.</p>'.repeat(10) + '</body></html>';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(page, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    jest.spyOn(hardwareLibraryService, 'getOne').mockResolvedValue(null);
    const tx = jest.spyOn(prisma, '$transaction').mockResolvedValue(undefined as never);
    const submit = jest.spyOn(hardwareProposalService, 'submitProposal').mockResolvedValue({ duplicate: false } as never);
    jest.spyOn(hardwareLibraryService, 'getByIds').mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, { hardwareEntityId: id } as never])));

    const result = await sourceHardware({ sessionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', requestText: 'Pico that switches a lamp', library: [], catalogueLines: [], gaps: [], needController: true });

    expect(result.failures).toEqual([]);
    expect(result.sourced).toHaveLength(1);
    expect(result.sourced[0]).toMatchObject({ factsSource: 'vendor_page', pageRead: true, proposalQueued: true, productUrl: 'https://www.adafruit.com/product/4409' });
    expect(result.sourced[0]!.hardwareEntityId).toMatch(/^HWP-[0-9A-F]{8}$/);
    expect(fetchMock.mock.calls[0]![0]).toBe('https://www.adafruit.com/product/4409');
    // The page text reached the extraction prompt as data.
    expect(execute.mock.calls[1]![0].userPrompt).toContain('PRODUCT PAGE (https://www.adafruit.com/product/4409)');
    expect(execute.mock.calls.every((c) => c[0].taskCase === 'X')).toBe(true);
    expect(tx).toHaveBeenCalledTimes(1); // private record written
    const queued = submit.mock.calls[0]!;
    expect((queued[0].record as { status_governance: { scope: string } }).status_governance.scope).toBe('shared_library');
    expect(queued[1]).toMatchObject({ sourceType: 'vendor_agent', sourceReference: 'https://www.adafruit.com/product/4409' });
  });

  it('falls back to model knowledge (marked inferred) when the product URL is not an allowed vendor page', async () => {
    jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValueOnce(
        aiResult(JSON.stringify({ isPrototypeRequest: true, products: [{ role: 'module', need: 'relay', product_name: 'Some Relay', vendor: 'Adafruit', product_url: 'https://random-shop.example/relay' }] }))
      )
      .mockResolvedValueOnce(aiResult(JSON.stringify(relayFacts)));
    const fetchMock = jest.spyOn(globalThis, 'fetch');
    jest.spyOn(hardwareLibraryService, 'getOne').mockResolvedValue(null);
    jest.spyOn(prisma, '$transaction').mockResolvedValue(undefined as never);
    jest.spyOn(hardwareProposalService, 'submitProposal').mockResolvedValue({ duplicate: false } as never);
    jest.spyOn(hardwareLibraryService, 'getByIds').mockResolvedValue(new Map());

    const result = await sourceHardware({ sessionId: 's', requestText: 'relay', library: [], catalogueLines: [], gaps: [], needController: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.sourced[0]).toMatchObject({ factsSource: 'model_knowledge', pageRead: false });
  });

  it('does nothing for a non-prototype request', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValueOnce(aiResult(JSON.stringify({ isPrototypeRequest: false, understanding: 'weather question', products: [] })));
    const result = await sourceHardware({ sessionId: 's', requestText: 'how is the weather', library: [], catalogueLines: [], gaps: [], needController: true });
    expect(result).toMatchObject({ isPrototypeRequest: false, sourced: [] });
  });
});
