import { describe, it, expect } from '@jest/globals';
import { prepareBundle } from '../../src/modules/hardware/hardware-admin.service.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { answersNeed, factsSchema, factsToBoard, normaliseFacts, withReferenceAddresses } from '../../src/modules/hardware/discovery/hardware-sourcer.js';
import { buildRecord, buildSvg } from '../../src/modules/hardware/discovery/record-builder.js';
import { isControllerRecord } from '../../src/modules/hardware/hardware.schema.js';
import { parseModuleSvg } from '../../src/modules/hardware/hardware-svg.js';
import { REFERENCE_BOARDS, referenceBoardFor } from '../../src/modules/hardware/reference/controller-boards.js';
import { assemblePrototype } from '../../src/modules/sessions/prototype/prototype-assembler.js';
import { outsidePartsOf } from '../../src/modules/sessions/prototype/prototype-outside-parts.js';
import { PrototypeArchitecture, PrototypeComposition } from '../../src/modules/sessions/prototype/prototype.types.js';

/**
 * Adversarial edge cases for the deterministic Prototype pipeline (allocator, checks, outside
 * parts, I2C addresses, sourcing helpers). Boards are built the way live sourcing builds them.
 * Where the behaviour is an engineering judgement, the test asserts what a careful engineer expects.
 */

const SESSION = '22222222-2222-2222-2222-222222222222';

type Pin = { name: string; signal_class: string; direction: string; voltage_domain: string | null; functions?: string[] };
const pin = (name: string, signal_class: string, direction: string, voltage_domain: string | null = null, functions: string[] = []): Pin => ({ name, signal_class, direction, voltage_domain, functions });
const pwr = (name: string, dir: 'power_in' | 'power_out', domain: string | null = null) => pin(name, 'power', dir, domain);
const GND = pin('GND', 'ground', 'ground');
const io = (name: string, dir = 'bidirectional', domain: string | null = '3V3') => pin(name, 'data', dir, domain);
const other = (name: string) => pin(name, 'other', 'bidirectional');

const entityOf = (id: string, record: Record<string, unknown>, svg: string, verification = 'inferred'): LibraryEntity => {
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
    verificationMethod: verification,
    recordOrigin: 'vendor_agent',
    projectId: SESSION,
    isController: isControllerRecord(bundle.record),
    record: bundle.record,
    sources: [],
    svg: { hash: `h-${id}`, markup: bundle.svg, parsed: parseModuleSvg(bundle.svg) },
  };
};

function sourced(id: string, facts: Record<string, unknown>): LibraryEntity {
  const parsed = factsSchema.parse(normaliseFacts({ secondary_ics: [], required_accessories: [], notes: [], facts_source: 'vendor_page', ...facts }));
  const board = factsToBoard(parsed, id, `FAM-${id}`, null);
  const record = buildRecord(board, { scope: 'private_project', project_id: SESSION, record_origin: 'vendor_agent', verification_method: 'vendor_live' });
  return entityOf(id, record, buildSvg(board).svg, 'vendor_live');
}

function reference(id: string, name: string): LibraryEntity {
  const ref = REFERENCE_BOARDS.find((b) => b.facts.product_name === name);
  if (!ref) throw new Error(`no reference ${name}`);
  const board = factsToBoard(factsSchema.parse(ref.facts), id, `FAM-${id}`, ref.sourceUrl);
  const record = buildRecord(board, { verification_method: 'manual_verified', record_origin: 'embedo_curated', scope: 'private_project', project_id: SESSION });
  return entityOf(id, record, buildSvg(board).svg, 'manual_verified');
}

// --- module facts ----------------------------------------------------------------------------------
const header = (pins: Pin[], ref = 'J1') => [{ ref, kind: 'header', pins: pins.map((p) => p.name) }];
const mod = (name: string, pins: Pin[], extra: Record<string, unknown> = {}) => ({
  product_name: name,
  vendor: 'Adafruit',
  functional_categories: ['Sensing'],
  prototype_role: 'Sensor',
  main_silicon: name,
  supply_voltage_min_v: 3,
  supply_voltage_max_v: 5.5,
  logic_level_summary: '3.3V',
  host_requirement: 'host_required',
  pins,
  connectors: header(pins),
  ...extra,
});
const uartModule = (name: string) =>
  mod(name, [pwr('VCC', 'power_in'), GND, io('TX', 'output'), io('RX', 'input')], { interfaces: [{ type: 'UART', role: 'target', tx: 'TX', rx: 'RX' }] });
const i2cModule = (name: string, silicon: string, addresses: string[], extraPins: Pin[] = [], vendor = 'Adafruit', logic = '3.3V or 5V compatible') =>
  mod(name, [pwr('VIN', 'power_in'), GND, io('SDA', 'bidirectional', null), io('SCL', 'bidirectional', null), ...extraPins], {
    vendor,
    main_silicon: silicon,
    logic_level_summary: logic,
    interfaces: [{ type: 'I2C', role: 'target', addresses, sda: 'SDA', scl: 'SCL' }],
  });
const spiModule = (name: string, domain = '3V3', logic = '3.3V') =>
  mod(name, [pwr('VIN', 'power_in'), GND, io('SCK', 'input', domain), io('MOSI', 'input', domain), io('MISO', 'output', domain), io('CS', 'input', domain)], {
    logic_level_summary: logic,
    supply_voltage_min_v: 3,
    supply_voltage_max_v: 3.6,
    interfaces: [{ type: 'SPI', role: 'target', sck: 'SCK', mosi: 'MOSI', miso: 'MISO', cs: 'CS' }],
  });
