import { describe, it, expect, beforeAll } from '@jest/globals';
import { prepareBundle } from '../../src/modules/hardware/hardware-admin.service.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { factsSchema, factsToBoard, normaliseFacts } from '../../src/modules/hardware/discovery/hardware-sourcer.js';
import { buildRecord, buildSvg } from '../../src/modules/hardware/discovery/record-builder.js';
import { isControllerRecord } from '../../src/modules/hardware/hardware.schema.js';
import { parseModuleSvg } from '../../src/modules/hardware/hardware-svg.js';
import { renderBenchArt } from '../../src/modules/hardware/bench-art.js';
import { assemblePrototype, externalSupplyVoltsOf } from '../../src/modules/sessions/prototype/prototype-assembler.js';
import { functionsFromName } from '../../src/modules/sessions/prototype/prototype-board.js';
import { withProtocolGroups } from '../../src/modules/sessions/prototype/prototype-layout.js';
import { placeholderEntity, placeholderKindFor, withPlaceholderEntities } from '../../src/modules/sessions/prototype/prototype-placeholders.js';
import { isControllerGap, linkInterfacesOf, repairResolverOutput, validateResolverOutput, resolverOutputSchema } from '../../src/modules/sessions/prototype/prototype-resolver.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';
import { PrototypeArchitecture, PrototypeComposition } from '../../src/modules/sessions/prototype/prototype.types.js';

/**
 * Regression for the 20-module industrial IoT brief (prod session f2bf35e4, 2026-10-15), scored
 * 2/10 then 3.5/10 by the tester: an STM32H7 whose AI-sourced record named its bus pins
 * "I2C0_SDA"/"SPI0_SCK"/"UART0_TX" with no function tokens was reported as having "no free I2C
 * bus", so only power was wired; 12 requested modules were unwired gap cards; no CAN, no RS-485,
 * no 12 V input; an IMU chip select took the UART TX pin. Boards are built exactly as live
 * sourcing builds them (facts → factsToBoard → buildRecord/buildSvg → prepareBundle).
 */

const SESSION = '11111111-1111-1111-1111-111111111111';
const BRIEF =
  'Design a modular industrial IoT multi-sensor monitoring prototype using exactly 20 hardware modules. Power supply and regulation module with 12V input, 5V and 3.3V outputs.';

type Pin = { name: string; signal_class: string; direction: string; voltage_domain: string | null; functions?: string[] };
const pin = (name: string, signal_class: string, direction: string, voltage_domain: string | null = null, functions: string[] = []): Pin => ({ name, signal_class, direction, voltage_domain, functions });
const power = (name: string, dir: 'power_in' | 'power_out', domain: string | null = null) => pin(name, 'power', dir, domain);
const GND = pin('GND', 'ground', 'ground');
const data = (name: string, dir = 'bidirectional', domain: string | null = '3V3', functions: string[] = []) => pin(name, 'data', dir, domain, functions);

async function sourced(id: string, facts: Record<string, unknown>): Promise<LibraryEntity> {
  const parsed = factsSchema.parse(normaliseFacts({ secondary_ics: [], required_accessories: [], notes: [], facts_source: 'model_knowledge', ...facts }));
  const board = factsToBoard(parsed, id, `FAM-${id}`, null);
  const record = buildRecord(board, { scope: 'private_project', project_id: SESSION, record_origin: 'vendor_agent', verification_method: 'inferred' });
  const { svg } = buildSvg(board);
  const { bundle, issues } = prepareBundle({ record, svg });
  if (!bundle) throw new Error(`${id}: ${issues.map((i) => i.message).join('; ')}`);
  return {
    hardwareEntityId: id,
    productFamilyId: `FAM-${id}`,
    preferredInFamily: false,
    reviewStatus: 'provisional',
    lifecycleStatus: 'active',
    assetReadiness: 'visual_ready',
    scope: 'private_project',
    verificationMethod: 'inferred',
    recordOrigin: 'vendor_agent',
    projectId: SESSION,
    isController: isControllerRecord(bundle.record),
    record: bundle.record,
    sources: [],
    svg: { hash: `h-${id}`, markup: bundle.svg, parsed: parseModuleSvg(bundle.svg) },
  };
}

