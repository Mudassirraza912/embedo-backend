import { describe, it, expect } from '@jest/globals';
import { prepareBundle } from '../../src/modules/hardware/hardware-admin.service.js';
import { factsToBoard, SourcedFacts } from '../../src/modules/hardware/discovery/hardware-sourcer.js';
import { buildRecord, buildSvg } from '../../src/modules/hardware/discovery/record-builder.js';
import { isControllerRecord } from '../../src/modules/hardware/hardware.schema.js';
import { parseModuleSvg } from '../../src/modules/hardware/hardware-svg.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { allocatePins, AllocInstance } from '../../src/modules/sessions/prototype/prototype-allocator.js';
import { assemblePrototype } from '../../src/modules/sessions/prototype/prototype-assembler.js';
import { PrototypeComposition } from '../../src/modules/sessions/prototype/prototype.types.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

/**
 * Regression for the "Asset Tracker with GNSS LTE-M" session (prod, 2026-10-13): the bench had a
 * PowerBoost 1000 and a Pololu 3.3 V regulator, but only their GND pads were wired; the modules ran
 * from the Feather's own 3V pin, and a revision wired the PowerBoost 5V output onto a Feather GPIO.
 * The boards below mirror the records that were stored for that session.
 */

const base = {
  vendor: 'Adafruit',
  vendor_sku: null,
  secondary_ics: [],
  required_accessories: [],
  notes: [],
  facts_source: 'model_knowledge',
} as const;

const pin = (name: string, signal_class: string, direction: string, voltage_domain: string | null) => ({ name, signal_class, direction, voltage_domain, functions: [] });

const featherFacts = {
  ...base,
  product_name: 'Adafruit Feather nRF9160',
  is_controller: true,
  functional_categories: ['Processing'],
  prototype_role: 'LTE-M controller',
  main_silicon: 'nRF9160',
  supply_voltage_min_v: 3.3,
  supply_voltage_max_v: 3.3,
  logic_level_summary: '3.3V',
  power_source_types: ['USB', 'Battery'],
  required_host_interfaces: [],
  host_requirement: 'standalone',
  pins: [
    pin('3V', 'power', 'power_out', '3V3'),
    pin('GND', 'ground', 'ground', null),
    pin('VIN', 'power', 'power_in', 'VIN'),
    pin('SDA', 'data', 'bidirectional', '3V3'),
    pin('SCL', 'data', 'bidirectional', '3V3'),
    pin('TX', 'data', 'output', '3V3'),
    pin('RX', 'data', 'input', '3V3'),
    pin('GPIO0', 'data', 'bidirectional', '3V3'),
    pin('GPIO1', 'data', 'bidirectional', '3V3'),
  ],
  connectors: [{ ref: 'JP1', kind: 'header', edge: 'left', pins: ['3V', 'GND', 'VIN', 'SDA', 'SCL', 'TX', 'RX', 'GPIO0', 'GPIO1'] }],
  interfaces: [
    { type: 'I2C', role: 'controller', addresses: [] },
    { type: 'UART', role: 'controller', addresses: [] },
  ],
} as unknown as SourcedFacts;

const gpsFacts = {
  ...base,
  product_name: 'Adafruit Ultimate GPS Breakout',
  is_controller: false,
  functional_categories: ['Connectivity'],
  prototype_role: 'GNSS',
  main_silicon: 'MTK3339',
  supply_voltage_min_v: 3,
  supply_voltage_max_v: 5.5,
  logic_level_summary: '3V logic level out, 5V-safe input',
  power_source_types: ['external'],
  required_host_interfaces: ['UART'],
  pins: [pin('VIN', 'power', 'power_in', 'VIN'), pin('GND', 'ground', 'ground', null), pin('RX', 'data', 'input', '3V3'), pin('TX', 'data', 'output', '3V3')],
  connectors: [{ ref: 'JP1', kind: 'header', edge: 'bottom', pins: ['VIN', 'GND', 'RX', 'TX'] }],
  interfaces: [{ type: 'UART', role: 'target', addresses: [] }],
} as unknown as SourcedFacts;

