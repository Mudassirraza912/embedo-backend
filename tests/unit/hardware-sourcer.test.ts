import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { prepareBundle } from '../../src/modules/hardware/hardware-admin.service.js';
import { hardwareLibraryService } from '../../src/modules/hardware/hardware-library.service.js';
import { hardwareProposalService } from '../../src/modules/hardware/hardware-proposal.service.js';
import { addressesFromPage, checkFacts, factsSchema, factsToBoard, normaliseFacts, pageMatchesProduct, sourceHardware, SourcedFacts } from '../../src/modules/hardware/discovery/hardware-sourcer.js';
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
    expect(sig.members.map((m) => m.pinId)).toContain('HWP-TEST0001:SIG');
    // A plain GPIO line keeps off the controller's labelled bus pins (GP0 is the Pico's UART0 TX).
    const mcuPin = sig.members.find((m) => m.instanceId === 'mcu')!.pinId;
    const labelled = pico.record.interfaces.interfaces.flatMap((i) => Object.values(i.details as Record<string, unknown>));
    expect(labelled).not.toContain(mcuPin);
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

  it('keeps boards whose extraction only overran presentation limits (prod failures, 2026-10-15)', () => {
    const accept = (raw: unknown) => {
      const parsed = factsSchema.safeParse(normaliseFacts(raw));
      expect(parsed.success).toBe(true);
      expect(checkFacts(parsed.success ? parsed.data : relayFacts)).toEqual([]);
      return parsed.success ? parsed.data : relayFacts;
    };
    // "notes: Array must contain at most 4" and "logic_level_summary: at most 80 characters"
    const chatty = accept({ ...relayFacts, notes: ['a', 'b', 'c', 'd', 'e', 'f'], logic_level_summary: 'x'.repeat(200) });
    expect(chatty.notes).toHaveLength(4);
    expect(chatty.logic_level_summary).toHaveLength(80);
    // "connectors.0.pins.0: Expected string, received object" and "GPIO 0"-style labels
    const objects = accept({
      ...relayFacts,
      pins: [...relayFacts.pins.slice(0, 5), { ...relayFacts.pins[5]!, name: 'N C' }],
      connectors: [
        { ref: 'JP1', kind: 'header', pins: [{ name: 'SIG' }, { pin: 'VIN' }, { label: 'GND' }] },
        { ref: 'TB1', kind: 'screw_terminal', pins: ['NO', 'COM', 'N C'] },
      ],
    });
    expect(objects.connectors[1]!.pins).toEqual(['NO', 'COM', 'N_C']);
    // "connectors.1.pins: Array must contain at least 1 element" and pins on no connector
    const loose = accept({ ...relayFacts, connectors: [{ ref: 'JP1', kind: 'header', pins: ['SIG', 'VIN', 'GND'] }, { ref: 'X', kind: 'header', pins: [] }] });
    expect(loose.connectors.flatMap((c) => c.pins).sort()).toEqual(['COM', 'GND', 'NC', 'NO', 'SIG', 'VIN']);
    // A STEMMA QT connector without 4 contacts is drawn as a plain header instead of failing.
    const qt = accept({ ...relayFacts, connectors: [{ ref: 'QT', kind: 'stemma_qt', pins: ['SIG', 'VIN', 'GND'] }, relayFacts.connectors[1]] });
    expect(qt.connectors[0]!.kind).toBe('header');
    // Facts nested one level down ({"board": {...}}) are unwrapped instead of read as nothing.
    accept({ board: relayFacts });
  });

  it('reads I2C addresses only where the product page states them next to "address"', () => {
    const page = 'The SHT31-D has a default I2C address of 0x44, and can be changed to 0x45 by connecting ADR to VIN. Register 0x2C starts a measurement.';
    expect(addressesFromPage(page)).toEqual(['0x44', '0x45']);
    expect(addressesFromPage('Write 0x2C then 0x06 to start.')).toEqual([]);
  });

  it('keeps a pin on both its STEMMA QT socket and its header (socket listed first)', () => {
    const qtBoard = factsSchema.parse(
      normaliseFacts({
        ...relayFacts,
        pins: ['GND', '3V3', 'SDA', 'SCL', 'INT'],
        connectors: [
          { ref: 'QT1', kind: 'stemma_qt', pins: ['GND', '3V3', 'SDA', 'SCL'] },
          { ref: 'J1', kind: 'header', pins: ['3V3', 'GND', 'SCL', 'SDA', 'SDA', 'INT'] },
        ],
      })
    );
    expect(qtBoard.connectors.map((c) => [c.kind, c.pins])).toEqual([
      ['stemma_qt', ['GND', '3V3', 'SDA', 'SCL']],
      ['header', ['3V3', 'GND', 'SCL', 'SDA', 'INT']],
    ]);
    expect(checkFacts(qtBoard)).toEqual([]);
  });

  it('never repairs an electrical fact: a board with no ground pin is still rejected', () => {
    const parsed = factsSchema.parse(normaliseFacts({ ...relayFacts, pins: relayFacts.pins.filter((p) => p.name !== 'GND'), connectors: [{ ref: 'J1', kind: 'header', pins: ['SIG', 'VIN', 'NO', 'COM', 'NC'] }] }));
    expect(checkFacts(parsed)).toContain('no ground pin');
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

describe('large controller pinouts (dev 2026-10-16: every STM32H7 Nucleo extraction failed on "at most 80 pins")', () => {
  it('trims a 140-pin board to 80 pins, keeping power, ground and every bus pin, and splits long headers', () => {
    const bus = ['PB8', 'PB9', 'PA5', 'PA6', 'PA7', 'PD8', 'PD9', 'PD5', 'PD6', 'PC12', 'PD2', 'PE8', 'PE7', 'PC6', 'PC7', 'PD1', 'PD0'];
    const busFns: Record<string, string> = { PB8: 'I2C1_SCL', PB9: 'I2C1_SDA', PA5: 'SPI1_SCK', PA6: 'SPI1_MISO', PA7: 'SPI1_MOSI', PD8: 'USART3_TX', PD9: 'USART3_RX', PD5: 'USART2_TX', PD6: 'USART2_RX', PC12: 'UART5_TX', PD2: 'UART5_RX', PE8: 'UART7_TX', PE7: 'UART7_RX', PC6: 'USART6_TX', PC7: 'USART6_RX', PD1: 'FDCAN1_TX', PD0: 'FDCAN1_RX' };
    const gpio = Array.from({ length: 118 }, (_, i) => `PG${i}`);
    const power = ['3V3', '5V', 'VIN', 'GND', 'E5V'];
    const names = [...gpio.slice(0, 60), ...bus, ...power, ...gpio.slice(60)];
    const pins = names.map((name) =>
      power.includes(name)
        ? { name, signal_class: name === 'GND' ? 'ground' : 'power', direction: name === 'GND' ? 'ground' : name === 'VIN' || name === 'E5V' ? 'power_in' : 'power_out', voltage_domain: null, functions: [] }
        : { name, signal_class: 'data', direction: 'bidirectional', voltage_domain: '3V3', functions: busFns[name] ? [busFns[name]] : [`GPIO`] }
    );
    const facts = {
      product_name: 'NUCLEO-H743ZI2',
      vendor: 'STMicroelectronics',
      is_controller: true,
      functional_categories: ['Processing'],
      prototype_role: 'Main controller',
      pins,
      connectors: [
        { ref: 'CN11', kind: 'header', pins: names.slice(0, 70) },
        { ref: 'CN12', kind: 'header', pins: names.slice(70) },
      ],
      interfaces: Array.from({ length: 12 }, (_, i) => ({ type: i < 6 ? 'UART' : 'GPIO', role: 'controller' })),
      facts_source: 'model_knowledge',
    };
    const parsed = factsSchema.safeParse(normaliseFacts(facts));
    expect(parsed.success).toBe(true);
    const f = parsed.data!;
    expect(f.pins.length).toBe(80);
    for (const n of [...bus, ...power]) expect(f.pins.map((p) => p.name)).toContain(n);
    expect(f.interfaces).toHaveLength(12);
    expect(checkFacts(f)).toEqual([]);
    expect(Math.max(...f.connectors.map((c) => c.pins.length))).toBeLessThanOrEqual(48);
  });
});

describe('module buses must name their pins (dev 2026-10-16: a JSN-SR04T "UART" with only TRIG/ECHO)', () => {
  const base = {
    product_name: 'UART Ultrasonic Distance Sensor - JSN-SR04T',
    vendor: 'Adafruit',
    is_controller: false,
    functional_categories: ['Sensing'],
    prototype_role: 'Distance',
    connectors: [{ ref: 'J1', kind: 'header', pins: ['VCC', 'GND', 'TRIG', 'ECHO'] }],
    facts_source: 'model_knowledge',
  };
  const pins = ['VCC', 'GND', 'TRIG', 'ECHO'];
  it('asks again when a UART names no TX/RX and no pin is called TX/RX', () => {
    const f = factsSchema.parse(normaliseFacts({ ...base, pins, interfaces: [{ type: 'UART' }] }));
    expect(checkFacts(f).join(' ')).toMatch(/UART interface does not name its tx\/rx pins/);
  });
  it('accepts it once the interface names the pins', () => {
    const f = factsSchema.parse(normaliseFacts({ ...base, pins, interfaces: [{ type: 'UART', tx: 'ECHO', rx: 'TRIG' }] }));
    expect(checkFacts(f)).toEqual([]);
  });
});