const controllerFacts = (name: string, pins: Pin[]) => ({
  product_name: name,
  vendor: 'STMicroelectronics',
  is_controller: true,
  functional_categories: ['Processing'],
  prototype_role: 'Main controller',
  main_silicon: 'STM32H743ZI',
  supply_voltage_min_v: 3.3,
  supply_voltage_max_v: 5,
  logic_level_summary: '3.3V',
  power_source_types: ['USB', 'External'],
  host_requirement: 'standalone',
  pins,
  connectors: [
    { ref: 'J1', kind: 'header', edge: 'left', pins: pins.slice(0, Math.ceil(pins.length / 2)).map((p) => p.name) },
    { ref: 'J2', kind: 'header', edge: 'right', pins: pins.slice(Math.ceil(pins.length / 2)).map((p) => p.name) },
  ],
  interfaces: [
    { type: 'I2C', role: 'controller' },
    { type: 'SPI', role: 'controller' },
    { type: 'UART', role: 'controller' },
  ],
});

/** The exact pinout of the prod record HWP-203E384F (AI knowledge): bus roles in the names, no functions. */
const prodNucleoPins: Pin[] = [
  power('3V3', 'power_out', '3V3'),
  power('5V', 'power_out', '5V'),
  power('VIN', 'power_in', 'VIN'),
  GND,
  ...['PA0', 'PB7', 'PC10', 'PD8', 'PE0', 'PF6', 'PG13', 'PH0'].map((n) => data(n)),
  data('UART0_TX', 'output'),
  data('UART0_RX', 'input'),
  data('I2C0_SDA'),
  data('I2C0_SCL'),
  data('SPI0_SCK', 'output'),
  data('SPI0_TX', 'output'),
  data('SPI0_RX', 'input'),
  data('SPI0_CSN', 'output'),
];

/** A controller record that shows every bus it breaks out (what extraction now asks for). */
const fullNucleoPins: Pin[] = [
  power('3V3', 'power_out', '3V3'),
  power('5V', 'power_out', '5V'),
  power('VIN', 'power_in', 'VIN'),
  GND,
  data('PB8', 'bidirectional', '3V3', ['I2C1_SCL']),
  data('PB9', 'bidirectional', '3V3', ['I2C1_SDA']),
  data('PA5', 'bidirectional', '3V3', ['SPI1_SCK']),
  data('PA7', 'bidirectional', '3V3', ['SPI1_MOSI']),
  data('PA6', 'bidirectional', '3V3', ['SPI1_MISO']),
  data('PD8', 'bidirectional', '3V3', ['USART3_TX']),
  data('PD9', 'bidirectional', '3V3', ['USART3_RX']),
  data('PD5', 'bidirectional', '3V3', ['USART2_TX']),
  data('PD6', 'bidirectional', '3V3', ['USART2_RX']),
  data('PC12', 'bidirectional', '3V3', ['UART5_TX']),
  data('PD2', 'bidirectional', '3V3', ['UART5_RX']),
  data('PE8', 'bidirectional', '3V3', ['UART7_TX']),
  data('PE7', 'bidirectional', '3V3', ['UART7_RX']),
  data('PC6', 'bidirectional', '3V3', ['USART6_TX']),
  data('PC7', 'bidirectional', '3V3', ['USART6_RX']),
  data('PD1', 'bidirectional', '3V3', ['FDCAN1_TX']),
  data('PD0', 'bidirectional', '3V3', ['FDCAN1_RX']),
  ...['PG0', 'PG1', 'PG2', 'PG3', 'PG4', 'PG5', 'PG6', 'PG7'].map((n) => data(n, 'bidirectional', '3V3', [`GPIO`])),
];

const i2cSensor = (name: string, address: string, logic: string, stemma = false) => ({
  product_name: name,
  vendor: 'Adafruit',
  functional_categories: ['Sensing'],
  prototype_role: 'Sensor',
  main_silicon: name.split(' ')[0],
  supply_voltage_min_v: 3,
  supply_voltage_max_v: 5,
  logic_level_summary: logic,
  host_requirement: 'host_required',
  required_host_interfaces: ['I2C'],
  pins: [GND, power('VIN', 'power_in'), data('SDA', 'bidirectional', 'VIN'), data('SCL', 'bidirectional', 'VIN')],
  connectors: [
    { ref: 'J1', kind: 'header', pins: ['VIN', 'GND', 'SCL', 'SDA'] },
    ...(stemma ? [{ ref: 'QT1', kind: 'stemma_qt', pins: ['GND', 'VIN', 'SDA', 'SCL'] }] : []),
  ],
  interfaces: [{ type: 'I2C', role: 'target', addresses: [address], sda: 'SDA', scl: 'SCL' }],
});