const CAN_XCVR = mod('SN65HVD230 CAN Transceiver', [pwr('VCC', 'power_in', '3V3'), GND, io('TXD', 'input'), io('RXD', 'output'), other('CANH'), other('CANL')], {
  functional_categories: ['Connectivity'],
  main_silicon: 'SN65HVD230',
  supply_voltage_min_v: 3,
  supply_voltage_max_v: 3.6,
  interfaces: [{ type: 'CAN', role: 'transceiver', tx: 'TXD', rx: 'RXD' }],
});
const CAN_DEVICE = mod('CAN pressure sensor node', [pwr('V+', 'power_in'), GND, other('CANH'), other('CANL')], {
  supply_voltage_min_v: 9,
  supply_voltage_max_v: 30,
  interfaces: [{ type: 'CAN', role: 'device' }],
});
const HCSR04 = mod('HC-SR04 Ultrasonic Distance Sensor', [pwr('VCC', 'power_in', '5V'), GND, io('Trig', 'input', '5V'), io('Echo', 'output', '5V')], {
  main_silicon: 'HC-SR04',
  supply_voltage_min_v: 5,
  supply_voltage_max_v: 5,
  logic_level_summary: '5V',
});
const L298N = mod(
  'L298N Dual H-Bridge Motor Driver',
  [io('IN1', 'input', '5V'), io('IN2', 'input', '5V'), io('IN3', 'input', '5V'), io('IN4', 'input', '5V'), io('ENA', 'input', '5V'), io('ENB', 'input', '5V'), pin('OUT1', 'data', 'bidirectional', 'VIN'), pin('OUT2', 'data', 'bidirectional', 'VIN'), pin('OUT3', 'data', 'bidirectional', 'VIN'), pin('OUT4', 'data', 'bidirectional', 'VIN'), pwr('VCC', 'power_in', 'VIN'), GND],
  { functional_categories: ['Motor/Actuation'], main_silicon: 'L298N', supply_voltage_min_v: 5, supply_voltage_max_v: 35, logic_level_summary: '5V logic' }
);
const WS2812 = mod('NeoPixel Ring 12 x WS2812B', [pwr('VCC', 'power_in', '5V'), GND, io('DIN', 'input', '5V')], {
  functional_categories: ['Display/UI'],
  main_silicon: 'WS2812B',
  supply_voltage_min_v: 4.5,
  supply_voltage_max_v: 5.5,
  logic_level_summary: '5V',
});
const RELAY = mod('Single Channel Relay Module', [pwr('VCC', 'power_in', '5V'), GND, io('IN', 'input', '5V'), other('NO'), other('COM'), other('NC')], {
  functional_categories: ['Motor/Actuation'],
  main_silicon: 'Single Channel Relay Module',
  supply_voltage_min_v: 5,
  supply_voltage_max_v: 5,
  logic_level_summary: '5V',
});
const FIVE_V_MODULE = mod('PMS5003 Particulate Matter Sensor', [pwr('VCC', 'power_in', '5V'), GND, io('TX', 'output'), io('RX', 'input')], {
  main_silicon: 'PMS5003',
  supply_voltage_min_v: 4.5,
  supply_voltage_max_v: 5.5,
  interfaces: [{ type: 'UART', role: 'target', tx: 'TX', rx: 'RX' }],
});
const BOOST = mod('PowerBoost 1000 Basic - 5V USB Boost', [pwr('BAT', 'power_in', 'VIN'), GND, pwr('5V', 'power_out', '5V'), io('EN', 'input', null)], {
  functional_categories: ['Power'],
  main_silicon: 'TPS61030',
  supply_voltage_min_v: 1.8,
  supply_voltage_max_v: null,
  power_source_types: ['Battery'],
  host_requirement: 'optional_host',
});
const BUCK = mod('D24V22F5 Step-Down Voltage Regulator', [pwr('VIN', 'power_in', 'VIN'), pwr('VOUT', 'power_out', '5V'), GND], {
  functional_categories: ['Power'],
  main_silicon: 'D24V22F5',
  supply_voltage_min_v: 6,
  supply_voltage_max_v: 36,
  power_source_types: ['DC'],
  host_requirement: 'optional_host',
});
const CHARGER = mod('Adafruit Micro Lipo USB LiPoly charger', [pwr('5V', 'power_in', '5V'), pwr('BAT', 'power_out', 'VIN'), GND], {
  functional_categories: ['Power'],
  main_silicon: 'MCP73831',
  supply_voltage_min_v: 5,
  supply_voltage_max_v: 5,
  power_source_types: ['USB'],
  host_requirement: 'optional_host',
});

