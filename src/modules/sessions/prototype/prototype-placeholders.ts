import crypto from 'node:crypto';
import { LibraryEntity } from '../../hardware/hardware-library.service.js';
import { hardwareRecordSchema } from '../../hardware/hardware.schema.js';
import { parseModuleSvg } from '../../hardware/hardware-svg.js';
import { BoardDef, buildRecord, buildSvg, PinDef } from '../../hardware/discovery/record-builder.js';
import { LinkInterface } from './prototype.types.js';

/**
 * Placeholders: labelled stand-ins for modules the library does not have.
 *
 * A brief that names 20 modules must show 20 blocks, wired on the right buses, even when only some
 * of them exist as real boards. A placeholder is a generic block with the pins its interface needs
 * (an I2C device has SDA/SCL, a CAN device CANH/CANL, an RS-485 transceiver DI/RO/DE/RE/A/B), so
 * the allocator wires it like any board and the protocol design is complete. It is never presented
 * as a real part: no vendor, no specs, no supply voltage (its power stays unwired), and it is
 * drawn dashed with "Choose a part".
 *
 * Placeholders are never stored in the library. The id encodes the kind and the instance
 * (`PLACEHOLDER-UART-gps1`); the record is rebuilt from the id + its label wherever it is needed.
 */

export const PLACEHOLDER_PREFIX = 'PLACEHOLDER-';
/** LibraryEntity.recordOrigin of a placeholder (never a stored record origin). */
export const PLACEHOLDER_ORIGIN = 'placeholder';

export const PLACEHOLDER_KINDS = [
  'I2C', 'SPI', 'UART', 'GPIO', 'ANALOG', 'PWM', 'CAN', 'CANXCVR', 'RS485', 'RS485XCVR', 'DCIN', 'NONE',
  'BATTERY', 'MOTOR', 'STEPPER', 'LOAD', 'SERVO',
] as const;
export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

/**
 * Off-board parts the brief names (the supply, a battery, motors, a pump, servos). They are drawn
 * and wired like boards but are not modules to buy from the library: real parts the engineer
 * brings, shown as "Outside part" rather than "Choose a part".
 */
export const OUTSIDE_KINDS: ReadonlySet<PlaceholderKind> = new Set(['DCIN', 'BATTERY', 'MOTOR', 'STEPPER', 'LOAD', 'SERVO']);
export const isOutsideKind = (kind: PlaceholderKind | null | undefined): boolean => kind != null && OUTSIDE_KINDS.has(kind);

interface KindDef {
  /** How the placeholder links to the controller (or its field bus); null = not linked. */
  link: LinkInterface | null;
  /** Module pin named by a GPIO/ANALOG/PWM link. */
  linkPin?: string;
  pins: PinDef[];
  interfaces: BoardDef['interfaces'];
  label: string;
}

const power = (name: string): PinDef => ({ name, cls: 'power', dir: 'power_in', domain: null });
const GND: PinDef = { name: 'GND', cls: 'ground', dir: 'ground', domain: null };
const sig = (name: string, dir: PinDef['dir'], cls: PinDef['cls'] = 'data'): PinDef => ({ name, cls, dir, domain: null });