const GAPS: PrototypeComposition['gaps'] = [
  { category: 'Sensing', need: 'LIS3MDL magnetometer (SPI)', suggestion: 'Adafruit LIS3MDL', interface: 'SPI' },
  { category: 'Sensing', need: 'MAX31856 thermocouple module (SPI)', suggestion: 'Adafruit MAX31856', interface: 'SPI' },
  { category: 'Sensing', need: 'UART ultrasonic distance sensor', suggestion: 'DFRobot A02YYUW', interface: 'UART' },
  { category: 'Sensing', need: 'Industrial CANopen vibration sensor', suggestion: '', interface: 'CAN' },
  { category: 'Sensing', need: 'Industrial CANopen pressure sensor', suggestion: '' },
  { category: 'Sensing', need: 'RS-485 Modbus soil moisture sensor', suggestion: '', interface: 'RS485' },
  { category: 'Sensing', need: 'RS-485 Modbus gas detection sensor', suggestion: '' },
  { category: 'Connectivity', need: 'GPS/GNSS receiver (UART)', suggestion: '', interface: 'UART' },
  { category: 'Connectivity', need: 'Bluetooth Low Energy module (UART)', suggestion: '' },
  { category: 'Connectivity', need: 'CAN bus transceiver module', suggestion: 'SN65HVD230', interface: 'CAN' },
  { category: 'Connectivity', need: 'RS-485 transceiver module for Modbus RTU', suggestion: 'MAX3485' },
];