const LIB: Record<string, Record<string, unknown>> = {
  UARTA: uartModule('GPS Module A'),
  UARTB: uartModule('BLE UART Module B'),
  UARTC: uartModule('LoRa UART Module C'),
  UARTD: uartModule('RFID UART Module D'),
  UARTE: uartModule('Fingerprint UART Module E'),
  UARTF: uartModule('Thermal printer UART F'),
  UARTG: uartModule('Modem UART G'),
  UARTH: uartModule('Nextion UART H'),
  UARTI: uartModule('Lidar UART I'),
  SHT31: i2cModule('Adafruit SHT31-D Breakout', 'SHT31-D', ['0x44', '0x45']),
  SHT40A: i2cModule('Adafruit SHT40 Breakout A', 'SHT40', ['0x44']),
  SHT40B: i2cModule('Adafruit SHT40 Breakout B', 'SHT40', ['0x44']),
  SHT40C: i2cModule('Adafruit SHT40 Breakout C', 'SHT40', ['0x44']),
  BMP390: i2cModule('Adafruit BMP390 Breakout', 'BMP390', ['0x77', '0x76']),
  BMP390NOSDO: i2cModule('Adafruit BMP390 STEMMA only', 'BMP390', ['0x77']),
  BME688SDO: i2cModule('Adafruit BME688 Breakout', 'BME688', ['0x77', '0x76'], [io('SDO', 'bidirectional', null)]),
  BME688NOSDO: i2cModule('Adafruit BME688 no SDO', 'BME688', ['0x77']),
  MCP4725: i2cModule('Adafruit MCP4725 DAC', 'MCP4725', ['0x62', '0x63']),
  SCD41: i2cModule('Adafruit SCD-41 CO2', 'SCD41', ['0x62']),
  MYSTERY: i2cModule('Mystery I2C Widget', 'XQ-9000', []),
  SPI3V3: spiModule('3.3V SPI Sensor'),
  SPIB: spiModule('3.3V SPI Sensor B'),
  CANX1: CAN_XCVR,
  CANX2: { ...CAN_XCVR, product_name: 'SN65HVD230 CAN Transceiver #2' },
  CANDEV: CAN_DEVICE,
  HCSR04,
  L298N,
  WS2812,
  RELAY,
  FIVEV: FIVE_V_MODULE,
  BOOST,
  BUCK,
  CHARGER,
  NOGND: mod('Weird board without ground', [pwr('VIN', 'power_in'), io('OUT', 'output')]),
};

const cache = new Map<string, LibraryEntity>();
const lib = (key: string): LibraryEntity => {
  if (!cache.has(key)) cache.set(key, sourced(`HWP-${key}`, LIB[key]!));
  return cache.get(key)!;
};
const REF_IDS: Record<string, string> = {
  H743: 'NUCLEO-H743ZI2',
  F446: 'NUCLEO-F446RE',
  PICO: 'Raspberry Pi Pico',
  PICOW: 'Raspberry Pi Pico W',
  PICO2: 'Raspberry Pi Pico 2',
  ESP32S3: 'ESP32-S3-DevKitC-1',
  NANO33: 'Arduino Nano 33 IoT',
  UNO: 'Arduino UNO R3',
};
const ref = (key: string): LibraryEntity => {
  const id = `HWR-${key}`;
  if (!cache.has(id)) cache.set(id, reference(id, REF_IDS[key]!));
  return cache.get(id)!;
};

type Mod = { id: string; key: string; links?: PrototypeComposition['modules'][number]['links'] };
function build(controller: string, modules: Mod[], opts: { brief?: string; gaps?: PrototypeComposition['gaps']; volts?: number | null } = {}): PrototypeArchitecture {
  const entities = new Map<string, LibraryEntity>();
  const mcu = ref(controller);
  entities.set(mcu.hardwareEntityId, mcu);
  for (const m of modules) entities.set(`HWP-${m.key}`, lib(m.key));
  const composition: PrototypeComposition = {
    kind: 'prototype_composition',
    controller: { instanceId: 'mcu', hardwareEntityId: mcu.hardwareEntityId },
    modules: modules.map((m) => ({ instanceId: m.id, hardwareEntityId: `HWP-${m.key}`, role: m.key, links: m.links ?? [] })),
    gaps: opts.gaps ?? [],
  };
  return assemblePrototype(composition, entities, {
    svgBasePath: '/api/v1/hardware/entities',
    projectName: 'Edge',
    understanding: '',
    notes: '',
    externalSupplyVolts: opts.volts ?? null,
    brief: opts.brief,
  });
}

const results = (p: PrototypeArchitecture, status?: string, rule?: string) =>
  p.compatibility.results.filter((r) => (!status || r.status === status) && (!rule || r.ruleType === rule));
const netsWith = (p: PrototypeArchitecture, instanceId: string, pinName?: string) =>
  p.nets.filter((n) => n.members.some((m) => m.instanceId === instanceId && (!pinName || m.pinName === pinName)));
const mcuPinsUsed = (p: PrototypeArchitecture) => new Set(p.nets.flatMap((n) => n.members.filter((m) => m.instanceId === 'mcu').map((m) => m.pinName)));
const uartOf = (p: PrototypeArchitecture, id: string) => netsWith(p, id).find((n) => n.class === 'uart')?.name.replace(/_(TX|RX)$/, '') ?? null;

const UART_COUNT: Record<string, number> = { H743: 8, F446: 5, PICO: 2, PICOW: 2, PICO2: 2, ESP32S3: 2, NANO33: 1, UNO: 1 };
const COMMON_RESERVED = 'PA13|PA14|PB3|PC13|PC14|PC15|PH0|PH1|GPIO0|GPIO3|GPIO19|GPIO20|GPIO35|GPIO36|GPIO37|GPIO38|GPIO43|GPIO44|GPIO45|GPIO46|GPIO48|3V3_EN|RUN|ADC_VREF|RST|RESET|AREF|IOREF';
/** Per board: Nucleo-64 VCP is PA2/PA3; Nucleo-144 VCP PD8/PD9, USB PA9-PA12, Ethernet RMII, LEDs. */
const RESERVED_FOR: Record<string, RegExp> = {
  F446: new RegExp(`^(${COMMON_RESERVED}|PA2|PA3)$`),
  H743: new RegExp(`^(${COMMON_RESERVED}|PD8|PD9|PA9|PA10|PA11|PA12|PA1|PA2|PA7|PC1|PC4|PC5|PG11|PG13|PB13|PB0|PB14)$`),
};
const reservedFor = (key: string) => RESERVED_FOR[key] ?? new RegExp(`^(${COMMON_RESERVED})$`);