const KINDS: Record<PlaceholderKind, KindDef> = {
  I2C: { link: 'I2C', label: 'I²C', pins: [power('VIN'), GND, sig('SDA', 'bidirectional'), sig('SCL', 'input')], interfaces: [{ type: 'I2C', details: { role: 'target', sda_pin_id: 'SDA', scl_pin_id: 'SCL' } }] },
  SPI: {
    link: 'SPI',
    label: 'SPI',
    pins: [power('VIN'), GND, sig('SCK', 'input'), sig('MOSI', 'input'), sig('MISO', 'output'), sig('CS', 'input')],
    interfaces: [{ type: 'SPI', details: { role: 'target', sck_pin_id: 'SCK', mosi_pin_id: 'MOSI', miso_pin_id: 'MISO', cs_pin_id: 'CS' } }],
  },
  UART: { link: 'UART', label: 'UART', pins: [power('VIN'), GND, sig('TX', 'output'), sig('RX', 'input')], interfaces: [{ type: 'UART', details: { tx_pin_id: 'TX', rx_pin_id: 'RX' } }] },
  GPIO: { link: 'GPIO', linkPin: 'SIG', label: 'GPIO', pins: [power('VIN'), GND, sig('SIG', 'bidirectional')], interfaces: [] },
  ANALOG: { link: 'ANALOG', linkPin: 'AOUT', label: 'Analog', pins: [power('VIN'), GND, sig('AOUT', 'output', 'analog')], interfaces: [] },
  PWM: { link: 'PWM', linkPin: 'PWM', label: 'PWM', pins: [power('VIN'), GND, sig('PWM', 'input')], interfaces: [] },
  CAN: { link: 'CAN', label: 'CAN', pins: [power('V+'), GND, sig('CANH', 'bidirectional', 'other'), sig('CANL', 'bidirectional', 'other')], interfaces: [{ type: 'CAN', details: { role: 'device' } }] },
  CANXCVR: {
    link: 'CAN',
    label: 'CAN',
    pins: [power('VCC'), GND, sig('TXD', 'input'), sig('RXD', 'output'), sig('CANH', 'bidirectional', 'other'), sig('CANL', 'bidirectional', 'other')],
    interfaces: [{ type: 'CAN', details: { role: 'transceiver', tx_pin_id: 'TXD', rx_pin_id: 'RXD' } }],
  },
  RS485: { link: 'RS485', label: 'RS485', pins: [power('V+'), GND, sig('A', 'bidirectional', 'other'), sig('B', 'bidirectional', 'other')], interfaces: [{ type: 'RS485', details: { role: 'device' } }] },
  RS485XCVR: {
    link: 'RS485',
    label: 'RS485',
    pins: [power('VCC'), GND, sig('DI', 'input'), sig('RO', 'output'), sig('DE', 'input'), sig('RE', 'input'), sig('A', 'bidirectional', 'other'), sig('B', 'bidirectional', 'other')],
    interfaces: [{ type: 'RS485', details: { role: 'transceiver', tx_pin_id: 'DI', rx_pin_id: 'RO' } }],
  },
  // An outside supply feeding the bench's first regulator (e.g. a 12 V adapter); volts from its name.
  DCIN: { link: null, label: 'outside supply', pins: [{ name: '+V', cls: 'power', dir: 'power_out', domain: null }, GND], interfaces: [] },
  NONE: { link: null, label: '', pins: [power('VIN'), GND], interfaces: [] },
  // A battery pack: a supply whose range (empty to full) comes from its name ("7.4 V 2S LiPo").
  BATTERY: { link: null, label: 'Battery', pins: [{ name: 'BAT+', cls: 'power', dir: 'power_out', domain: null }, { ...GND, name: 'BAT-' }], interfaces: [] },
  // Loads: their terminals land on a driver's outputs or a relay's contacts, never on the controller.
  MOTOR: { link: null, label: 'DC motor', pins: [sig('M+', 'bidirectional', 'other'), sig('M-', 'bidirectional', 'other')], interfaces: [] },
  STEPPER: {
    link: null,
    label: 'Stepper motor',
    pins: [sig('A+', 'bidirectional', 'other'), sig('A-', 'bidirectional', 'other'), sig('B+', 'bidirectional', 'other'), sig('B-', 'bidirectional', 'other')],
    interfaces: [],
  },
  LOAD: { link: null, label: 'Load', pins: [sig('LOAD+', 'input', 'other'), { ...GND, name: 'LOAD-' }], interfaces: [] },
  SERVO: { link: 'PWM', linkPin: 'SIG', label: 'Servo', pins: [power('V+'), GND, sig('SIG', 'input')], interfaces: [] },
};

/** Battery chemistry ranges per cell, empty to full. */
const CELL_RANGE: Array<[RegExp, number, [number, number]]> = [
  [/lifepo4|lfp/i, 3.2, [2.5, 3.65]],
  [/li-?po|li-?ion|lithium|18650/i, 3.7, [3.0, 4.2]],
  [/nimh|nicd/i, 1.2, [1.0, 1.45]],
  [/alkaline|\baa\b|\baaa\b/i, 1.5, [0.9, 1.6]],
];

/** A battery's voltage range from its label ("7.4 V 2S LiPo battery" → 6.0-8.4 V); null when unknown. */
export function batteryRangeOf(label: string): [number, number] | null {
  const volts = voltsIn(label);
  const cells = Number(/\b(\d)\s*S(?:\d+P)?\b/i.exec(label)?.[1] ?? NaN);
  const chem = CELL_RANGE.find(([re]) => re.test(label));
  if (chem) {
    const n = Number.isFinite(cells) ? cells : volts !== null ? Math.max(1, Math.round(volts / chem[1])) : 1;
    return [Number((chem[2][0] * n).toFixed(2)), Number((chem[2][1] * n).toFixed(2))];
  }
  return volts !== null ? [Number((volts * 0.85).toFixed(2)), Number((volts * 1.15).toFixed(2))] : null;
}