const accelFacts = {
  ...base,
  product_name: 'Adafruit ADXL343 Breakout',
  is_controller: false,
  functional_categories: ['Sensing'],
  prototype_role: 'Accelerometer',
  main_silicon: 'ADXL343',
  supply_voltage_min_v: 2,
  supply_voltage_max_v: 3.6,
  logic_level_summary: '3V3',
  power_source_types: ['external'],
  required_host_interfaces: ['I2C'],
  pins: [
    pin('VIN', 'power', 'power_in', 'VIN'),
    pin('3V3', 'power', 'power_out', '3V3'),
    pin('GND', 'ground', 'ground', null),
    pin('SDA', 'data', 'bidirectional', '3V3'),
    pin('SCL', 'data', 'bidirectional', '3V3'),
  ],
  connectors: [{ ref: 'JP1', kind: 'header', edge: 'bottom', pins: ['VIN', '3V3', 'GND', 'SDA', 'SCL'] }],
  interfaces: [{ type: 'I2C', role: 'target', addresses: [] }],
} as unknown as SourcedFacts;

const powerBoostFacts = {
  ...base,
  product_name: 'Adafruit PowerBoost 1000 Charger',
  is_controller: false,
  functional_categories: ['Power'],
  prototype_role: 'LiPo charger and 5 V boost',
  main_silicon: 'TPS61090',
  supply_voltage_min_v: 3.7,
  supply_voltage_max_v: 4.2,
  logic_level_summary: 'not specified',
  power_source_types: ['LiIon/LiPoly battery', 'MicroUSB'],
  required_host_interfaces: [],
  host_requirement: 'optional_host',
  pins: [
    pin('BAT', 'power', 'power_in', 'VIN'),
    pin('USB', 'power', 'power_in', '5V'),
    pin('5V', 'power', 'power_out', '5V'),
    pin('GND', 'ground', 'ground', null),
    pin('EN', 'control', 'input', null),
    pin('LBO', 'control', 'output', null),
  ],
  connectors: [{ ref: 'JP1', kind: 'header', edge: 'bottom', pins: ['BAT', 'USB', '5V', 'GND', 'EN', 'LBO'] }],
  interfaces: [],
} as unknown as SourcedFacts;

const regulatorFacts = {
  ...base,
  vendor: 'Pololu',
  product_name: 'Pololu 3.3V Step-Down Voltage Regulator D24V5F3',
  is_controller: false,
  functional_categories: ['Power'],
  prototype_role: '5 V to 3.3 V regulation',
  main_silicon: 'ISL85410',
  supply_voltage_min_v: 3.4,
  supply_voltage_max_v: 36,
  logic_level_summary: '3.3V output',
  power_source_types: ['DC'],
  required_host_interfaces: [],
  host_requirement: 'optional_host',
  pins: [pin('VIN', 'power', 'power_in', 'VIN'), pin('GND', 'ground', 'ground', null), pin('VOUT', 'power', 'power_out', '3V3'), pin('SHDN', 'control', 'input', 'VIN'), pin('PG', 'control', 'output', 'VIN')],
  connectors: [{ ref: 'JP1', kind: 'header', edge: 'bottom', pins: ['VIN', 'GND', 'VOUT', 'SHDN', 'PG'] }],
  interfaces: [],
} as unknown as SourcedFacts;

const entityFromFacts = async (facts: SourcedFacts, id: string): Promise<LibraryEntity> => {
  const board = factsToBoard(facts, id, `FAM-${id}`, null);
  const { bundle, issues } = prepareBundle({ record: buildRecord(board), svg: buildSvg(board).svg });
  if (!bundle) throw new Error(issues.map((i) => i.message).join('; '));
  const template = await loadFixtureEntity(FIXTURE_IDS.bme280);
  return {
    ...template,
    hardwareEntityId: id,
    isController: isControllerRecord(bundle.record),
    record: bundle.record,
    svg: { hash: id, markup: bundle.svg, parsed: parseModuleSvg(bundle.svg) },
  };
};