// =====================================================================================================
describe('1. reference controllers', () => {
  for (const key of Object.keys(REF_IDS)) {
    it(`${REF_IDS[key]}: valid record, buses allocatable, ${UART_COUNT[key]} UART(s), no reserved pin wired`, () => {
      const e = ref(key);
      expect(e.isController).toBe(true);
      const uarts = new Set<string>();
      for (const p of e.record.pins) {
        for (const f of p.functions) {
          const m = /^UART(\d+)_(TX|RX)$/.exec(f);
          if (m) uarts.add(m[1]!);
        }
      }
      // Only instances with both a TX and an RX pin count.
      const complete = [...uarts].filter((n) => e.record.pins.some((p) => p.functions.includes(`UART${n}_TX`)) && e.record.pins.some((p) => p.functions.includes(`UART${n}_RX`)));
      expect(complete.length).toBe(UART_COUNT[key]);

      const p = build(key, [
        { id: 'sht1', key: 'SHT31', links: [{ interface: 'I2C' }] },
        { id: 'spi1', key: 'SPI3V3', links: [{ interface: 'SPI' }] },
        { id: 'gps1', key: 'UARTA', links: [{ interface: 'UART' }] },
      ]);
      for (const id of ['sht1', 'spi1', 'gps1']) expect(results(p, 'BLOCKER').filter((r) => r.instanceIds.includes(id) && r.ruleType === 'required_host_interface')).toEqual([]);
      expect(netsWith(p, 'sht1').some((n) => n.class === 'i2c')).toBe(true);
      expect(netsWith(p, 'spi1', 'CS').length).toBe(1);
      expect(uartOf(p, 'gps1')).not.toBeNull();
      for (const name of mcuPinsUsed(p)) if (!/^(GND|3V3|5V|VIN|E5V|VSYS|VBUS|AGND)$/.test(name)) expect(name).not.toMatch(reservedFor(key));
    });
  }
});

describe('2. UART exhaustion', () => {
  it('Pico with 4 UART devices: two get UART0/UART1, two get one honest BLOCKER each naming the count; no UART shared', () => {
    const p = build('PICO', ['UARTA', 'UARTB', 'UARTC', 'UARTD'].map((k, i) => ({ id: `u${i + 1}`, key: k, links: [{ interface: 'UART' as const }] })));
    const used = ['u1', 'u2', 'u3', 'u4'].map((id) => uartOf(p, id));
    const wired = used.filter(Boolean);
    expect(wired.length).toBe(2);
    expect(new Set(wired).size).toBe(2);
    const fails = results(p, 'BLOCKER').filter((r) => /no free UART/.test(r.message));
    expect(fails.length).toBe(2);
    for (const f of fails) expect(f.message).toMatch(/lists 2 UARTs/);
  });

  it('H743 with 9 UART devices: 8 wired on 8 distinct UARTs, the 9th fails', () => {
    const keys = ['UARTA', 'UARTB', 'UARTC', 'UARTD', 'UARTE', 'UARTF', 'UARTG', 'UARTH', 'UARTI'];
    const p = build('H743', keys.map((k, i) => ({ id: `u${i + 1}`, key: k, links: [{ interface: 'UART' as const }] })));
    const wired = keys.map((_, i) => uartOf(p, `u${i + 1}`)).filter(Boolean);
    expect(wired.length).toBe(8);
    expect(new Set(wired).size).toBe(8);
    expect(results(p, 'BLOCKER').filter((r) => /no free UART/.test(r.message)).length).toBe(1);
  });
});

describe('3. CAN', () => {
  it('CAN devices with no transceiver: one BLOCKER asking for a transceiver', () => {
    const p = build('H743', [
      { id: 'node1', key: 'CANDEV', links: [{ interface: 'CAN' }] },
    ]);
    expect(results(p, 'BLOCKER').some((r) => /transceiver/i.test(r.message))).toBe(true);
  });

  it('transceiver on a Pico (no CAN controller): UNKNOWN or BLOCKER, no crash, never wired to a GPIO', () => {
    const p = build('PICO', [
      { id: 'xcvr1', key: 'CANX1', links: [{ interface: 'CAN' }] },
      { id: 'node1', key: 'CANDEV', links: [{ interface: 'CAN' }] },
    ]);
    expect(results(p).some((r) => (r.status === 'UNKNOWN' || r.status === 'BLOCKER') && /CAN/.test(r.message))).toBe(true);
    expect(netsWith(p, 'xcvr1', 'TXD').filter((n) => n.members.some((m) => m.instanceId === 'mcu'))).toEqual([]);
  });

  it('two transceivers on H743 use FDCAN1 and FDCAN2', () => {
    const p = build('H743', [
      { id: 'xcvr1', key: 'CANX1', links: [{ interface: 'CAN' }] },
      { id: 'xcvr2', key: 'CANX2', links: [{ interface: 'CAN' }] },
    ]);
    const names = new Set(p.nets.filter((n) => /^CAN\d_TX$/.test(n.name)).map((n) => n.name));
    expect(names).toEqual(new Set(['CAN1_TX', 'CAN2_TX']));
    expect(results(p, 'BLOCKER')).toEqual([]);
  });
});

