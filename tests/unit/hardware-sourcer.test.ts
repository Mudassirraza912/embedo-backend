import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { prepareBundle } from '../../src/modules/hardware/hardware-admin.service.js';
import { hardwareLibraryService } from '../../src/modules/hardware/hardware-library.service.js';
import { hardwareProposalService } from '../../src/modules/hardware/hardware-proposal.service.js';
import { checkFacts, factsSchema, factsToBoard, pageMatchesProduct, sourceHardware, SourcedFacts } from '../../src/modules/hardware/discovery/hardware-sourcer.js';
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

  // --- shapes the model really returned on dev ---------------------------------------------------
  const entityFromFacts = async (facts: SourcedFacts, id: string) => {
    const board = factsToBoard(facts, id, `FAM-${id}`, null);
    const { bundle, issues } = prepareBundle({ record: buildRecord(board), svg: buildSvg(board).svg });
    if (!bundle) throw new Error(issues.map((i) => i.message).join('; '));
    const base = await loadFixtureEntity(FIXTURE_IDS.bme280);
    return {
      ...base,
      hardwareEntityId: id,
      isController: isControllerRecord(bundle.record),
      record: bundle.record,
      svg: { hash: id, markup: bundle.svg, parsed: parseModuleSvg(bundle.svg) },
    };
  };

  it('accepts bare pin names and free-form connector refs instead of rejecting the board', () => {
    const parsed = factsSchema.parse({
      ...relayFacts,
      pins: ['SIG', 'VIN', 'GND', 'NO', 'COM', 'NC'],
      connectors: [
        { ref: 'Header-1 (bottom)', kind: 'header', pins: ['SIG', 'VIN', 'GND'] },
        { ref: 'Header-1 (bottom)', kind: 'screw_terminal', pins: ['NO', 'COM', 'NC'] },
      ],
    });
    expect(parsed.pins.find((p) => p.name === 'GND')).toMatchObject({ signal_class: 'ground', direction: 'ground' });
    expect(parsed.pins.find((p) => p.name === 'VIN')).toMatchObject({ direction: 'power_in' });
    const board = factsToBoard(parsed, 'HWP-REFS0001', 'FAM-X', null);
    expect(board.connectors.map((c) => c.ref)).toEqual(['HEADER1B', 'HEADER2']);
  });

  it('wires a Qwiic-only module through a socket-to-header cable and says which cable to use', async () => {
    const qwiicOnly: SourcedFacts = {
      ...relayFacts,
      product_name: 'Qwiic-only Pulse Sensor',
      functional_categories: ['Sensing'],
      required_host_interfaces: ['I2C'],
      pins: [
        { name: 'GND', signal_class: 'ground', direction: 'ground', voltage_domain: null, functions: [] },
        { name: '3V3', signal_class: 'power', direction: 'power_in', voltage_domain: '3V3', functions: [] },
        { name: 'SDA', signal_class: 'data', direction: 'bidirectional', voltage_domain: '3V3', functions: [] },
        { name: 'SCL', signal_class: 'data', direction: 'input', voltage_domain: '3V3', functions: [] },
      ],
      connectors: [{ ref: 'QWIIC', kind: 'stemma_qt', pins: ['GND', '3V3', 'SDA', 'SCL'] }],
      interfaces: [{ type: 'I2C', role: 'target', addresses: ['0x55'], sda: 'SDA', scl: 'SCL' }],
    };
    const sensor = await entityFromFacts(qwiicOnly, 'HWP-QWIIC001');
    const pico = await loadFixtureEntity(FIXTURE_IDS.pico);
    const result = allocatePins({ instanceId: 'mcu', entity: pico, links: [] }, [{ instanceId: 'ppg1', entity: sensor, links: [{ interface: 'I2C' }] }]);
    expect(result.nets.find((n) => n.name === 'I2C0_SDA')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:GP4', 'HWP-QWIIC001:SDA']);
    expect(result.nets.find((n) => n.class === 'ground')!.members.map((m) => m.pinId)).toContain('HWP-QWIIC001:GND');
    const adapter = result.results.find((r) => r.ruleType === 'connector_family_compatibility' && r.status === 'WARNING');
    expect(adapter?.suggestedFix).toContain('male-header');
    expect(result.results.filter((r) => r.status === 'BLOCKER')).toEqual([]);
  });

  it('finds a controller bus by its silkscreened SDA/SCL names when the record has no function tokens', async () => {
    const feather: SourcedFacts = {
      ...relayFacts,
      product_name: 'Feather nRF52840 (no tokens)',
      is_controller: true,
      functional_categories: ['Processing', 'Connectivity'],
      prototype_role: 'Main Controller',
      pins: [
        { name: '3V', signal_class: 'power', direction: 'power_out', voltage_domain: '3V3', functions: [] },
        { name: 'GND', signal_class: 'ground', direction: 'ground', voltage_domain: null, functions: [] },
        { name: 'SDA', signal_class: 'data', direction: 'bidirectional', voltage_domain: '3V3', functions: [] },
        { name: 'SCL', signal_class: 'data', direction: 'bidirectional', voltage_domain: '3V3', functions: [] },
        { name: 'D5', signal_class: 'data', direction: 'bidirectional', voltage_domain: '3V3', functions: [] },
      ],
      connectors: [{ ref: 'JP1', kind: 'header', edge: 'left', pins: ['3V', 'GND', 'SDA', 'SCL', 'D5'] }],
      interfaces: [{ type: 'I2C', role: 'controller', addresses: [] }],
    };
    const mcu = await entityFromFacts(feather, 'HWP-FEATHER1');
    expect(mcu.isController).toBe(true);
    const bme = await loadFixtureEntity(FIXTURE_IDS.bme280);
    const result = allocatePins({ instanceId: 'mcu', entity: mcu, links: [] }, [{ instanceId: 'bme1', entity: bme, links: [{ interface: 'I2C' }] }]);
    const sda = result.nets.find((n) => n.class === 'i2c' && n.name.endsWith('SDA'))!;
    expect(sda.members.map((m) => m.pinId).sort()).toEqual(['HW-FX03:SDI', 'HWP-FEATHER1:SDA']);
  });

  it('leaves a self-powered module (charger) on its own supply instead of the controller rail', async () => {
    const charger: SourcedFacts = {
      ...relayFacts,
      product_name: 'Micro Lipo Charger',
      functional_categories: ['Power'],
      prototype_role: 'LiPo charging',
      host_requirement: 'optional_host',
      supply_voltage_min_v: 4.8,
      supply_voltage_max_v: 5.2,
      required_host_interfaces: [],
      pins: [
        { name: '5V', signal_class: 'power', direction: 'power_in', voltage_domain: '5V', functions: [] },
        { name: 'BAT', signal_class: 'power', direction: 'power_out', voltage_domain: null, functions: [] },
        { name: 'GND', signal_class: 'ground', direction: 'ground', voltage_domain: null, functions: [] },
      ],
      connectors: [{ ref: 'JP1', kind: 'header', pins: ['5V', 'BAT', 'GND'] }],
    };
    const chg = await entityFromFacts(charger, 'HWP-CHARGER1');
    const pico = await loadFixtureEntity(FIXTURE_IDS.pico);
    const result = allocatePins({ instanceId: 'mcu', entity: pico, links: [] }, [{ instanceId: 'power1', entity: chg, links: [] }]);
    expect(result.nets.flatMap((n) => n.members).some((m) => m.instanceId === 'power1')).toBe(false);
    expect(result.results.filter((r) => r.status === 'BLOCKER')).toEqual([]);
    expect(result.results.find((r) => r.instanceIds.includes('power1'))).toMatchObject({ status: 'WARNING', ruleType: 'required_power_rail' });

    // With a status pin linked, the charger gets that signal and a common ground, never the 3V3 rail.
    const withStatus = await entityFromFacts(
      {
        ...charger,
        pins: [...charger.pins, { name: 'CHG', signal_class: 'data', direction: 'output', voltage_domain: null, functions: [] }],
        connectors: [{ ref: 'JP1', kind: 'header', pins: ['5V', 'BAT', 'GND', 'CHG'] }],
      },
      'HWP-CHARGER2'
    );
    expect(withStatus.record.interfaces.host_requirement).toBe('optional_host');
    const linked = allocatePins({ instanceId: 'mcu', entity: pico, links: [] }, [{ instanceId: 'power1', entity: withStatus, links: [{ interface: 'GPIO', pinName: 'CHG' }] }]);
    expect(linked.nets.find((n) => n.name === 'POWER1_CHG')!.members.map((m) => m.pinId)).toContain('HWP-CHARGER2:CHG');
    expect(linked.nets.find((n) => n.class === 'ground')!.members.map((m) => m.pinId)).toContain('HWP-CHARGER2:GND');
    expect(linked.nets.filter((n) => n.class === 'power').flatMap((n) => n.members).some((m) => m.instanceId === 'power1')).toBe(false);
    expect(linked.results.filter((r) => r.status === 'BLOCKER')).toEqual([]);
  });

  it('only trusts a fetched page that actually names the product', () => {
    const relay = { product_name: 'SparkFun Qwiic Single Relay', vendor_sku: 'COM-15093' };
    expect(pageMatchesProduct('SparkFun Qwiic EEPROM Breakout - 512Kbit. Store data over I2C.', relay)).toBe(false);
    expect(pageMatchesProduct('SparkFun Qwiic Single Relay ... SKU: COM-15093', relay)).toBe(true);
    expect(pageMatchesProduct('The Qwiic Single Relay from SparkFun switches up to 5A', { product_name: relay.product_name })).toBe(true);
  });

  it('treats a power-only board without a data bus as self-powered when the model did not say', () => {
    const charger = factsSchema.parse({
      ...relayFacts,
      functional_categories: ['Power'],
      pins: ['5V', 'BAT', 'GND'],
      connectors: [{ ref: 'JP1', kind: 'header', pins: ['5V', 'BAT', 'GND'] }],
    });
    expect(factsToBoard(charger, 'HWP-CHG00002', 'FAM-X', null).hostRequirement).toBe('optional_host');
    // Even when the model explicitly (and wrongly) says host_required, as it did on dev.
    expect(factsToBoard({ ...charger, host_requirement: 'host_required' }, 'HWP-CHG00003', 'FAM-X', null).hostRequirement).toBe('optional_host');
    expect(factsToBoard(relayFacts, 'HWP-RLY00002', 'FAM-X', null).hostRequirement).toBe('host_required');
  });

  it('does nothing for a non-prototype request', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValueOnce(aiResult(JSON.stringify({ isPrototypeRequest: false, understanding: 'weather question', products: [] })));
    const result = await sourceHardware({ sessionId: 's', requestText: 'how is the weather', library: [], catalogueLines: [], gaps: [], needController: true });
    expect(result).toMatchObject({ isPrototypeRequest: false, sourced: [] });
  });
});