const TRANSCEIVER = /transceiver|xcvr|\bphy\b|line driver|interface (?:board|module)|to ttl|ttl to/i;
const CAN_TEXT = /\bcan ?open\b|\bcan[ -]?(?:bus|fd|2\.0|node|interface|controller|transceiver|sensor|device)\b|\bcan\b(?= *\(|$)/i;
const RS485_TEXT = /rs-?485|modbus/i;

/** The placeholder kind for a gap: the resolver's interface first, then the gap's own words. */
export function placeholderKindFor(gap: { category: string; need: string; suggestion: string; interface?: string | null }): PlaceholderKind {
  const text = `${gap.need} ${gap.suggestion}`;
  const iface = (gap.interface ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  // What the need itself is: a CANopen sensor whose suggestion mentions its transceiver is still a
  // device on the bus, not a transceiver (dev, 2026-10-16).
  const transceiver = TRANSCEIVER.test(gap.need) && !/sensor|meter|detector|probe|actuator|valve|drive\b/i.test(gap.need);
  if (iface === 'CAN' || (!iface && CAN_TEXT.test(text))) return transceiver ? 'CANXCVR' : 'CAN';
  if (iface === 'RS485' || iface === 'MODBUS' || (!iface && RS485_TEXT.test(text))) return transceiver ? 'RS485XCVR' : 'RS485';
  if (iface === 'I2C' || iface === 'SPI' || iface === 'UART' || iface === 'GPIO' || iface === 'ANALOG' || iface === 'PWM') return iface;
  if (iface === 'POWER' || iface === 'NONE') return 'NONE';
  if (/\bspi\b/i.test(text)) return 'SPI';
  if (/i2c|i²c|stemma|qwiic/i.test(text)) return 'I2C';
  if (/uart|serial|\bgps\b|gnss|bluetooth|\bble\b|\bpms\d|nmea/i.test(text)) return 'UART';
  if (/analog|\badc\b|thermistor|potentiometer/i.test(text)) return 'ANALOG';
  return 'NONE';
}

export const isPlaceholderId = (id: string | null | undefined): boolean => typeof id === 'string' && id.startsWith(PLACEHOLDER_PREFIX);
export const isPlaceholderEntity = (entity: LibraryEntity): boolean => entity.recordOrigin === PLACEHOLDER_ORIGIN;

export function placeholderId(kind: PlaceholderKind, instanceId: string): string {
  return `${PLACEHOLDER_PREFIX}${kind}-${instanceId}`;
}

export function placeholderKindOf(id: string): PlaceholderKind | null {
  if (!isPlaceholderId(id)) return null;
  const kind = id.slice(PLACEHOLDER_PREFIX.length).split('-')[0] as PlaceholderKind;
  return (PLACEHOLDER_KINDS as readonly string[]).includes(kind) ? kind : null;
}

/** The link a placeholder gets: its kind's interface, naming the signal pin where one is needed. */
export function placeholderLinks(kind: PlaceholderKind): Array<{ interface: LinkInterface; pinName: string | null; purpose: string }> {
  const def = KINDS[kind];
  return def.link ? [{ interface: def.link, pinName: def.linkPin ?? null, purpose: 'placeholder link' }] : [];
}

/** Volts in a DC input's name ("12 V DC input" → 12). */
const voltsIn = (name: string): number | null => {
  const m = /(\d+(?:\.\d+)?)\s*v\b/i.exec(name);
  return m ? Number(m[1]) : null;
};

const cleanName = (name: string): string =>
  [...name]
    .map((c) => (c.charCodeAt(0) < 32 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Missing module';

/**
 * The runtime entity of a placeholder, rebuilt from its id and label. Null when the id is not a
 * placeholder id. Deterministic: the same id and name always give the same record and artwork.
 */
export function placeholderEntity(hardwareEntityId: string, name: string): LibraryEntity | null {
  const kind = placeholderKindOf(hardwareEntityId);
  if (!kind) return null;
  const def = KINDS[kind];
  const label = cleanName(name);
  const outside = isOutsideKind(kind);
  const battery = kind === 'BATTERY' ? batteryRangeOf(label) : null;
  const volts = kind === 'DCIN' || kind === 'LOAD' ? voltsIn(label) : kind === 'BATTERY' ? (voltsIn(label) ?? (battery ? Number(((battery[0] + battery[1]) / 2).toFixed(1)) : null)) : null;
  const pins = def.pins.map((p) => ((kind === 'DCIN' || kind === 'BATTERY') && p.dir === 'power_out' ? { ...p, domain: volts !== null ? `${volts}V` : null } : p));
  // Hobby servos run from 4.8-6 V; a battery reports its empty-to-full range.
  const supply: [number | null, number | null] = kind === 'SERVO' ? [4.8, 6] : battery ? battery : [null, null];
  const board: BoardDef = {
    id: hardwareEntityId,
    family: 'FAM-PLACEHOLDER',
    name: label,
    vendor: outside ? 'Outside part' : 'Placeholder',
    sku: null,
    group: outside ? 'Outside part' : 'Placeholder',
    categories: [kind === 'DCIN' || kind === 'BATTERY' ? 'Power' : kind === 'MOTOR' || kind === 'STEPPER' || kind === 'LOAD' || kind === 'SERVO' ? 'Motor/Actuation' : 'Interface'],
    role: outside ? 'Outside part' : 'Placeholder',
    silicon: outside ? def.label || 'Outside part' : def.label ? `Placeholder · ${def.label}` : 'Placeholder',
    secondary: [],
    hostRequirement: kind === 'SERVO' ? 'host_required' : outside || kind === 'NONE' ? 'optional_host' : 'host_required',
    requiredHostInterfaces: def.link && kind !== 'CAN' && kind !== 'RS485' ? [def.link] : [],
    supply,
    logic: 'not specified',
    powerSources: kind === 'DCIN' || kind === 'BATTERY' ? ['external'] : [],
    rails: kind === 'SERVO' ? [{ rail_name: 'V+', voltage_min_v: 4.8, voltage_max_v: 6 }] : [],
    pins,
    connectors: [{ ref: 'J1', type: `pin_header_1x${pins.length}_2.54mm`, mode: 'individual_contacts', edge: 'bottom', contacts: pins.map((p, i) => [String(i + 1), p.name]) }],
    interfaces: def.interfaces,
    ecosystem: [],
    sources: [],
    notes: [
      outside
        ? 'Outside part named in the brief: supplied by you, not a library module. Its terminals are generic.'
        : 'Placeholder: not a real part. Choose a module for this need; its pins and supply here are generic.',
    ],
  };
  const record = hardwareRecordSchema.parse(
    buildRecord(board, {
      review_status: 'provisional',
      scope: 'private_project',
      verification_method: 'generic_reference',
      record_origin: 'generic_reference',
      asset_readiness: 'visual_ready',
      created_by: 'embedo-placeholder',
      admin_notes: 'Placeholder for a module the library does not have. Never stored.',
      license_note: 'Generic placeholder generated by Embedo.',
    })
  );
  const { svg } = buildSvg(board);
  const hash = `sha256:${crypto.createHash('sha256').update(svg).digest('hex')}`;
  return {
    hardwareEntityId,
    productFamilyId: 'FAM-PLACEHOLDER',
    preferredInFamily: false,
    reviewStatus: 'provisional',
    lifecycleStatus: 'active',
    assetReadiness: 'visual_ready',
    scope: 'private_project',
    verificationMethod: 'generic_reference',
    recordOrigin: PLACEHOLDER_ORIGIN,
    projectId: null,
    isController: false,
    record,
    sources: [],
    svg: { hash, markup: svg, parsed: parseModuleSvg(svg, hash) },
  };
}

/** Adds the placeholder entities a payload's instances refer to (they are never in the library). */
export function withPlaceholderEntities(
  entities: Map<string, LibraryEntity>,
  instances: Array<{ hardwareEntityId: string; label: string }>
): Map<string, LibraryEntity> {
  const out = new Map(entities);
  for (const i of instances) {
    if (out.has(i.hardwareEntityId) || !isPlaceholderId(i.hardwareEntityId)) continue;
    const entity = placeholderEntity(i.hardwareEntityId, i.label);
    if (entity) out.set(i.hardwareEntityId, entity);
  }
  return out;
}