describe('4. I2C addresses', () => {
  const addr = (p: PrototypeArchitecture, id: string) => p.moduleDiagram.modules.find((m) => m.instanceId === id)?.badge ?? null;

  it('three fixed-0x44 SHT40s: BLOCKER with a multiplexer fix', () => {
    const p = build('F446', [
      { id: 'a', key: 'SHT40A', links: [{ interface: 'I2C' }] },
      { id: 'b', key: 'SHT40B', links: [{ interface: 'I2C' }] },
      { id: 'c', key: 'SHT40C', links: [{ interface: 'I2C' }] },
    ]);
    const clash = results(p, 'BLOCKER', 'bus_address_conflict');
    expect(clash.length).toBeGreaterThan(0);
    expect(clash.every((r) => /multiplexer|TCA9548/i.test(r.suggestedFix ?? ''))).toBe(true);
  });

  it('BMP390 + BME688 with SDO on the header: one moves to 0x76 with its SDO strapped to GND, no failure', () => {
    const p = build('F446', [
      { id: 'bmp', key: 'BMP390', links: [{ interface: 'I2C' }] },
      { id: 'bme', key: 'BME688SDO', links: [{ interface: 'I2C' }] },
    ]);
    expect(results(p, 'BLOCKER', 'bus_address_conflict')).toEqual([]);
    expect(new Set([addr(p, 'bmp'), addr(p, 'bme')])).toEqual(new Set(['I²C 0x77', 'I²C 0x76']));
    expect(addr(p, 'bme')).toBe('I²C 0x76');
    expect(netsWith(p, 'bme', 'SDO').some((n) => n.name === 'GND')).toBe(true);
  });

  it('BMP390 + BME688, neither SDO on the header: WARNING telling how to set the alternate', () => {
    const p = build('F446', [
      { id: 'bmp', key: 'BMP390NOSDO', links: [{ interface: 'I2C' }] },
      { id: 'bme', key: 'BME688NOSDO', links: [{ interface: 'I2C' }] },
    ]);
    expect(results(p, 'BLOCKER', 'bus_address_conflict')).toEqual([]);
    const warn = results(p, 'WARNING', 'bus_address_conflict');
    expect(warn.length).toBe(1);
    expect(warn[0]!.suggestedFix ?? '').toMatch(/SDO|address/i);
  });

  it('MCP4725 + SCD41 both 0x62: MCP4725 moves to 0x63', () => {
    const p = build('F446', [
      { id: 'dac', key: 'MCP4725', links: [{ interface: 'I2C' }] },
      { id: 'co2', key: 'SCD41', links: [{ interface: 'I2C' }] },
    ]);
    expect(addr(p, 'co2')).toBe('I²C 0x62');
    expect(addr(p, 'dac')).toBe('I²C 0x63');
    expect(results(p, 'BLOCKER', 'bus_address_conflict')).toEqual([]);
  });

  it('an unknown chip with no address: UNKNOWN, never a pass', () => {
    const p = build('F446', [{ id: 'w', key: 'MYSTERY', links: [{ interface: 'I2C' }] }]);
    expect(results(p, 'UNKNOWN', 'bus_address_conflict').length).toBe(1);
    expect(results(p, 'PASS', 'bus_address_conflict')).toEqual([]);
  });
});

describe('5. logic levels', () => {
  it('Uno (5 V) driving a 3.3 V SPI sensor input: BLOCKER', () => {
    const p = build('UNO', [{ id: 's', key: 'SPI3V3', links: [{ interface: 'SPI' }] }]);
    expect(results(p, 'BLOCKER', 'logic_voltage_compatibility').length).toBeGreaterThan(0);
  });

  it('3.3 V module output into the Uno (UART TX → RX): passes; the Uno driving its 3.3 V RX fails', () => {
    const p = build('UNO', [{ id: 'g', key: 'UARTA', links: [{ interface: 'UART' }] }]);
    const fails = results(p, 'BLOCKER', 'logic_voltage_compatibility');
    expect(fails.every((r) => !/\bTX\b \(3\.3 V\)/.test(r.message))).toBe(true);
    expect(fails.some((r) => /RX/.test(r.message))).toBe(true);
  });

  it('HC-SR04 echo (5 V out) on the F446: lands on a 5 V tolerant pin and passes', () => {
    const p = build('F446', [{ id: 'us', key: 'HCSR04', links: [{ interface: 'GPIO', pinName: 'Trig' }, { interface: 'GPIO', pinName: 'Echo' }] }]);
    const echo = netsWith(p, 'us', 'Echo')[0]!;
    const mcuPin = echo.members.find((m) => m.instanceId === 'mcu')!;
    const rec = ref('F446').record.pins.find((x) => x.pin_name === mcuPin.pinName)!;
    expect(rec.voltage_domain).toMatch(/FT/);
    expect(results(p, 'BLOCKER', 'logic_voltage_compatibility')).toEqual([]);
  });

  it('HC-SR04 echo on a Pico: BLOCKER with a divider fix', () => {
    const p = build('PICO', [{ id: 'us', key: 'HCSR04', links: [{ interface: 'GPIO', pinName: 'Trig' }, { interface: 'GPIO', pinName: 'Echo' }] }]);
    const fail = results(p, 'BLOCKER', 'logic_voltage_compatibility').find((r) => /Echo/.test(r.message));
    expect(fail).toBeDefined();
    expect(fail!.suggestedFix ?? '').toMatch(/divider/i);
  });

  it('L298N inputs from a 3.3 V controller pass', () => {
    const p = build('F446', [
      { id: 'drv', key: 'L298N', links: ['IN1', 'IN2', 'IN3', 'IN4'].map((n) => ({ interface: 'GPIO' as const, pinName: n })).concat([{ interface: 'PWM', pinName: 'ENA' }, { interface: 'PWM', pinName: 'ENB' }] as never) },
    ]);
    expect(results(p, undefined, 'logic_voltage_compatibility').filter((r) => r.status !== 'PASS')).toEqual([]);
  });

  it('WS2812 data from 3.3 V: BLOCKER with a 74AHCT125 fix', () => {
    const p = build('PICO', [{ id: 'px', key: 'WS2812', links: [{ interface: 'GPIO', pinName: 'DIN' }] }]);
    const f = results(p, 'BLOCKER', 'logic_voltage_compatibility')[0];
    expect(f).toBeDefined();
    expect(f!.suggestedFix ?? '').toMatch(/74AHCT125/);
  });

  it('5 V relay IN from 3.3 V: WARNING with a transistor fix, not a level shifter', () => {
    const p = build('PICO', [{ id: 'r', key: 'RELAY', links: [{ interface: 'GPIO', pinName: 'IN' }] }]);
    const w = results(p, 'WARNING', 'logic_voltage_compatibility')[0];
    expect(w).toBeDefined();
    expect(w!.suggestedFix ?? '').toMatch(/transistor/i);
    expect(w!.suggestedFix ?? '').not.toMatch(/level shifter/i);
  });
});