describe('20-module industrial IoT brief (prod regression, 2026-10-15)', () => {
  const entities = new Map<string, LibraryEntity>();
  beforeAll(async () => {
    const add = async (id: string, facts: Record<string, unknown>) => entities.set(id, await sourced(id, facts));
    await add('HWP-NUCLEO-PROD', controllerFacts('STM32H7 Nucleo-144 Development Board', prodNucleoPins));
    await add('HWP-NUCLEO-FULL', controllerFacts('STM32H7 Nucleo-144 Development Board', fullNucleoPins));
    await add('HWP-DCDC', {
      product_name: 'DCDC 12V to 5V/3.3V Power Module',
      vendor: 'DFRobot',
      functional_categories: ['Power'],
      prototype_role: 'Regulator',
      supply_voltage_min_v: 12,
      supply_voltage_max_v: 12,
      power_source_types: ['DC input'],
      host_requirement: 'optional_host',
      pins: [power('VIN', 'power_in', 'VIN'), GND, power('5V', 'power_out', '5V'), power('3V3', 'power_out', '3V3')],
      connectors: [{ ref: 'J1', kind: 'header', pins: ['VIN', 'GND', '5V', '3V3'] }],
    });
    await add('HWP-5V-REG', {
      product_name: 'Pololu 5V, 5A Step-Down Voltage Regulator D24V50F5',
      vendor: 'Pololu',
      functional_categories: ['Power'],
      prototype_role: 'Regulator',
      supply_voltage_min_v: 6,
      supply_voltage_max_v: 38,
      power_source_types: ['DC input'],
      host_requirement: 'optional_host',
      pins: [power('VIN', 'power_in', 'VIN'), GND, power('VOUT', 'power_out', '5V')],
      connectors: [{ ref: 'J1', kind: 'header', pins: ['VIN', 'GND', 'VOUT'] }],
    });
    await add('HWP-SHT31', i2cSensor('SHT31-D Temperature & Humidity Sensor', '0x44', '3V or 5V compliant', true));
    await add('HWP-SCD41', i2cSensor('SCD41 CO2 Sensor', '0x62', '3.3V or 5V', true));
    await add('HWP-BME688', i2cSensor('BME688 Gas Sensor', '0x77', '3.3V or 5V', true));
    await add('HWP-BMP390', i2cSensor('BMP390 Pressure Sensor', '0x76', '3.3V or 5V', true));
    await add('HWP-VEML7700', i2cSensor('VEML7700 Lux Sensor', '0x10', '3.3V or 5V compatible', true));
    await add('HWP-IMU', {
      product_name: 'SparkFun 6DoF IMU Breakout - ICM-42688-P',
      vendor: 'SparkFun',
      functional_categories: ['Sensing'],
      prototype_role: 'IMU',
      supply_voltage_min_v: 1.71,
      supply_voltage_max_v: 3.6,
      logic_level_summary: '3.3V',
      host_requirement: 'host_required',
      pins: [GND, power('3V3', 'power_in', '3V3'), data('SDA'), data('SCL'), data('SCK'), data('MOSI'), data('MISO'), pin('CS', 'control', 'input', '3V3'), pin('INT', 'control', 'output', '3V3')],
      connectors: [{ ref: 'J1', kind: 'header', pins: ['GND', '3V3', 'SDA', 'SCL', 'SCK', 'MOSI', 'MISO', 'CS', 'INT'] }],
      interfaces: [
        { type: 'I2C', role: 'target', addresses: ['0x68'] },
        { type: 'SPI', role: 'target', sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' },
      ],
    });
    await add('HWP-PMS5003', {
      product_name: 'PMS5003 Particulate Matter Sensor',
      vendor: 'Adafruit',
      functional_categories: ['Sensing'],
      prototype_role: 'PM sensor',
      supply_voltage_min_v: 4.5,
      supply_voltage_max_v: 5.5,
      logic_level_summary: '3.3V',
      host_requirement: 'host_required',
      pins: [power('VCC', 'power_in', '5V'), GND, data('TX', 'output'), data('RX', 'input'), pin('RESET', 'control', 'input', '3V3'), pin('SET', 'control', 'input', '3V3')],
      connectors: [{ ref: 'J1', kind: 'header', pins: ['VCC', 'GND', 'TX', 'RX', 'RESET', 'SET'] }],
      interfaces: [{ type: 'UART', role: 'target', tx: 'TX', rx: 'RX' }],
    });
  });

  const composition = (controller: string): PrototypeComposition => ({
    kind: 'prototype_composition',
    controller: { instanceId: 'mcu', hardwareEntityId: controller },
    modules: [
      { instanceId: 'power1', hardwareEntityId: 'HWP-DCDC', role: 'Power', links: [] },
      { instanceId: 'sht31_1', hardwareEntityId: 'HWP-SHT31', role: 'Temp/RH', links: [{ interface: 'I2C' }] },
      { instanceId: 'scd41_1', hardwareEntityId: 'HWP-SCD41', role: 'CO2', links: [{ interface: 'I2C' }] },
      { instanceId: 'bme688_1', hardwareEntityId: 'HWP-BME688', role: 'Gas', links: [{ interface: 'I2C' }] },
      { instanceId: 'bmp390_1', hardwareEntityId: 'HWP-BMP390', role: 'Pressure', links: [{ interface: 'I2C' }] },
      { instanceId: 'veml7700_1', hardwareEntityId: 'HWP-VEML7700', role: 'Light', links: [{ interface: 'I2C' }] },
      { instanceId: 'imu1', hardwareEntityId: 'HWP-IMU', role: 'IMU', links: [{ interface: 'SPI' }] },
      { instanceId: 'pms5003_1', hardwareEntityId: 'HWP-PMS5003', role: 'PM', links: [{ interface: 'UART' }] },
    ],
    gaps: GAPS,
  });
  const build = (controller: string): PrototypeArchitecture =>
    assemblePrototype(composition(controller), entities, {
      svgBasePath: '/api/v1/hardware/entities',
      projectName: 'Industrial IoT',
      understanding: '',
      notes: '',
      externalSupplyVolts: externalSupplyVoltsOf(BRIEF),
    });
  const netOf = (p: PrototypeArchitecture, name: string) => p.nets.find((n) => n.name === name);
  const failing = (p: PrototypeArchitecture) => p.compatibility.results.filter((r) => r.status === 'BLOCKER');

  it('reads bus roles from pin names when a record lists no function tokens', () => {
    expect(functionsFromName('I2C0_SDA')).toEqual([{ family: 'I2C', instance: 0, role: 'SDA' }]);
    expect(functionsFromName('D14/SDA')).toEqual([{ family: 'I2C', instance: null, role: 'SDA' }]);
    expect(functionsFromName('USART3_TX')).toEqual([{ family: 'UART', instance: 3, role: 'TX' }]);
    expect(functionsFromName('FDCAN1_RX')).toEqual([{ family: 'CAN', instance: 1, role: 'RX' }]);
    expect(functionsFromName('PB7')).toEqual([]);
    expect([...linkInterfacesOf(entities.get('HWP-NUCLEO-PROD')!)]).toEqual(expect.arrayContaining(['I2C', 'SPI', 'UART']));
  });

  it('wires the I2C, SPI and UART modules on the prod STM32H7 record (was: "no free I2C bus", nothing wired)', () => {
    const p = build('HWP-NUCLEO-PROD');
    expect(failing(p).filter((r) => /no free I2C|lists no SPI/.test(r.message))).toEqual([]);
    for (const id of ['sht31_1', 'scd41_1', 'bme688_1', 'bmp390_1', 'veml7700_1']) expect(netOf(p, 'I2C0_SDA')!.members.map((m) => m.instanceId)).toContain(id);
    expect(netOf(p, 'SPI0_SCK')!.members.map((m) => m.instanceId)).toContain('imu1');
    expect(netOf(p, 'UART0_TX')!.members.map((m) => m.instanceId)).toContain('pms5003_1');
    // The IMU chip select is the SPI port's own CS pin, never a UART pin.
    const cs = netOf(p, 'IMU1_CS')!.members.find((m) => m.instanceId === 'mcu')!;
    expect(cs.pinName).toBe('SPI0_CSN');
    // That record has one UART: the extra UART devices say so honestly.
    expect(failing(p).some((r) => /no free UART .*its record lists 1 UART/.test(r.message))).toBe(true);
  });

  it('shows exactly 20 module blocks, every one wired on its bus, with CAN and RS-485 multidrop and a 12 V input', () => {
    const p = build('HWP-NUCLEO-FULL');
    const modules = p.instances.filter((i) => i.placeholder?.kind !== 'DCIN');
    expect(modules).toHaveLength(20);
    expect(p.moduleDiagram.header.summary).toMatch(/^20 modules · \d+ nets · 11 placeholders$/);
    expect(p.moduleDiagram.gapBoxes).toEqual([]);
    expect(p.instances.filter((i) => i.placeholder)).toHaveLength(12); // 11 gaps + the outside 12 V input

    // Every block (outside supply aside) is on a signal net.
    const signal = new Set(p.nets.filter((n) => n.class !== 'power' && n.class !== 'ground').flatMap((n) => n.members.map((m) => m.instanceId)));
    expect(modules.filter((i) => i.instanceId !== 'power1' && !signal.has(i.instanceId)).map((i) => i.label)).toEqual([]);

    // No check fails on this bench.
    expect(failing(p).map((r) => r.message)).toEqual([]);

    // SPI: three devices, three chip selects on three distinct plain GPIOs.
    const csNets = p.nets.filter((n) => n.class === 'spi' && /_CS$/.test(n.name));
    expect(csNets).toHaveLength(3);
    const csPins = csNets.map((n) => n.members.find((m) => m.instanceId === 'mcu')!.pinName);
    expect(new Set(csPins).size).toBe(3);
    for (const name of csPins) expect(name).toMatch(/^PG\d$/); // plain GPIOs, never a bus-capable pin

    // UART: one controller UART per serial device (PMS5003, ultrasonic, GPS, BLE, RS-485 transceiver).
    const uartTx = p.nets.filter((n) => n.class === 'uart' && /_TX$/.test(n.name));
    expect(uartTx).toHaveLength(5);

    // CAN: FDCAN1 → transceiver, CAN_H/CAN_L shared by transceiver + both CANopen sensors.
    const xcvr = p.instances.find((i) => i.placeholder?.kind === 'CANXCVR')!;
    expect(netOf(p, 'CAN1_TX')!.members.map((m) => m.instanceId).sort()).toEqual(['mcu', xcvr.instanceId].sort());
    expect(netOf(p, 'CAN_H')!.members).toHaveLength(3);
    expect(netOf(p, 'CAN_L')!.members).toHaveLength(3);
    // RS-485: UART + DE/RE line → transceiver, A/B shared with both Modbus sensors.
    const rs = p.instances.find((i) => i.placeholder?.kind === 'RS485XCVR')!;
    expect(rs.instanceId).toBe('rs485_xcvr1');
    expect(netOf(p, 'RS485_XCVR1_DE')!.members).toHaveLength(3);
    // Placeholder nets read as what they are.
    expect(p.nets.map((n) => n.name)).toEqual(expect.arrayContaining(['LIS3MDL1_CS', 'MAX31856_1_CS']));
    expect(p.instances.map((i) => i.instanceId)).toEqual(expect.arrayContaining(['gps1', 'ble1', 'ultrasonic1', 'vibration1', 'pressure1', 'soil1', 'gas1', 'can_xcvr1']));
    expect(netOf(p, 'RS485_A')!.members).toHaveLength(3);
    expect(netOf(p, 'RS485_B')!.members).toHaveLength(3);

    // Power: 12 V input → regulator; 3.3 V sensors on the 3.3 V rail; logic levels pass.
    const dcin = p.instances.find((i) => i.placeholder?.kind === 'DCIN')!;
    expect(dcin.label).toBe('12 V DC input');
    expect(netOf(p, '12V')!.members.map((m) => m.instanceId).sort()).toEqual([dcin.instanceId, 'power1'].sort());
    const rail3v3 = netOf(p, '3V3')!.members.map((m) => m.instanceId);
    for (const id of ['sht31_1', 'scd41_1', 'bme688_1', 'bmp390_1', 'veml7700_1', 'imu1']) expect(rail3v3).toContain(id);
    expect(netOf(p, '5V')!.members.map((m) => m.instanceId)).toContain('pms5003_1');
    expect(p.compatibility.results.filter((r) => r.ruleType === 'logic_voltage_compatibility' && r.status !== 'PASS')).toEqual([]);

    // Placeholders: never library records, power never guessed, one summary note.
    expect(p.hardwareLibrary.entries.some((e) => e.hardwareEntityId.startsWith('PLACEHOLDER-'))).toBe(false);
    const placeholderPins = new Set(p.instances.filter((i) => i.placeholder && i.placeholder.kind !== 'DCIN').map((i) => i.instanceId));
    expect(p.nets.filter((n) => n.class === 'power').flatMap((n) => n.members).filter((m) => placeholderPins.has(m.instanceId))).toEqual([]);
    expect(p.compatibility.results.filter((r) => r.ruleType === 'placeholder_module')).toHaveLength(1);
  });

  it('groups boards by protocol on the diagram: one protocol never splits within a row', () => {
    const p = build('HWP-NUCLEO-FULL');
    const groups = new Map(
      withProtocolGroups(
        p.instances.map((i) => ({ instanceId: i.instanceId, label: i.label, isController: i.isController, width: 1, height: 1, anchors: new Map(), badge: null })),
        p.nets
      ).map((i) => [i.instanceId, i.group ?? 'controller'])
    );
    expect(groups.get('sht31_1')).toBe('i2c');
    expect(groups.get('imu1')).toBe('spi');
    expect(groups.get('pms5003_1')).toBe('uart');
    expect(groups.get(p.instances.find((i) => i.placeholder?.kind === 'CANXCVR')!.instanceId)).toBe('can');
    expect(groups.get(p.instances.find((i) => i.placeholder?.kind === 'RS485XCVR')!.instanceId)).toBe('rs485');
    // Rows: boards whose boxes share most of their height. In each row, left to right (controller
    // aside), a group's boards are contiguous.
    const boxes = p.moduleDiagram.modules.map((m) => ({ id: m.instanceId, ...m.content! }));
    const rows: Array<typeof boxes> = [];
    for (const b of [...boxes].sort((a, c) => a.x - c.x)) {
      const row = rows.find((r) => r.some((o) => Math.min(o.y + o.height, b.y + b.height) - Math.max(o.y, b.y) > 0.5 * Math.min(o.height, b.height)));
      if (row) row.push(b);
      else rows.push([b]);
    }
    for (const row of rows) {
      const seq = row.filter((b) => b.id !== 'mcu').map((b) => groups.get(b.id));
      const runs = seq.filter((g, i) => i === 0 || g !== seq[i - 1]);
      expect(new Set(runs).size).toBe(runs.length);
    }
  });

  it('draws placeholders from their id and label alone (never stored)', () => {
    const p = build('HWP-NUCLEO-FULL');
    const ph = p.instances.find((i) => i.placeholder?.kind === 'RS485XCVR')!;
    expect(ph.svg!.url).toContain('name=');
    const rebuilt = withPlaceholderEntities(new Map(), [ph]).get(ph.hardwareEntityId)!;
    expect(rebuilt.record.identity.product_name).toBe(ph.label);
    const art = renderBenchArt(rebuilt.record, false);
    expect(art.kind).toBe('placeholder');
    expect(art.svg).toContain('PLACEHOLDER');
    expect(art.hash).toBe(ph.svg!.hash);
    expect(placeholderEntity('HWP-NOT-A-PLACEHOLDER', 'x')).toBeNull();
  });

  it('reads the placeholder kind from the gap when the resolver gives no interface', () => {
    expect(placeholderKindFor({ category: 'Sensing', need: 'Industrial CANopen pressure sensor', suggestion: '' })).toBe('CAN');
    expect(placeholderKindFor({ category: 'Connectivity', need: 'CAN bus transceiver module', suggestion: '' })).toBe('CANXCVR');
    expect(placeholderKindFor({ category: 'Sensing', need: 'RS-485 Modbus gas detection sensor', suggestion: '' })).toBe('RS485');
    expect(placeholderKindFor({ category: 'Connectivity', need: 'RS-485 transceiver module for Modbus RTU', suggestion: '' })).toBe('RS485XCVR');
    expect(placeholderKindFor({ category: 'Connectivity', need: 'Bluetooth Low Energy module', suggestion: '' })).toBe('UART');
    expect(placeholderKindFor({ category: 'Sensing', need: 'a sensor that can measure light', suggestion: '' })).toBe('NONE');
    expect(externalSupplyVoltsOf('Power supply module with 12V input, 5V and 3.3V outputs')).toBe(12);
    expect(externalSupplyVoltsOf('powered from 24 V')).toBe(24);
    expect(externalSupplyVoltsOf('a 3.3V sensor')).toBeNull();
  });

  it('dev run 2026-10-16: 3-5 V sensors take the controller 3.3 V rail when the regulator only gives 5 V', () => {
    const c = composition('HWP-NUCLEO-FULL');
    c.modules[0] = { instanceId: 'psu1', hardwareEntityId: 'HWP-5V-REG', role: 'Power', links: [] };
    const p = assemblePrototype(c, entities, { svgBasePath: '/x', projectName: 'x', understanding: '', notes: '', externalSupplyVolts: 12 });
    const rail3v3 = netOf(p, '3V3')!.members.map((m) => `${m.instanceId}.${m.pinName}`);
    expect(rail3v3).toEqual(expect.arrayContaining(['mcu.3V3', 'sht31_1.VIN', 'veml7700_1.VIN', 'imu1.3V3']));
    expect(netOf(p, '5V')!.members.map((m) => m.instanceId)).toEqual(expect.arrayContaining(['psu1', 'pms5003_1']));
    expect(netOf(p, '5V')!.members.map((m) => m.instanceId)).not.toContain('sht31_1');
    expect(netOf(p, '12V')!.members.map((m) => m.instanceId).sort()).toEqual(['dcin', 'psu1']);
  });

  it('dev run 2026-10-16: one UART instance serves one device, even when it is offered on several pin pairs', async () => {
    const pico = await loadFixtureEntity(FIXTURE_IDS.pico);
    const p = assemblePrototype(
      {
        kind: 'prototype_composition',
        controller: { instanceId: 'mcu', hardwareEntityId: pico.hardwareEntityId },
        modules: [],
        gaps: [
          { category: 'Connectivity', need: 'GPS receiver (UART)', suggestion: '', interface: 'UART' },
          { category: 'Connectivity', need: 'Bluetooth LE module (UART)', suggestion: '', interface: 'UART' },
          { category: 'Sensing', need: 'Ultrasonic sensor (UART)', suggestion: '', interface: 'UART' },
        ],
      },
      new Map([[pico.hardwareEntityId, pico]]),
      { svgBasePath: '/x', projectName: 'x', understanding: '', notes: '' }
    );
    const uartNets = p.nets.filter((n) => n.class === 'uart');
    for (const n of uartNets) expect(n.members.filter((m) => m.instanceId !== 'mcu')).toHaveLength(1);
    expect(new Set(uartNets.map((n) => n.name.split('_')[0])).size).toBe(uartNets.length / 2);
    // The Pico has two UARTs: the third device is told so, once.
    const noUart = p.compatibility.results.filter((r) => /no free UART/.test(r.message));
    expect(noUart).toHaveLength(1);
    expect(p.compatibility.results.filter((r) => r.ruleType === 'signal_direction_conflict' && r.status === 'BLOCKER')).toEqual([]);
  });

  it('dev run 2026-10-16: a CANopen / Modbus sensor is a bus device even when its suggestion mentions a transceiver', () => {
    expect(placeholderKindFor({ category: 'Sensing', need: 'Industrial CANopen vibration sensor module', suggestion: 'any CANopen sensor with an on-board CAN transceiver', interface: 'CAN' })).toBe('CAN');
    expect(placeholderKindFor({ category: 'Sensing', need: 'Industrial RS-485 Modbus gas detection sensor module', suggestion: 'RS-485 transceiver built in', interface: 'RS485' })).toBe('RS485');
    expect(placeholderKindFor({ category: 'Connectivity', need: 'RS-485 transceiver module for Modbus RTU', suggestion: '', interface: 'RS485' })).toBe('RS485XCVR');
  });

  it('dev run 2026-10-16: a named controller that is not in the library is a Processing gap, not a substitute', () => {
    const lib = new Map([['HWP-IMU', entities.get('HWP-IMU')!]]);
    const out = resolverOutputSchema.parse({
      isPrototypeRequest: true,
      controller: null,
      modules: [{ instanceId: 'imu1', hardwareEntityId: 'HWP-IMU', role: 'IMU', links: [{ interface: 'SPI' }] }],
      gaps: [{ category: 'Processing', need: 'STM32H7 Nucleo-144 development board', interface: 'NONE' }],
    });
    expect(validateResolverOutput(out, lib)).toEqual([]);
    expect(isControllerGap(out.gaps[0]!)).toBe(true);
    expect(validateResolverOutput({ ...out, gaps: [] }, lib).join(' ')).toMatch(/no controller/);
  });

  it('dev run 2026-10-16: "accessories" that are really the host, wiring or a supply raise no warning', async () => {
    const xcvr = await sourced('HWP-CANX', {
      product_name: 'Waveshare SN65HVD230 CAN Board',
      vendor: 'Waveshare',
      functional_categories: ['Connectivity'],
      prototype_role: 'CAN transceiver',
      supply_voltage_min_v: 3.3,
      supply_voltage_max_v: 3.3,
      logic_level_summary: '3.3V',
      host_requirement: 'host_required',
      pins: [power('3V3', 'power_in', '3V3'), GND, data('CTX', 'input'), data('CRX', 'output'), pin('CANH', 'other', 'bidirectional'), pin('CANL', 'other', 'bidirectional')],
      connectors: [{ ref: 'J1', kind: 'header', pins: ['3V3', 'GND', 'CTX', 'CRX', 'CANH', 'CANL'] }],
      interfaces: [{ type: 'CAN', role: 'transceiver', tx: 'CTX', rx: 'CRX' }],
      required_accessories: ['MCU or controller with CAN peripheral', 'CAN bus wiring to CANH/CANL', '120 ohm termination resistor'],
    });
    const lib = new Map(entities);
    lib.set('HWP-CANX', xcvr);
    const p = assemblePrototype(
      { kind: 'prototype_composition', controller: { instanceId: 'mcu', hardwareEntityId: 'HWP-NUCLEO-FULL' }, modules: [{ instanceId: 'can1', hardwareEntityId: 'HWP-CANX', role: 'CAN', links: [{ interface: 'CAN' }] }], gaps: [] },
      lib,
      { svgBasePath: '/x', projectName: 'x', understanding: '', notes: '' }
    );
    const deps = p.compatibility.results.filter((r) => r.ruleType === 'dependency_presence').map((r) => r.message);
    expect(deps).toEqual(['Waveshare SN65HVD230 CAN Board requires 120 ohm termination resistor.']);
    // CTX/CRX are found by name: the transceiver is on FDCAN1.
    expect(netOf(p, 'CAN1_TX')!.members.map((m) => m.pinName).sort()).toEqual(['CTX', 'PD1']);
  });

  it('dev run 2026-10-16: a selection naming the controller as a module is repaired, not a failed run', () => {
    const lib = new Map([...entities].filter(([id]) => ['HWP-NUCLEO-FULL', 'HWP-IMU', 'HWP-SHT31'].includes(id)));
    const out = resolverOutputSchema.parse({
      isPrototypeRequest: true,
      controller: { hardwareEntityId: 'HWP-NUCLEO-FULL', role: 'main' },
      modules: [
        { instanceId: 'pwr1', hardwareEntityId: 'HWP-NUCLEO-FULL', role: 'Power supply 12V to 5V and 3.3V', links: [] },
        { instanceId: 'imu1', hardwareEntityId: 'HWP-IMU', role: 'IMU', links: [{ interface: 'SPI' }, { interface: 'UART' }] },
        { instanceId: 'x1', hardwareEntityId: 'HWP-NOT-THERE', role: 'GPS receiver', links: [{ interface: 'UART' }] },
      ],
    });
    expect(validateResolverOutput(out, lib).length).toBeGreaterThan(0);
    const fixed = repairResolverOutput(out, lib);
    expect(validateResolverOutput(fixed, lib)).toEqual([]);
    expect(fixed.controller?.hardwareEntityId).toBe('HWP-NUCLEO-FULL');
    expect(fixed.modules.map((m) => m.instanceId)).toEqual(['imu1']);
    expect(fixed.modules[0]!.links).toEqual([{ interface: 'SPI' }]);
    expect(fixed.gaps.map((g) => [g.category, g.need, g.interface])).toEqual([
      ['Power', 'Power supply 12V to 5V and 3.3V', 'NONE'],
      ['Interface', 'GPS receiver', 'UART'],
    ]);
  });
});