const bench = async () => ({
  feather: await entityFromFacts(featherFacts, 'HWP-FEATHER91'),
  gps: await entityFromFacts(gpsFacts, 'HWP-GPS00001'),
  accel: await entityFromFacts(accelFacts, 'HWP-ACCEL001'),
  boost: await entityFromFacts(powerBoostFacts, 'HWP-BOOST001'),
  reg: await entityFromFacts(regulatorFacts, 'HWP-REG00001'),
});

const membersOf = (nets: Array<{ name: string; members: Array<{ instanceId: string; pinName: string }> }>, name: string) =>
  nets.find((n) => n.name === name)?.members.map((m) => `${m.instanceId}.${m.pinName}`).sort();

describe('prototype power chain (bench supplies wired from their records)', () => {
  it('chains PowerBoost 5V → regulator, and the regulator powers the controller and every module', async () => {
    const b = await bench();
    const peripherals: AllocInstance[] = [
      { instanceId: 'gps1', entity: b.gps, links: [{ interface: 'UART' }] },
      { instanceId: 'accel1', entity: b.accel, links: [{ interface: 'I2C' }] },
      { instanceId: 'power1', entity: b.boost, links: [] },
      { instanceId: 'regulator1', entity: b.reg, links: [] },
    ];
    const result = allocatePins({ instanceId: 'mcu', entity: b.feather, links: [] }, peripherals);

    // 5 V from the PowerBoost feeds the regulator's input.
    expect(membersOf(result.nets, '5V')).toEqual(['power1.5V', 'regulator1.VIN']);
    // The regulator's 3.3 V output powers the Feather (its record: VIN 3.3 V) and both modules;
    // the Feather's own 3V pin is not used as the modules' supply.
    expect(membersOf(result.nets, '3V3')).toEqual(['accel1.VIN', 'gps1.VIN', 'mcu.VIN', 'regulator1.VOUT']);
    expect(result.nets.flatMap((n) => n.members).some((m) => m.instanceId === 'mcu' && m.pinName === '3V')).toBe(false);
    // Every board shares ground.
    expect(membersOf(result.nets, 'GND')).toEqual(['accel1.GND', 'gps1.GND', 'mcu.GND', 'power1.GND', 'regulator1.GND']);

    // The PowerBoost is the primary source: its outside input is reported, not invented.
    const source = result.results.find((r) => r.instanceIds.includes('power1') && r.ruleType === 'required_power_rail');
    expect(source).toMatchObject({ status: 'WARNING' });
    expect(source!.message).toContain('BAT');
    expect(source!.message).toContain('LiIon/LiPoly battery');
    expect(result.results.filter((r) => r.status === 'BLOCKER')).toEqual([]);
  });

  it('never wires a power or ground pin to a controller GPIO, even when the resolver links it that way', async () => {
    const b = await bench();
    // The v1.2 composition from the session: power expressed as GPIO links.
    const peripherals: AllocInstance[] = [
      { instanceId: 'gps1', entity: b.gps, links: [{ interface: 'UART' }] },
      { instanceId: 'accel1', entity: b.accel, links: [{ interface: 'I2C' }] },
      { instanceId: 'power1', entity: b.boost, links: [{ interface: 'GPIO', pinName: '5V', purpose: 'Power output to Feather Vin' }] },
      {
        instanceId: 'regulator1',
        entity: b.reg,
        links: [
          { interface: 'GPIO', pinName: 'VIN', purpose: 'Input from PowerBoost 5V' },
          { interface: 'GPIO', pinName: 'VOUT', purpose: 'Output to power 3.3V components' },
        ],
      },
    ];
    const result = allocatePins({ instanceId: 'mcu', entity: b.feather, links: [] }, peripherals);
    for (const net of result.nets) {
      const names = net.members.map((m) => m.pinName);
      expect(net.class === 'gpio' && names.some((n) => ['5V', 'VIN', 'VOUT'].includes(n))).toBe(false);
      expect(names).not.toContain('GPIO0');
      expect(names).not.toContain('GPIO1');
    }
    expect(membersOf(result.nets, '3V3')).toEqual(['accel1.VIN', 'gps1.VIN', 'mcu.VIN', 'regulator1.VOUT']);
  });

  it('draws every net member: each one has a connection, including supply-to-supply nets', async () => {
    const b = await bench();
    const composition: PrototypeComposition = {
      kind: 'prototype_composition',
      controller: { instanceId: 'mcu', hardwareEntityId: b.feather.hardwareEntityId },
      modules: [
        { instanceId: 'gps1', hardwareEntityId: b.gps.hardwareEntityId, role: 'GNSS', links: [{ interface: 'UART', pinName: null, purpose: null }] },
        { instanceId: 'accel1', hardwareEntityId: b.accel.hardwareEntityId, role: 'motion', links: [{ interface: 'I2C', pinName: null, purpose: null }] },
        { instanceId: 'power1', hardwareEntityId: b.boost.hardwareEntityId, role: 'battery', links: [] },
        { instanceId: 'regulator1', hardwareEntityId: b.reg.hardwareEntityId, role: '3.3 V', links: [] },
      ],
      gaps: [],
    };
    const entities = new Map(Object.values(b).map((e) => [e.hardwareEntityId, e]));
    const payload = assemblePrototype(composition, entities, {
      svgBasePath: '/api/v1/hardware/entities',
      projectName: 'Asset tracker',
      understanding: '',
      notes: '',
    });
    for (const net of payload.nets) {
      const wired = new Set(
        payload.connections.filter((c) => c.netIds.includes(net.netId)).flatMap((c) => [`${c.from.instanceId}|${c.from.anchorId}`, `${c.to.instanceId}|${c.to.anchorId}`])
      );
      for (const m of net.members) expect(wired.has(`${m.instanceId}|${m.anchorId}`)).toBe(true);
    }
    // The diagram has one track per net, and every member pad is tapped onto it.
    const buses = payload.moduleDiagram.buses ?? [];
    for (const net of payload.nets) {
      const bus = buses.find((x) => x.netId === net.netId);
      expect(bus).toBeDefined();
      for (const m of net.members) expect(bus!.taps.some((t) => t.instanceId === m.instanceId && t.anchorId === m.anchorId)).toBe(true);
    }
  });

  it('keeps two supplies at the same voltage on separate nets (never shorted together)', async () => {
    const b = await bench();
    const reg2 = await entityFromFacts({ ...regulatorFacts, product_name: 'Second 3.3V regulator' } as SourcedFacts, 'HWP-REG00002');
    const result = allocatePins({ instanceId: 'mcu', entity: b.feather, links: [] }, [
      { instanceId: 'power1', entity: b.boost, links: [] },
      { instanceId: 'regulator1', entity: b.reg, links: [] },
      { instanceId: 'regulator2', entity: reg2, links: [] },
      { instanceId: 'gps1', entity: b.gps, links: [{ interface: 'UART' }] },
    ]);
    for (const net of result.nets.filter((n) => n.class === 'power')) {
      const sources = net.members.filter((m) => m.pinName === 'VOUT' || m.pinName === '5V' || m.pinName === '3V');
      expect(sources.length).toBeLessThanOrEqual(1);
    }
    expect(result.results.filter((r) => r.ruleType === 'signal_direction_conflict')).toEqual([]);
  });

  it('leaves a bench without supplies on the controller rail, as before', async () => {
    const b = await bench();
    const result = allocatePins({ instanceId: 'mcu', entity: b.feather, links: [] }, [
      { instanceId: 'gps1', entity: b.gps, links: [{ interface: 'UART' }] },
      { instanceId: 'accel1', entity: b.accel, links: [{ interface: 'I2C' }] },
    ]);
    expect(membersOf(result.nets, '3V3')).toEqual(['accel1.VIN', 'gps1.VIN', 'mcu.3V']);
  });
});