describe('6. power', () => {
  const powerFails = (p: PrototypeArchitecture) => results(p, 'BLOCKER').filter((r) => r.ruleType === 'required_power_rail' || r.ruleType === 'signal_direction_conflict');

  it('1S LiPo + boost to 5 V: valid, the boost is fed from the battery', () => {
    const p = build('PICO', [{ id: 'boost', key: 'BOOST' }, { id: 'pm', key: 'FIVEV', links: [{ interface: 'UART' }] }], { brief: 'Pico with a 3.7V LiPo battery and a 5V boost converter' });
    expect(powerFails(p)).toEqual([]);
    expect(netsWith(p, 'boost', 'BAT').some((n) => n.members.some((m) => m.instanceId.startsWith('battery')))).toBe(true);
    expect(netsWith(p, 'pm', 'VCC').some((n) => n.members.some((m) => m.instanceId === 'boost'))).toBe(true);
  });

  it('2S LiPo + boost: BLOCKER recommending a step-down regulator', () => {
    const p = build('F446', [{ id: 'boost', key: 'BOOST' }], { brief: 'Nucleo with a 7.4V 2S LiPo battery and 5V regulator' });
    const f = results(p, 'BLOCKER', 'required_power_rail').find((r) => /boost/i.test(r.message));
    expect(f).toBeDefined();
    expect(f!.suggestedFix ?? '').toMatch(/step-down|buck/i);
  });

  it('12 V DC input + 5 V buck feeds Nucleo E5V', () => {
    const p = build('F446', [{ id: 'reg', key: 'BUCK' }], { volts: 12, brief: '12V DC input' });
    expect(powerFails(p)).toEqual([]);
    expect(netsWith(p, 'mcu', 'E5V').some((n) => n.members.some((m) => m.instanceId === 'reg'))).toBe(true);
    expect(netsWith(p, 'reg', 'VIN').some((n) => n.members.some((m) => m.instanceId === 'dcin'))).toBe(true);
  });

  it('battery straight to Pico VSYS when there is no regulator', () => {
    const p = build('PICO', [{ id: 's', key: 'SHT31', links: [{ interface: 'I2C' }] }], { brief: 'Pico W powered by a 3.7V LiPo' });
    expect(netsWith(p, 'mcu', 'VSYS').some((n) => n.members.some((m) => m.instanceId.startsWith('battery')))).toBe(true);
    expect(powerFails(p)).toEqual([]);
  });

  it('charger + battery: not a two-outputs conflict', () => {
    const p = build('PICO', [{ id: 'chg', key: 'CHARGER' }], { brief: '3.7V LiPo battery with a USB charger' });
    expect(results(p, 'BLOCKER', 'signal_direction_conflict')).toEqual([]);
    expect(netsWith(p, 'chg', 'BAT').some((n) => n.members.some((m) => m.instanceId.startsWith('battery')))).toBe(true);
  });

  it('USB-powered Pico passes VBUS 5 V to a 5 V module', () => {
    const p = build('PICO', [{ id: 'pm', key: 'FIVEV', links: [{ interface: 'UART' }] }]);
    expect(powerFails(p)).toEqual([]);
    expect(netsWith(p, 'pm', 'VCC').some((n) => n.members.some((m) => m.instanceId === 'mcu' && m.pinName === 'VBUS'))).toBe(true);
  });

  it('on a battery bench VBUS is not a 5 V source', () => {
    const p = build('PICO', [{ id: 'pm', key: 'FIVEV', links: [{ interface: 'UART' }] }], { brief: 'Pico powered by a 3.7V LiPo battery' });
    expect(netsWith(p, 'pm', 'VCC').some((n) => n.members.some((m) => m.instanceId === 'mcu' && m.pinName === 'VBUS'))).toBe(false);
    expect(results(p, 'BLOCKER', 'required_power_rail').some((r) => r.instanceIds.includes('pm'))).toBe(true);
  });

  it('a servo gets 5 V, not 3.3 V', () => {
    const p = build('F446', [], { brief: 'Nucleo driving an SG90 servo' });
    const servo = p.instances.find((i) => i.instanceId.startsWith('servo'));
    expect(servo).toBeDefined();
    const rail = netsWith(p, servo!.instanceId, 'V+')[0];
    expect(rail?.name).toBe('5V');
    expect(netsWith(p, servo!.instanceId, 'SIG').some((n) => n.members.some((m) => m.instanceId === 'mcu'))).toBe(true);
  });
});

describe('7. outside parts parser', () => {
  const parse = (text: string) => outsidePartsOf(text).map((p) => `${p.kind}:${p.label}`);
  const cases: Array<[string, string[]]> = [
    ['Rover with two N20 gear motors', ['MOTOR:DC motor 1', 'MOTOR:DC motor 2']],
    ['a stepper motor driven by an A4988', ['STEPPER:Stepper motor']],
    ['uses an L298N DC motor driver', []],
    ['pan-tilt with 4x SG90 servos', ['SERVO:Servo 1', 'SERVO:Servo 2', 'SERVO:Servo 3', 'SERVO:Servo 4']],
    ['PCA9685 servo driver board', []],
    ['opens a 12V solenoid valve', ['LOAD:12 V solenoid valve']],
    // A fan speed controller implies the fan it controls.
    ['fan speed controller using PWM', ['LOAD:fan']],
    ['with a battery level monitor', []],
    ['CR2032 coin cell for the RTC battery backup', []],
    ['powered by an 18650 cell', ['BATTERY:3.7 V Li-ion battery']],
    ['runs from a 3S LiPo', ['BATTERY:11.1 V 3S LiPo battery']],
    ['powered by 4 AA batteries', ['BATTERY:6 V battery (4 × AA)']],
    ['LiFePO4 12V battery pack', ['BATTERY:12 V LiFePO4 battery']],
    ['measures battery voltage with an ADC', []],
  ];
  for (const [text, expected] of cases) {
    it(`"${text}"`, () => {
      expect(parse(text)).toEqual(expected);
    });
  }
});

describe('8. loads', () => {
  it('pump with no relay and no driver: WARNING', () => {
    const p = build('PICO', [], { brief: 'Pico waters a plant with a 5V water pump' });
    expect(results(p, 'WARNING').some((r) => /switches the .*pump/i.test(r.message))).toBe(true);
  });

  it('two loads, one relay: the second load gets a WARNING', () => {
    const p = build('PICO', [{ id: 'r1', key: 'RELAY', links: [{ interface: 'GPIO', pinName: 'IN' }] }], { brief: '12V water pump and a 12V fan, 12V DC input', volts: 12 });
    const loads = p.instances.filter((i) => i.placeholder?.kind === 'LOAD');
    expect(loads.length).toBe(2);
    const switched = loads.filter((l) => netsWith(p, l.instanceId).some((n) => n.class === 'load'));
    expect(switched.length).toBe(1);
    expect(results(p, 'WARNING').some((r) => r.instanceIds.includes(loads.find((l) => !switched.includes(l))!.instanceId))).toBe(true);
  });

  it('three DC motors on one L298N: the third gets a WARNING', () => {
    const p = build('F446', [{ id: 'drv', key: 'L298N', links: [{ interface: 'GPIO', pinName: 'IN1' }] }], { brief: 'three DC motors' });
    const motors = p.instances.filter((i) => i.placeholder?.kind === 'MOTOR');
    expect(motors.length).toBe(3);
    expect(results(p, 'WARNING').filter((r) => /motor-driver output/.test(r.message)).length).toBe(1);
  });

  it('a stepper on an L298N uses both channels', () => {
    const p = build('F446', [{ id: 'drv', key: 'L298N', links: [{ interface: 'GPIO', pinName: 'IN1' }] }], { brief: 'NEMA17 stepper motor' });
    const stepper = p.instances.find((i) => i.placeholder?.kind === 'STEPPER')!;
    const driverPins = new Set(netsWith(p, stepper.instanceId).flatMap((n) => n.members.filter((m) => m.instanceId === 'drv').map((m) => m.pinName)));
    expect(driverPins).toEqual(new Set(['OUT1', 'OUT2', 'OUT3', 'OUT4']));
  });
});

describe('9. placeholders', () => {
  it('two SPI placeholders: each gets its own chip select', () => {
    const p = build('F446', [], {
      gaps: [
        { category: 'Sensing', need: 'LIS3MDL magnetometer (SPI)', suggestion: '', interface: 'SPI' },
        { category: 'Sensing', need: 'MAX31856 thermocouple (SPI)', suggestion: '', interface: 'SPI' },
      ],
    });
    const ph = p.instances.filter((i) => i.placeholder && i.placeholder.kind === 'SPI');
    expect(ph.length).toBe(2);
    const cs = ph.map((i) => netsWith(p, i.instanceId, 'CS')[0]?.members.find((m) => m.instanceId === 'mcu')?.pinName);
    expect(cs.every(Boolean)).toBe(true);
    expect(new Set(cs).size).toBe(2);
  });

  it('CAN placeholder device powered from the 12 V input', () => {
    const p = build('H743', [{ id: 'reg', key: 'BUCK' }], {
      volts: 12,
      gaps: [
        { category: 'Sensing', need: 'Industrial CANopen pressure sensor', suggestion: '', interface: 'CAN' },
        { category: 'Connectivity', need: 'CAN bus transceiver module', suggestion: '', interface: 'CAN' },
      ],
    });
    const dev = p.instances.find((i) => i.placeholder?.kind === 'CAN')!;
    expect(netsWith(p, dev.instanceId, 'V+').some((n) => n.members.some((m) => m.instanceId === 'dcin'))).toBe(true);
  });

  it('CAN placeholder with no 9-36 V supply: ground only, and the summary says so', () => {
    const p = build('H743', [], { gaps: [{ category: 'Sensing', need: 'Industrial CANopen pressure sensor', suggestion: '', interface: 'CAN' }] });
    const dev = p.instances.find((i) => i.placeholder?.kind === 'CAN')!;
    expect(netsWith(p, dev.instanceId, 'V+')).toEqual([]);
    const summary = results(p, 'WARNING', 'placeholder_module')[0]!;
    expect(summary.message).toMatch(/not wired/);
  });
});

describe('10. sourcer helpers', () => {
  const needs = [
    { id: 'N0', text: 'a controller board' },
    { id: 'N3', text: 'Sensing: SCD41 CO2 sensor' },
  ];
  it('answersNeed: numbered, unnumbered, controller', () => {
    expect(answersNeed({ need: 'N3: SCD41 CO2 sensor', product_name: 'SCD-41', role: 'module' }, needs)).toBe(true);
    expect(answersNeed({ need: 'N5: BME688', product_name: 'BME688', role: 'module' }, needs)).toBe(false);
    expect(answersNeed({ need: 'CO2 measurement', product_name: 'Adafruit SCD-41', role: 'module' }, needs)).toBe(true);
    expect(answersNeed({ need: 'BME688 gas sensor', product_name: 'Adafruit BME688', role: 'module' }, needs)).toBe(false);
    expect(answersNeed({ need: 'main board', product_name: 'NUCLEO-H743ZI2', role: 'controller' }, needs)).toBe(true);
    expect(answersNeed({ need: 'main board', product_name: 'NUCLEO-H743ZI2', role: 'controller' }, [needs[1]!])).toBe(false);
  });

  it('withReferenceAddresses fixes a wrong address and keeps a right vendor default', () => {
    const base = factsSchema.parse(normaliseFacts({ secondary_ics: [], required_accessories: [], notes: [], facts_source: 'model_knowledge', ...i2cModule('Adafruit BMP390', 'BMP390', ['0x44']) }));
    expect(withReferenceAddresses(base).interfaces[0]!.addresses).toEqual(['0x77', '0x76']);
    const sht = factsSchema.parse(normaliseFacts({ secondary_ics: [], required_accessories: [], notes: [], facts_source: 'model_knowledge', ...i2cModule('Adafruit SHT31-D', 'SHT31-D', ['0x45']) }));
    expect(withReferenceAddresses(sht).interfaces[0]!.addresses[0]).toBe('0x45');
    const pim = factsSchema.parse(normaliseFacts({ secondary_ics: [], required_accessories: [], notes: [], facts_source: 'model_knowledge', ...i2cModule('Pimoroni BME688 Breakout', 'BME688', ['0x77'], [], 'Pimoroni') }));
    expect(withReferenceAddresses(pim).interfaces[0]!.addresses[0]).toBe('0x76');
  });

  it('referenceBoardFor matches only the exact boards', () => {
    expect(referenceBoardFor({ product_name: 'Adafruit Feather RP2040' })).toBeNull();
    expect(referenceBoardFor({ product_name: 'WeAct STM32H743 core board' })).toBeNull();
    expect(referenceBoardFor({ product_name: 'Arduino Uno R4 WiFi' })).toBeNull();
    expect(referenceBoardFor({ product_name: 'Arduino Nano RP2040 Connect' })).toBeNull();
    expect(referenceBoardFor({ product_name: 'ESP32-S3-DevKitM-1' })).toBeNull();
    expect(referenceBoardFor({ product_name: 'Raspberry Pi Pico 2 W' })?.facts.product_name).toBe('Raspberry Pi Pico 2');
    expect(referenceBoardFor({ product_name: 'Raspberry Pi Pico WH' })?.facts.product_name).toBe('Raspberry Pi Pico W');
    expect(referenceBoardFor({ product_name: 'STM32H7 Nucleo-144 Development Board' })?.facts.product_name).toBe('NUCLEO-H743ZI2');
    expect(referenceBoardFor({ product_name: 'NUCLEO-H723ZG' })).toBeNull();
    expect(referenceBoardFor({ product_name: 'Arduino UNO R3' })?.facts.product_name).toBe('Arduino UNO R3');
  });
});

describe('11. determinism', () => {
  it('the same composition assembles to identical nets, connections and stateHash', () => {
    const mods: Mod[] = [
      { id: 'bmp', key: 'BMP390', links: [{ interface: 'I2C' }] },
      { id: 'bme', key: 'BME688SDO', links: [{ interface: 'I2C' }] },
      { id: 'g', key: 'UARTA', links: [{ interface: 'UART' }] },
      { id: 'drv', key: 'L298N', links: [{ interface: 'GPIO', pinName: 'IN1' }] },
    ];
    const a = build('F446', mods, { brief: '7.4V 2S LiPo, two DC motors' });
    const b = build('F446', mods, { brief: '7.4V 2S LiPo, two DC motors' });
    expect(b.stateHash).toBe(a.stateHash);
    expect(JSON.stringify(b.nets)).toBe(JSON.stringify(a.nets));
    expect(JSON.stringify(b.connections)).toBe(JSON.stringify(a.connections));
    expect(JSON.stringify(b.compatibility)).toBe(JSON.stringify(a.compatibility));
  });
});

describe('12. robustness', () => {
  it('controller only', () => {
    expect(() => build('ESP32S3', [])).not.toThrow();
  });
  it('a module with no ground pin', () => {
    expect(() => build('PICO', [{ id: 'x', key: 'NOGND', links: [{ interface: 'GPIO', pinName: 'OUT' }] }])).not.toThrow();
    const p = build('PICO', [{ id: 'x', key: 'NOGND', links: [{ interface: 'GPIO', pinName: 'OUT' }] }]);
    expect(results(p, 'BLOCKER').some((r) => /ground/i.test(r.message))).toBe(true);
  });
  it('duplicate instance ids in the composition', () => {
    expect(() =>
      build('PICO', [
        { id: 'dup', key: 'SHT31', links: [{ interface: 'I2C' }] },
        { id: 'dup', key: 'UARTA', links: [{ interface: 'UART' }] },
      ])
    ).not.toThrow();
  });
  it('a link to a pin name the module does not have', () => {
    expect(() => build('PICO', [{ id: 'r', key: 'RELAY', links: [{ interface: 'GPIO', pinName: 'NOPE' }] }])).not.toThrow();
  });
  it('brief with every outside part at once and no drivers', () => {
    expect(() => build('UNO', [], { brief: '2S LiPo, 4 DC motors, a stepper, 2 servos, a 12V pump, a fan, a heater, an LED strip' })).not.toThrow();
  });
});
