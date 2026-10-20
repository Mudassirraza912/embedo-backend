import { HardwarePin } from '../../hardware/hardware.schema.js';
import { LibraryEntity } from '../../hardware/hardware-library.service.js';
import { addressesFor } from '../../hardware/reference/i2c-addresses.js';
import { isFiveVoltTolerant } from '../../hardware/reference/logic-inputs.js';
import { Board, ContactRef, isReservedForSignal, parseVolts } from './prototype-board.js';
import { isPlaceholderEntity, placeholderKindOf } from './prototype-placeholders.js';
import {
  CompatibilityResult,
  LinkInterface,
  NetClass,
  NetMember,
  PrototypeConnection,
  PrototypeNet,
} from './prototype.types.js';

/**
 * Deterministic pin allocator (plan D5 step 4). The resolver only chose modules and interface-level
 * links; every pin, contact and rail here comes from the library record, so the result can never
 * name a pin the board does not have.
 *
 * Order: fixed-function buses first (I2C, SPI, UART need specific controller pins), then the
 * flexible lines (SPI chip selects, GPIO, ADC, PWM), then power and ground for every module.
 */

export interface AllocInstance {
  instanceId: string;
  entity: LibraryEntity;
  links: Array<{ interface: LinkInterface; pinName?: string | null; purpose?: string | null }>;
}

export type AllocatedConnection = Omit<PrototypeConnection, 'state'>;

export interface AllocationResult {
  nets: PrototypeNet[];
  connections: AllocatedConnection[];
  results: CompatibilityResult[];
  /** Supply voltage chosen for each peripheral (null when none could be chosen). */
  peripheralRails: Map<string, number | null>;
  /** Which interfaces actually got wired, per peripheral. */
  linked: Map<string, Set<LinkInterface>>;
  /** Peripheral pins the design requires (power in, ground, linked interface pins). */
  requiredPins: Map<string, Set<string>>;
  /** The address each I2C device uses on the shared bus. */
  i2cAddresses: Map<string, I2cAssignment>;
  /** The rail each placeholder was given (its kind's usual supply), or null when none fits. */
  placeholderRails: Map<string, string | null>;
}

export interface I2cAssignment {
  /** Null when neither the chip nor the record gives an address. */
  address: string | null;
  chip: string | null;
  /** Every address the chip can take, its default first. */
  options: string[];
  /** Moved off its default to clear a clash. */
  moved: boolean;
  /** The address pin and the level the chosen address needs; wired when the pin is on the header. */
  strap: { pin: string | null; level: 'GND' | 'VCC'; wired: boolean } | null;
  /** Devices that already hold every address this one can take. */
  clashWith: string[];
  /** On a multiplexer channel (its own address space) instead of the main bus. */
  channel?: { mux: string; n: number };
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

class NetBook {
  private readonly nets = new Map<string, PrototypeNet>();

  add(name: string, cls: NetClass, member: NetMember): PrototypeNet {
    const netId = `n_${slug(name)}`;
    let net = this.nets.get(netId);
    if (!net) {
      net = { netId, name, class: cls, members: [] };
      this.nets.set(netId, net);
    }
    const existing = net.members.find((m) => m.instanceId === member.instanceId && m.pinId === member.pinId);
    if (!existing) {
      net.members.push(member);
    } else if (!existing.anchorId && member.anchorId) {
      // A pin first joined through a cable contact, then needed a jumper: record the wireable contact.
      existing.contactId = member.contactId;
      existing.anchorId = member.anchorId;
    }
    return net;
  }

  /** Whether a board pin is already on any net. */
  hasMember(instanceId: string, pinId: string): boolean {
    for (const net of this.nets.values()) if (net.members.some((m) => m.instanceId === instanceId && m.pinId === pinId)) return true;
    return false;
  }

  list(): PrototypeNet[] {
    return [...this.nets.values()];
  }
}

const result = (
  ruleType: string,
  status: CompatibilityResult['status'],
  message: string,
  instanceIds: string[],
  pinIds: string[] = [],
  suggestedFix: string | null = null
): CompatibilityResult => ({ ruleType, status, message, suggestedFix, instanceIds, pinIds });

const memberFor = (board: Board, pin: HardwarePin, ref: ContactRef | null): NetMember => ({
  instanceId: board.instanceId,
  pinId: pin.pin_id,
  pinName: pin.pin_name,
  contactId: ref?.contact.contact_id ?? null,
  anchorId: ref?.anchorId ?? null,
});

const SPI_ROLE_ALIASES: Record<'sck' | 'mosi' | 'miso' | 'cs', string[]> = {
  sck: ['SCK', 'SCLK', 'CLK'],
  mosi: ['TX', 'MOSI', 'COPI', 'SDO', 'DOUT'],
  miso: ['RX', 'MISO', 'CIPO', 'SDI', 'DIN'],
  cs: ['CSN', 'CS', 'SS', 'NSS'],
};

/** Peripheral pin names by role, used only when the record has no interface details. */
const PERIPHERAL_NAMES = {
  sda: ['SDA', 'SDI'],
  scl: ['SCL', 'SCK'],
  sck: ['SCK', 'SCLK', 'CLK'],
  mosi: ['MOSI', 'SDI', 'DIN', 'COPI'],
  miso: ['MISO', 'SDO', 'DOUT', 'CIPO'],
  cs: ['CS', 'CSN', 'SS', 'NCS'],
  tx: ['TX', 'TXD', 'TXO'],
  rx: ['RX', 'RXD', 'RXI'],
};

const POWER_PIN_PREFERENCE = ['VIN', 'VCC', 'VDD', 'V+', '3V3', '3.3V', '5V'];

/** Tolerance when comparing a supply voltage with a pin's accepted range. */
const VOLT_EPSILON = 0.01;

const isGroundPin = (pin: HardwarePin) => pin.direction === 'ground' || pin.signal_class === 'ground';
const isPowerPin = (pin: HardwarePin) =>
  pin.direction === 'power_in' || pin.direction === 'power_out' || pin.signal_class === 'power' || isGroundPin(pin);

/** Net name for a rail voltage: 3.3 → "3V3", 5 → "5V", 1.8 → "1V8". */
export function voltsName(volts: number): string {
  const fixed = Number(volts.toFixed(2));
  return Number.isInteger(fixed) ? `${fixed}V` : `${fixed}`.replace('.', 'V');
}

/**
 * Voltage range a power input accepts, from the record only: the pin's own numeric domain ("5V"),
 * else the required_power_rails entry named after the pin, else the board's supply range.
 */
export function inputRange(board: Board, pin: HardwarePin): [number, number] | null {
  const own = parseVolts(pin.voltage_domain) ?? parseVolts(pin.pin_name);
  if (own !== null) return [own - 0.2, own + 0.2];
  const { electrical } = board.record;
  // A rail is either structured or a bare name string; only a structured one carries a range.
  const rail = electrical.required_power_rails.find(
    (r) => typeof r !== 'string' && r.rail_name.trim().toUpperCase() === pin.pin_name.trim().toUpperCase()
  );
  if (rail && typeof rail !== 'string' && rail.voltage_min_v != null && rail.voltage_max_v != null) return [rail.voltage_min_v, rail.voltage_max_v];
  return electrical.supply_voltage_min_v != null && electrical.supply_voltage_max_v != null
    ? [electrical.supply_voltage_min_v, electrical.supply_voltage_max_v]
    : null;
}

const fitsRange = (volts: number, range: [number, number]) => volts >= range[0] - VOLT_EPSILON && volts <= range[1] + VOLT_EPSILON;
const rangeText = (range: [number, number]) =>
  Math.abs(range[1] - range[0]) < 0.45 ? `${Number(((range[0] + range[1]) / 2).toFixed(2))} V` : `${range[0]}–${range[1]} V`;

export function allocatePins(controller: AllocInstance, peripherals: AllocInstance[]): AllocationResult {
  const mcu = new Board(controller.instanceId, controller.entity);
  const boards = new Map(peripherals.map((p) => [p.instanceId, new Board(p.instanceId, p.entity)]));
  const nets = new NetBook();
  const results: CompatibilityResult[] = [];
  const cables: AllocatedConnection[] = [];
  const usedMcuSignalPins = new Set<string>();
  const usedContacts = new Map<string, Set<string>>();
  const preferredConnectors = new Map<string, Set<string>>();
  const cabled = new Set<string>(); // `${instanceId}|${pinId}` reached through a cable, no jumper needed
  const poweredByCable = new Map<string, number | null>();
  /** The module pin a STEMMA QT cable's power contact lands on, and the board at the other end. */
  const cablePowerPin = new Map<string, { pin: HardwarePin; from: string }>();
  const linked = new Map<string, Set<LinkInterface>>(peripherals.map((p) => [p.instanceId, new Set()]));
  const requiredPins = new Map<string, Set<string>>(peripherals.map((p) => [p.instanceId, new Set()]));

  const usedOn = (instanceId: string) => {
    let set = usedContacts.get(instanceId);
    if (!set) usedContacts.set(instanceId, (set = new Set()));
    return set;
  };
  const preferOn = (instanceId: string) => {
    let set = preferredConnectors.get(instanceId);
    if (!set) preferredConnectors.set(instanceId, (set = new Set()));
    return set;
  };

  /** Claims a wireable contact for a pin and returns the member. Shared pins (power, bus lines) may reuse one. */
  const claim = (board: Board, pin: HardwarePin, exclusive: boolean): NetMember => {
    const used = usedOn(board.instanceId);
    const ref = board.pickContact(pin.pin_id, exclusive ? used : new Set(), preferOn(board.instanceId));
    if (ref) {
      used.add(ref.contact.contact_id);
      preferOn(board.instanceId).add(ref.connector.connector_id);
    }
    return memberFor(board, pin, ref);
  };

  const require = (instanceId: string, ...pins: Array<HardwarePin | null | undefined>) => {
    for (const pin of pins) if (pin) requiredPins.get(instanceId)?.add(pin.pin_id);
  };

  /**
   * Rail net names. Two different sources at one voltage (the controller's 3V3 pin and a 3.3 V
   * regulator) must never share a net: that would short two supplies together. The first source
   * gets "3V3", any other gets "3V3_<INSTANCE>".
   */
  const railOwners = new Map<string, string>();
  const railNetName = (volts: number, sourceKey: string, instanceId: string): string => {
    const base = voltsName(volts);
    const owner = railOwners.get(base);
    if (!owner || owner === sourceKey) {
      railOwners.set(base, sourceKey);
      return base;
    }
    const own = `${base}_${instanceId.toUpperCase()}`;
    railOwners.set(own, sourceKey);
    return own;
  };
  const mcuRailKey = (volts: number) => `${mcu.instanceId}:rail:${volts}`;

  // --- controller pin finders ------------------------------------------------------------------
  const hasFunction = (pin: HardwarePin, family: string, roles?: string[], instance?: number | null) =>
    mcu.functionsOf(pin).some(
      (f) => f.family === family && (roles === undefined || (f.role !== null && roles.includes(f.role))) && (instance === undefined || f.instance === instance)
    );

  const isGpioCapable = (pin: HardwarePin) =>
    pin.signal_class === 'data' || pin.signal_class === 'analog' || pin.functions.some((f) => /^GPIO/i.test(f));

  /**
   * A free pin for a plain signal (chip select, GPIO, DE/RE), keeping bus-capable pins for the buses
   * that need them: a pin the board labels as its UART/I2C/SPI/CAN, or that can carry one, is taken
   * last (seen 2026-10-15: an IMU chip select landed on the controller's only UART TX). Among equals,
   * digital pins before analog-capable ones, then record order.
   */
  const labelledBusPins = new Set(
    mcu.record.interfaces.interfaces.flatMap((i) =>
      Object.entries(i.details as Record<string, unknown>)
        .filter(([k, v]) => /_pin_id$/.test(k) && typeof v === 'string')
        .map(([, v]) => v as string)
    )
  );
  const busCost = (pin: HardwarePin) =>
    (labelledBusPins.has(pin.pin_id) ? 10 : 0) +
    mcu.functionsOf(pin).filter((f) => f.role !== null && ['I2C', 'SPI', 'UART', 'CAN'].includes(f.family)).length +
    (pin.signal_class === 'analog' ? 0.5 : 0);
  const freeGeneralPin = (predicate: (pin: HardwarePin) => boolean, extraCost: (pin: HardwarePin) => number = () => 0): HardwarePin | null => {
    const candidates = mcu.record.pins.filter(
      (pin) => !usedMcuSignalPins.has(pin.pin_id) && !isReservedForSignal(pin) && mcu.isHeaderWireable(pin.pin_id) && predicate(pin)
    );
    return candidates.map((pin, i) => ({ pin, cost: busCost(pin) + extraCost(pin) + i / 10_000 })).sort((a, b) => a.cost - b.cost)[0]?.pin ?? null;
  };

  /**
   * A free pin for one role of a bus, keeping pins other buses need: a pin that is also the only
   * CAN or I2C option is taken last (CAN pins are scarce, then I2C). Without this a UART took an
   * STM32's FDCAN pins and the CAN transceiver had none left.
   */
  const BUS_WEIGHT: Record<string, number> = { CAN: 3, I2C: 2, SPI: 1, UART: 1 };
  const freeBusPin = (family: string, predicate: (pin: HardwarePin) => boolean): HardwarePin | null => {
    const candidates = mcu.record.pins.filter(
      (pin) => !usedMcuSignalPins.has(pin.pin_id) && !isReservedForSignal(pin) && mcu.isHeaderWireable(pin.pin_id) && predicate(pin)
    );
    // Other buses' roles count by scarcity; another instance of the same bus counts once (UART3 on
    // PB10/PB11 leaves PC11 for UART4).
    const cost = (pin: HardwarePin) =>
      mcu
        .functionsOf(pin)
        .filter((f) => f.role !== null && !claimedInstances.has(instanceKey(f.family, f.instance)))
        .reduce((n, f) => n + (f.family !== family ? (BUS_WEIGHT[f.family] ?? 0) : 1), 0);
    return candidates.map((pin, i) => ({ pin, cost: cost(pin) + i / 10_000 })).sort((a, b) => a.cost - b.cost)[0]?.pin ?? null;
  };

  /**
   * Point-to-point peripherals (a UART, a CAN controller) serve one device each. A controller often
   * offers the same instance on several pin pairs (the Pico's UART0 on GP0/1, GP12/13, GP16/17);
   * taking it twice put three devices on one UART (dev, 2026-10-16: "UART0_RX has 3 outputs").
   */
  const claimedInstances = new Set<string>();
  const instanceKey = (family: string, instance: number | null) => `${family}:${instance ?? '-'}`;

  /** Lowest-numbered bus instance whose role pins are all free; instance number keeps a bus on one peripheral block. */
  const pickBus = (family: 'I2C' | 'SPI' | 'UART' | 'CAN', roles: Record<string, string[]>, optionalRoles: string[] = []) => {
    const instances = new Set<number | null>();
    for (const pin of mcu.record.pins) for (const f of mcu.functionsOf(pin)) if (f.family === family) instances.add(f.instance);
    const ordered = [...instances].sort((a, b) => (a ?? -1) - (b ?? -1)).filter((i) => !claimedInstances.has(instanceKey(family, i)));
    for (const instance of ordered) {
      const chosen: Record<string, HardwarePin> = {};
      const taken = new Set<string>();
      let complete = true;
      for (const [role, aliases] of Object.entries(roles)) {
        const pin = freeBusPin(family, (p) => !taken.has(p.pin_id) && hasFunction(p, family, aliases, instance));
        if (pin) {
          chosen[role] = pin;
          taken.add(pin.pin_id);
        } else if (!optionalRoles.includes(role)) {
          complete = false;
          break;
        }
      }
      if (complete) return { instance, pins: chosen };
    }
    return null;
  };

  // --- I2C: one shared bus --------------------------------------------------------------------
  const i2cPeripherals = peripherals.filter((p) => p.links.some((l) => l.interface === 'I2C'));

  // An I2C multiplexer on the bench (TCA9548A) takes the devices whose addresses would clash on the
  // main bus, one channel each (dev 2026-10-20: three SHT40s and a TCA9548A, all wired to the main
  // bus, failed the address check the mux was placed to solve).
  const MUX = /\b[TP]CA954[2-8]A?\b|\bi2c (?:mux|multiplexer)\b/i;
  const muxBoard =
    i2cPeripherals
      .map((p) => boards.get(p.instanceId)!)
      .find((b) => !isPlaceholderEntity(b.entity) && MUX.test(`${b.label} ${b.record.identity.main_silicon ?? ''}`) && b.record.pins.some((pin) => /^SD\d$/i.test(pin.pin_name.trim()))) ?? null;
  const muxChannels = muxBoard
    ? Array.from({ length: 8 }, (_, n) => ({ n, sd: muxBoard.pinsByName(`SD${n}`)[0], sc: muxBoard.pinsByName(`SC${n}`)[0] })).filter(
        (c): c is { n: number; sd: HardwarePin; sc: HardwarePin } => Boolean(c.sd && c.sc && muxBoard.isWireable(c.sd.pin_id) && muxBoard.isWireable(c.sc.pin_id))
      )
    : [];
  const muxed = new Map<string, number>();
  if (muxBoard && muxChannels.length > 0) {
    const taken = new Set(addressesFor(muxBoard.entity.record)?.addresses.slice(0, 1) ?? []);
    const devices = i2cPeripherals
      .filter((p) => p.instanceId !== muxBoard.instanceId && !isPlaceholderEntity(p.entity))
      .map((p) => ({ p, f: addressesFor(p.entity.record) }))
      .sort((a, b) => (a.f?.addresses.length ?? 99) - (b.f?.addresses.length ?? 99));
    for (const { p, f } of devices) {
      if (!f) continue;
      const free = f.addresses.find((a) => !taken.has(a));
      if (free) {
        taken.add(free);
        continue;
      }
      const ch = muxChannels[muxed.size];
      if (!ch) break;
      muxed.set(p.instanceId, ch.n);
    }
  }

  if (i2cPeripherals.length > 0) {
    // The board's labelled I2C (record details, e.g. the Feather's SDA/SCL + STEMMA QT) wins over
    // any function-capable pair.
    let sda: HardwarePin | null = null;
    let scl: HardwarePin | null = null;
    let busName = 'I2C';
    for (const details of mcu.interfaceDetails('I2C')) {
      const d = mcu.pinFromDetail(details, 'sda_pin_id');
      const c = mcu.pinFromDetail(details, 'scl_pin_id');
      if (d && c && !usedMcuSignalPins.has(d.pin_id) && !usedMcuSignalPins.has(c.pin_id)) {
        sda = d;
        scl = c;
        const instance = mcu.functionsOf(d).find((f) => f.family === 'I2C')?.instance;
        busName = instance !== undefined && instance !== null ? `I2C${instance}` : 'I2C';
        break;
      }
    }
    if (!sda || !scl) {
      const bus = pickBus('I2C', { sda: ['SDA'], scl: ['SCL'] });
      if (bus) {
        sda = bus.pins['sda']!;
        scl = bus.pins['scl']!;
        busName = bus.instance !== null ? `I2C${bus.instance}` : 'I2C';
      }
    }
    if (!sda || !scl) {
      // Last resort: the board's silkscreened SDA/SCL pins (records without function tokens).
      const named = (names: string[]) =>
        names.flatMap((n) => mcu.pinsByName(n)).find((p) => !usedMcuSignalPins.has(p.pin_id) && mcu.isWireable(p.pin_id)) ?? null;
      sda = named(['SDA', 'SDA0', 'SDA1']);
      scl = named(['SCL', 'SCL0', 'SCL1']);
    }

    if (!sda || !scl) {
      results.push(
        result('required_host_interface', 'BLOCKER', `${mcu.label} has no free I2C bus for ${i2cPeripherals.length} I2C module(s).`, [
          mcu.instanceId,
          ...i2cPeripherals.map((p) => p.instanceId),
        ], [], 'Choose a controller with an I2C bus, or link these modules over SPI.')
      );
    } else {
      usedMcuSignalPins.add(sda.pin_id);
      usedMcuSignalPins.add(scl.pin_id);
      const sdaNet = `${busName}_SDA`;
      const sclNet = `${busName}_SCL`;
      // Cable ports that carry this bus on the controller, then on each module as the chain grows.
      const freePorts = new Map<string, Array<{ connectorId: string; anchorId: string }>>();
      const carriesBus = (connectorPins: string[], busPins: string[]) => busPins.every((id) => connectorPins.includes(id));
      freePorts.set(
        mcu.instanceId,
        mcu
          .cablePorts()
          .filter((p) => carriesBus(p.connector.contacts.map((c) => c.pin_id), [sda!.pin_id, scl!.pin_id]))
          .map((p) => ({ connectorId: p.connector.connector_id, anchorId: p.anchorId }))
      );
      const chain: string[] = [mcu.instanceId];

      // Socket-only boards with the most STEMMA QT ports first: when the controller has no QT port,
      // the first one joins through a socket-to-header cable and the others daisy-chain from its
      // spare port (one adapter cable, not one per board).
      const socketOnly = (p: AllocInstance) => {
        const board = boards.get(p.instanceId)!;
        const d = board.interfaceDetails('I2C')[0] ?? {};
        const sdaPin = board.pinFromDetail(d, 'sda_pin_id') ?? PERIPHERAL_NAMES.sda.flatMap((n) => board.pinsByName(n))[0];
        return sdaPin && !board.isHeaderWireable(sdaPin.pin_id) ? board.cablePorts().length : 0;
      };
      const ordered = [...i2cPeripherals].sort((a, b) => socketOnly(b) - socketOnly(a));

      for (const p of ordered) {
        if (muxed.has(p.instanceId)) continue; // wired to its mux channel below
        const board = boards.get(p.instanceId)!;
        const details = board.interfaceDetails('I2C')[0] ?? {};
        const pSda = board.pinFromDetail(details, 'sda_pin_id') ?? PERIPHERAL_NAMES.sda.flatMap((n) => board.pinsByName(n))[0] ?? null;
        const pScl = board.pinFromDetail(details, 'scl_pin_id') ?? PERIPHERAL_NAMES.scl.flatMap((n) => board.pinsByName(n))[0] ?? null;
        if (!pSda || !pScl) {
          results.push(result('protocol_compatibility', 'BLOCKER', `${board.label} lists I2C but its SDA/SCL pins are not identified in the record.`, [p.instanceId]));
          continue;
        }
        require(p.instanceId, pSda, pScl);

        // Cable first: STEMMA QT / Qwiic on both ends, daisy-chained from the last board with a free port.
        const ports = board
          .cablePorts()
          .filter((port) => carriesBus(port.connector.contacts.map((c) => c.pin_id), [pSda.pin_id, pScl.pin_id]));
        const hostId = [...chain].reverse().find((id) => (freePorts.get(id)?.length ?? 0) > 0);
        if (ports.length > 0 && hostId) {
          const hostPort = freePorts.get(hostId)!.shift()!;
          const inPort = ports[0]!;
          const hostBoard = hostId === mcu.instanceId ? mcu : boards.get(hostId)!;
          const hostConnector = hostBoard.record.connectors.find((c) => c.connector_id === hostPort.connectorId)!;
          const hostPowerPin = hostConnector.contacts
            .map((c) => hostBoard.pinsById.get(c.pin_id))
            .find((pin) => pin && (pin.direction === 'power_out' || pin.direction === 'power_in'));
          const railVolts = hostId === mcu.instanceId ? (parseVolts(hostPowerPin?.voltage_domain) ?? parseVolts(hostPowerPin?.pin_name) ?? 3.3) : (poweredByCable.get(hostId) ?? 3.3);
          // The cable carries the controller's own rail (directly, or down the daisy chain).
          const railName = railNetName(railVolts >= 4.5 ? 5 : 3.3, mcuRailKey(railVolts >= 4.5 ? 5 : 3.3), mcu.instanceId);

          // A cable carries the four STEMMA QT nets. Every contact on the two connectors joins its net;
          // a module further down a daisy chain was already joined when its own cable went in.
          const netIds = new Set<string>();
          const joinCable = (end: Board, connectorId: string, busSda: HardwarePin, busScl: HardwarePin) => {
            const connector = end.record.connectors.find((c) => c.connector_id === connectorId)!;
            for (const contact of connector.contacts) {
              const pin = end.pinsById.get(contact.pin_id);
              if (!pin) continue;
              const member = memberFor(end, pin, { contact, connector, anchorId: null });
              let net: PrototypeNet | null = null;
              if (pin.direction === 'ground' || pin.signal_class === 'ground') net = nets.add('GND', 'ground', member);
              else if (pin.direction === 'power_in' || pin.direction === 'power_out') net = nets.add(railName, 'power', member);
              else if (pin.pin_id === busSda.pin_id) net = nets.add(sdaNet, 'i2c', member);
              else if (pin.pin_id === busScl.pin_id) net = nets.add(sclNet, 'i2c', member);
              if (net) {
                netIds.add(net.netId);
                cabled.add(`${end.instanceId}|${pin.pin_id}`);
              }
            }
          };
          if (hostId === mcu.instanceId) joinCable(mcu, hostPort.connectorId, sda, scl);
          joinCable(board, inPort.connector.connector_id, pSda, pScl);

          cables.push({
            id: `c${cables.length + 1}`,
            kind: 'cable',
            cableType: 'stemma_qt_qwiic',
            netIds: [...netIds],
            from: { instanceId: hostId, anchorId: hostPort.anchorId, contactId: null, connectorId: hostPort.connectorId },
            to: { instanceId: p.instanceId, anchorId: inPort.anchorId, contactId: null, connectorId: inPort.connector.connector_id },
          });
          poweredByCable.set(p.instanceId, railVolts);
          freePorts.set(
            p.instanceId,
            ports.slice(1).map((port) => ({ connectorId: port.connector.connector_id, anchorId: port.anchorId }))
          );
          chain.push(p.instanceId);
          linked.get(p.instanceId)!.add('I2C');
          const power = inPort.connector.contacts.map((c) => board.pinsById.get(c.pin_id)).filter((pin) => pin && (pin.direction === 'power_in' || pin.direction === 'ground'));
          const cablePower = inPort.connector.contacts
            .map((c) => board.pinsById.get(c.pin_id))
            .find((pin) => pin && (pin.direction === 'power_in' || pin.direction === 'power_out'));
          if (cablePower) cablePowerPin.set(p.instanceId, { pin: cablePower, from: hostBoard.label });
          require(p.instanceId, ...power);
          results.push(
            result(
              'connector_family_compatibility',
              'PASS',
              `${hostBoard.label} ${hostPort.connectorId.split(':').pop()} → ${board.label} ${inPort.connector.connector_id.split(':').pop()}: STEMMA QT / Qwiic cable (same 4-pin JST SH pinout).`,
              [hostId, p.instanceId]
            )
          );
          continue;
        }

        // Jumper wires on the header.
        const sdaMember = claim(board, pSda, true);
        const sclMember = claim(board, pScl, true);
        if (!sdaMember.anchorId || !sclMember.anchorId) {
          results.push(
            result(
              'connector_family_compatibility',
              'WARNING',
              `${board.label} exposes SDA/SCL only on its STEMMA QT / Qwiic connector and ${mcu.label} has no free one.`,
              [p.instanceId],
              [pSda.pin_id, pScl.pin_id],
              'Use a STEMMA QT / Qwiic to male-header cable (black GND, red V+, blue SDA, yellow SCL).'
            )
          );
          continue;
        }
        nets.add(sdaNet, 'i2c', claim(mcu, sda, false));
        nets.add(sdaNet, 'i2c', sdaMember);
        nets.add(sclNet, 'i2c', claim(mcu, scl, false));
        nets.add(sclNet, 'i2c', sclMember);
        linked.get(p.instanceId)!.add('I2C');
        // Joined through an adapter cable on one QT socket: its other sockets host the next boards.
        const adapterConnector = board.contactsOf(pSda.pin_id).find((c) => c.viaAdapter && c.contact.contact_id === sdaMember.contactId)?.connector.connector_id;
        if (adapterConnector && ports.length > 1) {
          freePorts.set(
            p.instanceId,
            ports.filter((port) => port.connector.connector_id !== adapterConnector).map((port) => ({ connectorId: port.connector.connector_id, anchorId: port.anchorId }))
          );
          chain.push(p.instanceId);
        }
      }

      // Devices behind the multiplexer: each on its own channel's SDn/SCn (the mux is on the main bus).
      for (const [id, n] of muxed) {
        if (!muxBoard || !linked.get(muxBoard.instanceId)?.has('I2C')) break;
        const board = boards.get(id)!;
        const details = board.interfaceDetails('I2C')[0] ?? {};
        const pSda = board.pinFromDetail(details, 'sda_pin_id') ?? PERIPHERAL_NAMES.sda.flatMap((x) => board.pinsByName(x))[0] ?? null;
        const pScl = board.pinFromDetail(details, 'scl_pin_id') ?? PERIPHERAL_NAMES.scl.flatMap((x) => board.pinsByName(x))[0] ?? null;
        const ch = muxChannels.find((c) => c.n === n)!;
        if (!pSda || !pScl) continue;
        const base = `${muxBoard.instanceId.toUpperCase()}_CH${n}`;
        nets.add(`${base}_SDA`, 'i2c', claim(muxBoard, ch.sd, true));
        nets.add(`${base}_SDA`, 'i2c', claim(board, pSda, true));
        nets.add(`${base}_SCL`, 'i2c', claim(muxBoard, ch.sc, true));
        nets.add(`${base}_SCL`, 'i2c', claim(board, pScl, true));
        require(muxBoard.instanceId, ch.sd, ch.sc);
        require(id, pSda, pScl);
        linked.get(id)!.add('I2C');
      }
    }
  }

  // --- SPI: shared SCK/MOSI/MISO, one chip select per device ------------------------------------
  const spiPeripherals = peripherals.filter((p) => p.links.some((l) => l.interface === 'SPI'));
  let spiBus: { name: string; sck: HardwarePin; mosi: HardwarePin; miso: HardwarePin | null; csHint: HardwarePin | null } | null = null;
  if (spiPeripherals.length > 0) {
    for (const details of mcu.interfaceDetails('SPI')) {
      const sck = mcu.pinFromDetail(details, 'sck_pin_id');
      const mosi = mcu.pinFromDetail(details, 'mosi_pin_id');
      if (sck && mosi && !usedMcuSignalPins.has(sck.pin_id) && !usedMcuSignalPins.has(mosi.pin_id)) {
        const miso = mcu.pinFromDetail(details, 'miso_pin_id');
        const instance = mcu.functionsOf(sck).find((f) => f.family === 'SPI')?.instance;
        spiBus = {
          name: instance !== undefined && instance !== null ? `SPI${instance}` : 'SPI',
          sck,
          mosi,
          miso: miso && !usedMcuSignalPins.has(miso.pin_id) ? miso : null,
          csHint: mcu.pinFromDetail(details, 'cs_pin_id'),
        };
        break;
      }
    }
    if (!spiBus) {
      const bus = pickBus('SPI', { sck: SPI_ROLE_ALIASES.sck, mosi: SPI_ROLE_ALIASES.mosi, miso: SPI_ROLE_ALIASES.miso, cs: SPI_ROLE_ALIASES.cs }, ['miso', 'cs']);
      if (bus) {
        spiBus = {
          name: bus.instance !== null ? `SPI${bus.instance}` : 'SPI',
          sck: bus.pins['sck']!,
          mosi: bus.pins['mosi']!,
          miso: bus.pins['miso'] ?? null,
          csHint: bus.pins['cs'] ?? null,
        };
      }
    }
    if (!spiBus) {
      const named = (names: string[]) => names.flatMap((n) => mcu.pinsByName(n)).find((p) => !usedMcuSignalPins.has(p.pin_id) && mcu.isWireable(p.pin_id)) ?? null;
      const sck = named(['SCK', 'SCLK']);
      const mosi = named(['MOSI', 'MO', 'COPI']);
      if (sck && mosi) spiBus = { name: 'SPI', sck, mosi, miso: named(['MISO', 'MI', 'CIPO']), csHint: named(['CS', 'SS']) };
    }
    if (!spiBus) {
      // A record with no SPI pin at all says nothing about the board (AI-sourced records have
      // dropped SCK/MOSI/MISO): that is unverified, not "no free bus".
      const recordHasSpi = mcu.record.pins.some(
        (pin) => hasFunction(pin, 'SPI') || /^(SCK|SCLK|MOSI|MISO|MO|MI|COPI|CIPO)$/i.test(pin.pin_name)
      );
      results.push(
        recordHasSpi
          ? result('required_host_interface', 'BLOCKER', `${mcu.label} has no free SPI bus.`, [mcu.instanceId, ...spiPeripherals.map((p) => p.instanceId)], [], 'Choose a controller with a free SPI bus.')
          : result(
              'required_host_interface',
              'UNKNOWN',
              `${mcu.label}'s record lists no SPI pins (SCK/MOSI/MISO), so ${spiPeripherals.map((p) => boards.get(p.instanceId)?.label ?? p.instanceId).join(', ')} could not be wired over SPI.`,
              [mcu.instanceId, ...spiPeripherals.map((p) => p.instanceId)],
              [],
              "Check the board's pinout: the record may be incomplete. Most dev boards break out SPI."
            )
      );
    } else {
      usedMcuSignalPins.add(spiBus.sck.pin_id);
      usedMcuSignalPins.add(spiBus.mosi.pin_id);
      if (spiBus.miso) usedMcuSignalPins.add(spiBus.miso.pin_id);
    }
  }

  // --- field buses: CAN and RS-485 ---------------------------------------------------------------
  // CAN goes before the UARTs: CAN pins are the scarcest (an STM32H7 offers FDCAN1 only on pins
  // UART4 can also use, and a UART took them on a 20-module bench). RS-485 needs a UART, so it
  // follows the UART section.
  // A transceiver links the controller (CAN TX/RX, or a UART + a direction line for RS-485) to a
  // differential pair; every device on the bus joins that pair (multidrop). Pins are matched by the
  // record's interface details, else by their usual silkscreen names.
  const namedPin = (board: Board, re: RegExp): HardwarePin | null =>
    board.record.pins.find((pin) => !isPowerPin(pin) && re.test(pin.pin_name.trim().toUpperCase())) ?? null;
  const detailOr = (board: Board, type: string, key: string, re: RegExp): HardwarePin | null =>
    board.interfaceDetails(type).map((d) => board.pinFromDetail(d, key)).find(Boolean) ?? namedPin(board, re);

  interface FieldMember {
    p: AllocInstance;
    board: Board;
    hi: HardwarePin;
    lo: HardwarePin;
  }
  /** Joins every member's pair onto one bus; members count as linked once a transceiver reaches the controller. */
  const joinFieldBus = (family: 'CAN' | 'RS485', members: FieldMember[], transceiversWired: number, netNames: [string, string]) => {
    const cls: NetClass = family === 'CAN' ? 'can' : 'rs485';
    if (members.length >= 2 || (members.length === 1 && transceiversWired > 0)) {
      for (const m of members) {
        nets.add(netNames[0], cls, claim(m.board, m.hi, true));
        nets.add(netNames[1], cls, claim(m.board, m.lo, true));
        require(m.p.instanceId, m.hi, m.lo);
        if (transceiversWired > 0) linked.get(m.p.instanceId)!.add(family);
      }
    }
    if (members.length >= 2 && transceiversWired > 0) {
      results.push(
        result(
          'protocol_compatibility',
          'PASS',
          `${family === 'CAN' ? 'CAN' : 'RS-485'} bus: ${members.map((m) => m.board.label).join(', ')} share ${netNames.join(' / ')} (multidrop). Terminate both ends of the bus with 120 Ω.`,
          members.map((m) => m.p.instanceId)
        )
      );
    }
  };
  const needsTransceiver = (family: string, devices: AllocInstance[], fix: string) =>
    result(
      'required_host_interface',
      'BLOCKER',
      `${devices.map((d) => boards.get(d.instanceId)!.label).join(', ')} ${devices.length === 1 ? 'needs' : 'need'} ${family === 'CAN' ? 'a CAN' : 'an RS-485'} transceiver wired to ${mcu.label}.`,
      [mcu.instanceId, ...devices.map((d) => d.instanceId)],
      [],
      fix
    );

  // CAN
  const canPeripherals = peripherals.filter((p) => p.links.some((l) => l.interface === 'CAN'));
  if (canPeripherals.length > 0) {
    const field: FieldMember[] = [];
    const devices: AllocInstance[] = [];
    let wired = 0;
    for (const p of canPeripherals) {
      const board = boards.get(p.instanceId)!;
      const hi = namedPin(board, /^CAN[_-]?H(?:I|IGH)?$/);
      const lo = namedPin(board, /^CAN[_-]?L(?:O|OW)?$/);
      const tx = detailOr(board, 'CAN', 'tx_pin_id', /^(?:TXD|CTX|CANTX|CAN_TX|TX|D)$/);
      const rx = detailOr(board, 'CAN', 'rx_pin_id', /^(?:RXD|CRX|CANRX|CAN_RX|RX|R)$/);
      if (!hi || !lo) {
        results.push(result('protocol_compatibility', 'BLOCKER', `${board.label} lists CAN but its CANH/CANL pins are not identified in the record.`, [p.instanceId]));
        continue;
      }
      field.push({ p, board, hi, lo });
      if (!tx || !rx) {
        devices.push(p);
        continue;
      }
      // A transceiver: the controller's CAN controller drives TXD and reads RXD.
      require(p.instanceId, tx, rx);
      let bus: { instance: number | null; pins: Record<string, HardwarePin> } | null = null;
      for (const details of mcu.interfaceDetails('CAN')) {
        const mTx = mcu.pinFromDetail(details, 'tx_pin_id');
        const mRx = mcu.pinFromDetail(details, 'rx_pin_id');
        if (!bus && mTx && mRx && !usedMcuSignalPins.has(mTx.pin_id) && !usedMcuSignalPins.has(mRx.pin_id)) {
          bus = { instance: mcu.functionsOf(mTx).find((f) => f.family === 'CAN')?.instance ?? null, pins: { tx: mTx, rx: mRx } };
        }
      }
      if (bus && claimedInstances.has(instanceKey('CAN', bus.instance))) bus = null;
      bus ??= pickBus('CAN', { tx: ['TX'], rx: ['RX'] });
      if (bus) claimedInstances.add(instanceKey('CAN', bus.instance));
      if (!bus) {
        const hasCan = mcu.record.pins.some((pin) => hasFunction(pin, 'CAN')) || mcu.record.interfaces.interfaces.some((i) => /CAN/i.test(i.type));
        results.push(
          hasCan
            ? result('required_host_interface', 'BLOCKER', `${mcu.label} has no free CAN controller for ${board.label}.`, [mcu.instanceId, p.instanceId], [tx.pin_id, rx.pin_id])
            : result(
                'required_host_interface',
                'UNKNOWN',
                `${mcu.label}'s record lists no CAN controller pins (CAN TX/RX), so ${board.label} could not be wired to it.`,
                [mcu.instanceId, p.instanceId],
                [tx.pin_id, rx.pin_id],
                'Check the controller pinout for its CAN/FDCAN pins, or use an SPI CAN controller (e.g. MCP2515) instead of a bare transceiver.'
              )
        );
        continue;
      }
      const mTx = bus.pins['tx']!;
      const mRx = bus.pins['rx']!;
      usedMcuSignalPins.add(mTx.pin_id);
      usedMcuSignalPins.add(mRx.pin_id);
      const name = bus.instance !== null ? `CAN${bus.instance}` : 'CAN';
      nets.add(`${name}_TX`, 'can', claim(mcu, mTx, true));
      nets.add(`${name}_TX`, 'can', claim(board, tx, true));
      nets.add(`${name}_RX`, 'can', claim(mcu, mRx, true));
      nets.add(`${name}_RX`, 'can', claim(board, rx, true));
      linked.get(p.instanceId)!.add('CAN');
      wired += 1;
    }
    if (devices.length > 0 && wired === 0) results.push(needsTransceiver('CAN', devices, 'Add a 3.3 V CAN transceiver (e.g. SN65HVD230) between the controller and the bus.'));
    joinFieldBus('CAN', field, wired, ['CAN_H', 'CAN_L']);
  }

  // --- UART: point to point, one controller UART per device, TX crossed to RX -------------------
  /** The board's labelled UART (record details) first, then any free TX/RX-capable pair. */
  const takeUart = (): { instance: number | null; pins: Record<string, HardwarePin> } | null => {
    let bus: { instance: number | null; pins: Record<string, HardwarePin> } | null = null;
    for (const details of mcu.interfaceDetails('UART')) {
      const tx = mcu.pinFromDetail(details, 'tx_pin_id');
      const rx = mcu.pinFromDetail(details, 'rx_pin_id');
      const instance = tx ? (mcu.functionsOf(tx).find((f) => f.family === 'UART')?.instance ?? null) : null;
      if (claimedInstances.has(instanceKey('UART', instance))) continue;
      if (tx && rx && !usedMcuSignalPins.has(tx.pin_id) && !usedMcuSignalPins.has(rx.pin_id) && mcu.isWireable(tx.pin_id) && mcu.isWireable(rx.pin_id)) {
        bus = { instance, pins: { tx, rx } };
        break;
      }
    }
    bus ??= pickBus('UART', { tx: ['TX'], rx: ['RX'] });
    if (!bus && !claimedInstances.has(instanceKey('UART', null))) {
      const byName = (names: string[]) => names.flatMap((n) => mcu.pinsByName(n)).find((p) => !usedMcuSignalPins.has(p.pin_id) && mcu.isWireable(p.pin_id)) ?? null;
      const tx = byName(['TX', 'TXD', 'TX0']);
      const rx = byName(['RX', 'RXD', 'RX0']);
      if (tx && rx) bus = { instance: null, pins: { tx, rx } };
    }
    if (bus) claimedInstances.add(instanceKey('UART', bus.instance));
    return bus;
  };
  /** How many UARTs the record shows, for an honest "no free UART" message. */
  const uartCount = () => {
    const instances = new Set<string>();
    for (const pin of mcu.record.pins) for (const f of mcu.functionsOf(pin)) if (f.family === 'UART') instances.add(String(f.instance));
    return instances.size;
  };
  const noFreeUart = (board: Board, p: AllocInstance, pins: string[]) =>
    result(
      'required_host_interface',
      'BLOCKER',
      `${mcu.label} has no free UART for ${board.label}${uartCount() > 0 ? ` (its record lists ${uartCount()} UART${uartCount() === 1 ? '' : 's'}, all in use)` : ''}.`,
      [mcu.instanceId, p.instanceId],
      pins,
      'Use a controller with more UARTs, or move a module to I2C.'
    );
  const uartPeripherals = peripherals.filter((p) => p.links.some((l) => l.interface === 'UART'));
  for (const p of uartPeripherals) {
    const board = boards.get(p.instanceId)!;
    const details = board.interfaceDetails('UART')[0] ?? {};
    const pTx = board.pinFromDetail(details, 'tx_pin_id') ?? PERIPHERAL_NAMES.tx.flatMap((n) => board.pinsByName(n))[0] ?? null;
    const pRx = board.pinFromDetail(details, 'rx_pin_id') ?? PERIPHERAL_NAMES.rx.flatMap((n) => board.pinsByName(n))[0] ?? null;
    if (!pTx || !pRx) {
      results.push(result('protocol_compatibility', 'BLOCKER', `${board.label} lists UART but its TX/RX pins are not identified in the record.`, [p.instanceId]));
      continue;
    }
    require(p.instanceId, pTx, pRx);
    const bus = takeUart();
    if (!bus) {
      results.push(noFreeUart(board, p, [pTx.pin_id, pRx.pin_id]));
      continue;
    }
    const mTx = bus.pins['tx']!;
    const mRx = bus.pins['rx']!;
    usedMcuSignalPins.add(mTx.pin_id);
    usedMcuSignalPins.add(mRx.pin_id);
    const name = bus.instance !== null ? `UART${bus.instance}` : 'UART';
    // Controller TX drives the module's RX, and the module's TX drives the controller's RX.
    nets.add(`${name}_TX`, 'uart', claim(mcu, mTx, true));
    nets.add(`${name}_TX`, 'uart', claim(board, pRx, true));
    nets.add(`${name}_RX`, 'uart', claim(mcu, mRx, true));
    nets.add(`${name}_RX`, 'uart', claim(board, pTx, true));
    linked.get(p.instanceId)!.add('UART');
  }

  // RS-485
  const rs485Peripherals = peripherals.filter((p) => p.links.some((l) => l.interface === 'RS485'));
  if (rs485Peripherals.length > 0) {
    const field: FieldMember[] = [];
    const devices: AllocInstance[] = [];
    let wired = 0;
    for (const p of rs485Peripherals) {
      const board = boards.get(p.instanceId)!;
      const hi = namedPin(board, /^(?:A|A\+|D\+|RS485[_-]?A|485[_-]?A|DATA\+|TR\+)$/);
      const lo = namedPin(board, /^(?:B|B-|D-|RS485[_-]?B|485[_-]?B|DATA-|TR-)$/);
      const di = detailOr(board, 'RS485', 'tx_pin_id', /^(?:DI|DIN|TXD|TX|TXI|TX-I|TX_I)$/);
      const ro = detailOr(board, 'RS485', 'rx_pin_id', /^(?:RO|ROUT|RXD|RX|RXO|RX-O|RX_O)$/);
      if (!hi || !lo) {
        results.push(result('protocol_compatibility', 'BLOCKER', `${board.label} lists RS-485 but its A/B pins are not identified in the record.`, [p.instanceId]));
        continue;
      }
      field.push({ p, board, hi, lo });
      if (!di || !ro) {
        devices.push(p);
        continue;
      }
      // A transceiver: a controller UART (TX → DI, RO → RX) and one line for the driver direction.
      require(p.instanceId, di, ro);
      const bus = takeUart();
      if (!bus) {
        results.push(noFreeUart(board, p, [di.pin_id, ro.pin_id]));
        continue;
      }
      const mTx = bus.pins['tx']!;
      const mRx = bus.pins['rx']!;
      usedMcuSignalPins.add(mTx.pin_id);
      usedMcuSignalPins.add(mRx.pin_id);
      const name = bus.instance !== null ? `UART${bus.instance}` : 'UART';
      nets.add(`${name}_TX`, 'uart', claim(mcu, mTx, true));
      nets.add(`${name}_TX`, 'uart', claim(board, di, true));
      nets.add(`${name}_RX`, 'uart', claim(mcu, mRx, true));
      nets.add(`${name}_RX`, 'uart', claim(board, ro, true));
      // Half duplex: DE and /RE share one controller line (high = transmit).
      const de = namedPin(board, /^(?:DE|RTS|DE\/RE|DE_RE|TXEN|DIR)$/);
      const re = namedPin(board, /^(?:RE|~RE|NRE|\/RE|RE_N|RE#)$/);
      if (de || re) {
        const dir = freeGeneralPin(isGpioCapable);
        if (!dir) {
          results.push(
            result('required_host_interface', 'BLOCKER', `No free controller pin for ${board.label} driver enable.`, [mcu.instanceId, p.instanceId], [de?.pin_id, re?.pin_id].filter((x): x is string => Boolean(x)))
          );
        } else {
          usedMcuSignalPins.add(dir.pin_id);
          const netName = `${p.instanceId.toUpperCase()}_DE`;
          nets.add(netName, 'rs485', claim(mcu, dir, true));
          if (de) nets.add(netName, 'rs485', claim(board, de, true));
          if (re) nets.add(netName, 'rs485', claim(board, re, true));
          require(p.instanceId, de, re);
        }
      }
      linked.get(p.instanceId)!.add('RS485');
      wired += 1;
    }
    if (devices.length > 0 && wired === 0) results.push(needsTransceiver('RS485', devices, 'Add a 3.3 V RS-485 transceiver (e.g. MAX3485) between a controller UART and the bus.'));
    joinFieldBus('RS485', field, wired, ['RS485_A', 'RS485_B']);
  }

  // --- SPI device lines (after UART so fixed-function pins are already claimed) -------------------
  if (spiBus) {
    for (const p of spiPeripherals) {
      const board = boards.get(p.instanceId)!;
      const details = board.interfaceDetails('SPI')[0] ?? {};
      const pick = (key: string, names: string[]) => board.pinFromDetail(details, key) ?? names.flatMap((n) => board.pinsByName(n))[0] ?? null;
      const pSck = pick('sck_pin_id', PERIPHERAL_NAMES.sck);
      const pMosi = pick('mosi_pin_id', PERIPHERAL_NAMES.mosi);
      const pMiso = pick('miso_pin_id', PERIPHERAL_NAMES.miso);
      const pCs = pick('cs_pin_id', PERIPHERAL_NAMES.cs);
      if (!pSck || !pMosi || !pCs) {
        results.push(result('protocol_compatibility', 'BLOCKER', `${board.label} lists SPI but its SCK/MOSI/CS pins are not identified in the record.`, [p.instanceId]));
        continue;
      }
      const csPin =
        (spiBus.csHint && !usedMcuSignalPins.has(spiBus.csHint.pin_id) && !isReservedForSignal(spiBus.csHint) && mcu.isWireable(spiBus.csHint.pin_id)
          ? spiBus.csHint
          : null) ?? freeGeneralPin(isGpioCapable);
      if (!csPin) {
        results.push(result('required_host_interface', 'BLOCKER', `No free controller pin for ${board.label} chip select.`, [mcu.instanceId, p.instanceId], [pCs.pin_id]));
        continue;
      }
      usedMcuSignalPins.add(csPin.pin_id);
      require(p.instanceId, pSck, pMosi, pCs, spiBus.miso ? pMiso : null);
      nets.add(`${spiBus.name}_SCK`, 'spi', claim(mcu, spiBus.sck, false));
      nets.add(`${spiBus.name}_SCK`, 'spi', claim(board, pSck, true));
      nets.add(`${spiBus.name}_MOSI`, 'spi', claim(mcu, spiBus.mosi, false));
      nets.add(`${spiBus.name}_MOSI`, 'spi', claim(board, pMosi, true));
      if (spiBus.miso && pMiso) {
        nets.add(`${spiBus.name}_MISO`, 'spi', claim(mcu, spiBus.miso, false));
        nets.add(`${spiBus.name}_MISO`, 'spi', claim(board, pMiso, true));
      }
      const csNet = `${p.instanceId.toUpperCase()}_CS`;
      nets.add(csNet, 'spi', claim(mcu, csPin, true));
      nets.add(csNet, 'spi', claim(board, pCs, true));
      linked.get(p.instanceId)!.add('SPI');
    }
  }

  // --- level shifters / buffers ---------------------------------------------------------------
  // A 74AHCT125, a TXS0108 or a BSS138 board: the controller drives the low-voltage input side (A /
  // LV) and the output side (Y / B / HV) drives the 5 V part. A link the resolver put on an output
  // pin is moved to that channel's input (dev 2026-10-20: a 74AHCT125 Y1 was wired to an ESP32 pin,
  // 5 V into a 3.3 V input).
  const SHIFTER = /\b74A?HCT(?:125|126|245)\b|level.?shift|\bTX[SB]010[48]\b|\bBSS138\b/i;
  const isShifter = (b: Board) => !isPlaceholderEntity(b.entity) && SHIFTER.test(`${b.label} ${b.record.identity.main_silicon ?? ''}`);
  const channelOf = (name: string): { n: string; side: 'in' | 'out' | 'oe' } | null => {
    const t = name.trim().toUpperCase().replace(/[\s_/~#-]/g, '');
    const lead = /^(\d)(A|Y|OE)$/.exec(t);
    if (lead) return { n: lead[1]!, side: lead[2] === 'A' ? 'in' : lead[2] === 'Y' ? 'out' : 'oe' };
    const tail = /^(A|LV|Y|B|HV|OE)(\d)$/.exec(t);
    if (tail) return { n: tail[2]!, side: tail[1] === 'A' || tail[1] === 'LV' ? 'in' : tail[1] === 'OE' ? 'oe' : 'out' };
    return null;
  };
  const shifterPin = (b: Board, n: string, side: 'in' | 'out' | 'oe'): HardwarePin | null =>
    b.record.pins.find((pin) => {
      const c = channelOf(pin.pin_name);
      return c?.n === n && c.side === side;
    }) ?? null;
  /** Pins tied to ground once the ground net exists (a buffer channel's output enable). */
  const groundTies: Array<{ board: Board; pin: HardwarePin }> = [];

  // --- GPIO / ANALOG / PWM: the module pin the resolver named, a capable free controller pin ------
  for (const p of peripherals) {
    const board = boards.get(p.instanceId)!;
    // An addressable LED strip's data line is wired below (through a buffer when one is on the bench).
    if (placeholderKindOf(board.entity.hardwareEntityId) === 'PIXELS') continue;
    for (const link of p.links) {
      if (link.interface !== 'GPIO' && link.interface !== 'ANALOG' && link.interface !== 'PWM') continue;
      let pPin = link.pinName ? board.pinsByName(link.pinName)[0] : undefined;
      if (!pPin) continue; // validated upstream; a stale composition just skips the line
      if (isShifter(board)) {
        const c = channelOf(pPin.pin_name);
        if (c?.side === 'out') pPin = shifterPin(board, c.n, 'in') ?? pPin;
        // A buffer's output enable is tied low, not driven by a controller pin.
        if (c?.side === 'oe') {
          groundTies.push({ board, pin: pPin });
          require(p.instanceId, pPin);
          continue;
        }
      }
      // Power and ground pins are wired by the power plan below, never to a controller signal pin:
      // a supply output on a GPIO (5 V into a 3.3 V pin) would damage the controller.
      if (isPowerPin(pPin)) continue;
      // A pin a bus already wired (an SPI chip select the resolver also listed as GPIO) keeps that
      // one line. Wiring it again took a second controller pin onto the same net: two outputs
      // driving one chip select (seen on dev 2026-10-15: SD1_CS on GP17 and GP14).
      if (nets.hasMember(p.instanceId, pPin.pin_id)) continue;
      const capable =
        link.interface === 'ANALOG'
          ? (pin: HardwarePin) => hasFunction(pin, 'ADC') || pin.signal_class === 'analog'
          : link.interface === 'PWM'
            ? (pin: HardwarePin) => hasFunction(pin, 'PWM')
            : isGpioCapable;
      // A 5 V output (an HC-SR04 echo) lands on a 5 V tolerant pin when the controller has one; an
      // enable/speed line (L298N ENA) on a PWM-capable pin, so speed control works.
      const fiveVoltOut = pPin.direction === 'output' && (parseVolts(pPin.voltage_domain) ?? 0) > mcu.logicVolts() + 0.3;
      const speedLine = /^(EN[AB]?|EN\d|PWM[A-Z0-9]*|SPEED)$/i.test(pPin.pin_name.trim());
      const prefer = (pin: HardwarePin) =>
        (fiveVoltOut && !isFiveVoltTolerant(pin.voltage_domain) ? 100 : 0) + (speedLine && !hasFunction(pin, 'PWM') ? 50 : 0);
      const mPin = freeGeneralPin(capable, prefer);
      require(p.instanceId, pPin);
      if (!mPin) {
        results.push(
          result('required_host_interface', 'BLOCKER', `No free ${link.interface === 'GPIO' ? 'GPIO' : link.interface} pin on ${mcu.label} for ${board.label} ${pPin.pin_name}.`, [mcu.instanceId, p.instanceId], [pPin.pin_id])
        );
        continue;
      }
      usedMcuSignalPins.add(mPin.pin_id);
      const netName = `${p.instanceId.toUpperCase()}_${pPin.pin_name.toUpperCase().replace(/[^A-Z0-9]+/g, '')}`;
      const cls: NetClass = link.interface === 'ANALOG' ? 'analog' : link.interface === 'PWM' ? 'pwm' : 'gpio';
      nets.add(netName, cls, claim(mcu, mPin, true));
      nets.add(netName, cls, claim(board, pPin, true));
      linked.get(p.instanceId)!.add(link.interface);
    }
  }

  // --- addressable LED strips (WS2812B / NeoPixel) -----------------------------------------------
  // DIN needs 0.7 x VDD (3.5 V at 5 V): from a 3.3 V controller it goes through a buffer channel
  // (controller -> A, Y -> DIN, that channel's /OE to GND); a 5 V controller drives it directly.
  const usedChannels = new Set<string>();
  for (const p of peripherals) {
    const strip = boards.get(p.instanceId)!;
    if (placeholderKindOf(strip.entity.hardwareEntityId) !== 'PIXELS') continue;
    const din = strip.pinsByName('DIN')[0];
    if (!din) continue;
    require(p.instanceId, din);
    const net = `${p.instanceId.toUpperCase()}_DIN`;
    const shifter = mcu.logicVolts() < 4.5 ? (peripherals.map((x) => boards.get(x.instanceId)!).find(isShifter) ?? null) : null;
    const channels = shifter
      ? [...new Set(shifter.record.pins.map((pin) => channelOf(pin.pin_name)?.n).filter((n): n is string => Boolean(n)))]
          .map((n) => ({ n, a: shifterPin(shifter, n, 'in'), y: shifterPin(shifter, n, 'out') }))
          .filter(
            (c): c is { n: string; a: HardwarePin; y: HardwarePin } =>
              Boolean(c.a && c.y) && !nets.hasMember(shifter.instanceId, c.y!.pin_id) && !usedChannels.has(`${shifter.instanceId}:${c.n}`)
          )
          // A channel the controller already drives first (the resolver linked it).
          .sort((x, z) => Number(nets.hasMember(shifter.instanceId, z.a.pin_id)) - Number(nets.hasMember(shifter.instanceId, x.a.pin_id)))
      : [];
    const channel = channels[0];
    if (shifter && channel) {
      usedChannels.add(`${shifter.instanceId}:${channel.n}`);
      if (!nets.hasMember(shifter.instanceId, channel.a.pin_id)) {
        const mPin = freeGeneralPin(isGpioCapable);
        if (!mPin) {
          results.push(result('required_host_interface', 'BLOCKER', `No free GPIO pin on ${mcu.label} for ${strip.label} data.`, [mcu.instanceId, p.instanceId], [din.pin_id]));
          continue;
        }
        usedMcuSignalPins.add(mPin.pin_id);
        nets.add(`${p.instanceId.toUpperCase()}_DATA`, 'gpio', claim(mcu, mPin, true));
        nets.add(`${p.instanceId.toUpperCase()}_DATA`, 'gpio', claim(shifter, channel.a, true));
      }
      nets.add(net, 'gpio', claim(shifter, channel.y, true));
      nets.add(net, 'gpio', claim(strip, din, true));
      const oe = shifterPin(shifter, channel.n, 'oe');
      if (oe) groundTies.push({ board: shifter, pin: oe });
      require(shifter.instanceId, channel.a, channel.y, oe);
      linked.get(shifter.instanceId)!.add('GPIO');
      linked.get(p.instanceId)!.add('GPIO');
      results.push(
        result(
          'logic_voltage_compatibility',
          'PASS',
          `${strip.label} data: ${mcu.label} → ${shifter.label} ${channel.a.pin_name} → ${channel.y.pin_name} → DIN, at 5 V logic.`,
          [p.instanceId, shifter.instanceId, mcu.instanceId],
          [din.pin_id]
        )
      );
      continue;
    }
    const mPin = freeGeneralPin(isGpioCapable);
    if (!mPin) {
      results.push(result('required_host_interface', 'BLOCKER', `No free GPIO pin on ${mcu.label} for ${strip.label} data.`, [mcu.instanceId, p.instanceId], [din.pin_id]));
      continue;
    }
    usedMcuSignalPins.add(mPin.pin_id);
    nets.add(net, 'gpio', claim(mcu, mPin, true));
    nets.add(net, 'gpio', claim(strip, din, true));
    linked.get(p.instanceId)!.add('GPIO');
    const logic = mcu.logicVolts();
    results.push(
      logic >= 4.5
        ? result('logic_voltage_compatibility', 'PASS', `${strip.label} DIN driven at ${logic} V by ${mcu.label} ${mPin.pin_name}.`, [p.instanceId, mcu.instanceId], [din.pin_id])
        : result(
            'logic_voltage_compatibility',
            'BLOCKER',
            `${strip.label} DIN needs 0.7 × VDD (3.5 V at 5 V), but ${mcu.label} ${mPin.pin_name} drives ${logic} V.`,
            [p.instanceId, mcu.instanceId],
            [din.pin_id, mPin.pin_id],
            'Buffer DIN with a 74AHCT125 powered from 5 V (and a 330 Ω series resistor on DIN).'
          )
    );
  }

  // --- power ---------------------------------------------------------------------------------------
  // Bench supplies (chargers, boost converters, regulators: boards that run on their own input and
  // expose a rated output) are chained from their records, then power the controller and the
  // modules. A module prefers a bench supply over the controller's own regulator; the controller's
  // rail is the fallback. Every voltage comes from a record; nothing is wired on a guess.
  const mcuGround = mcu.record.pins.find((pin) => isGroundPin(pin) && mcu.isWireable(pin.pin_id)) ?? null;
  const groundOf = (board: Board) => board.record.pins.find((pin) => isGroundPin(pin) && board.isWireable(pin.pin_id)) ?? null;
  const joinGround = (board: Board): boolean => {
    const ground = groundOf(board);
    if (!ground || !mcuGround) return false;
    nets.add('GND', 'ground', claim(mcu, mcuGround, false));
    nets.add('GND', 'ground', claim(board, ground, false));
    require(board.instanceId, ground);
    return true;
  };
  for (const { board, pin } of groundTies) {
    if (!mcuGround) break;
    nets.add('GND', 'ground', claim(mcu, mcuGround, false));
    nets.add('GND', 'ground', claim(board, pin, true));
  }
  const mcuRails = mcu.record.pins
    .filter((pin) => pin.direction === 'power_out' && mcu.isWireable(pin.pin_id))
    // The declared domain first: a pin named "3V" (QT Py) is a 3.3 V rail, which its name alone misreads as 3.0 V.
    .map((pin) => ({ pin, volts: parseVolts(pin.voltage_domain) ?? parseVolts(pin.pin_name) }))
    .filter((r): r is { pin: HardwarePin; volts: number } => r.volts !== null && (r.volts === 3.3 || r.volts === 5));
  const mcuLogic = mcu.logicVolts();
  const peripheralRails = new Map<string, number | null>();
  /** What powers each placeholder (a rail chosen for its kind), for the placeholder summary. */
  const placeholderRails = new Map<string, string | null>();

  interface RailSource {
    board: Board;
    pin: HardwarePin;
    volts: number;
    key: string;
    /** A battery's empty-to-full range: every voltage in it must suit the input it feeds. */
    range?: [number, number];
    /** The bench's outside supply (a DC input or a battery the brief names). */
    outside?: boolean;
  }
  const kindOf = (b: Board) => placeholderKindOf(b.entity.hardwareEntityId);
  const isOutsideSource = (b: Board) => kindOf(b) === 'DCIN' || kindOf(b) === 'BATTERY';
  const hasBattery = peripherals.some((p) => placeholderKindOf(p.entity.hardwareEntityId) === 'BATTERY');
  const CHARGER = /charg|\bTP4056\b|\bMCP7383\d\b|\bBQ2\d{3}\b|\bLTC40\d\d\b/i;
  const isCharger = (b: Board) => !isPlaceholderEntity(b.entity) && CHARGER.test(`${b.label} ${b.record.identity.main_silicon ?? ''} ${b.record.identity.prototype_role ?? ''}`);
  const hasCharger = [...boards.values()].some(isCharger);

  /**
   * A high-side load switch (a MOSFET or pushbutton power-switch board: VIN → VOUT under a control
   * pin) switches a pump or fan; its VIN is wired from the load's supply, not as a bench supply.
   */
  const LOAD_SWITCH = /mosfet|load switch|power switch|\bIRLZ?\d{2,}|\bIRF5\d\d|[np]-?channel/i;
  const hasLoads = peripherals.some((p) => placeholderKindOf(p.entity.hardwareEntityId) === 'LOAD');
  const switchPins = (b: Board): { vin: HardwarePin; vout: HardwarePin } | null => {
    if (!hasLoads || isPlaceholderEntity(b.entity) || !LOAD_SWITCH.test(`${b.label} ${b.record.identity.main_silicon ?? ''}`)) return null;
    const vin = b.record.pins.find((pin) => /^(VIN|V\+|VIN\+|IN\+)$/i.test(pin.pin_name.trim()) && b.isWireable(pin.pin_id));
    const vout = b.record.pins.find((pin) => /^(VOUT|OUT|OUT\+|LOAD\+)$/i.test(pin.pin_name.trim()) && b.isWireable(pin.pin_id));
    return vin && vout ? { vin, vout } : null;
  };
  const loadSwitches = new Set(peripherals.filter((p) => switchPins(boards.get(p.instanceId)!)).map((p) => p.instanceId));
  const controllerSources: RailSource[] = mcuRails.map((r) => ({ board: mcu, pin: r.pin, volts: r.volts, key: mcuRailKey(r.volts) }));
  const supplies = peripherals
    .map((p) => boards.get(p.instanceId)!)
    .filter((b) => b.record.interfaces.host_requirement !== 'host_required' && !poweredByCable.has(b.instanceId) && !loadSwitches.has(b.instanceId))
    .map((b) => {
      const { supply_voltage_min_v: min, supply_voltage_max_v: max } = b.record.electrical;
      const range: [number, number] | undefined = kindOf(b) === 'BATTERY' && min != null && max != null ? [min, max] : undefined;
      return {
        board: b,
        inputs: b.record.pins.filter((pin) => pin.direction === 'power_in' && b.isWireable(pin.pin_id)),
        outputs: b.record.pins
          .filter((pin) => pin.direction === 'power_out' && b.isWireable(pin.pin_id))
          .map((pin): RailSource | null => {
            const volts = parseVolts(pin.voltage_domain) ?? parseVolts(pin.pin_name);
            return volts !== null && volts > 0 ? { board: b, pin, volts, key: `${b.instanceId}:${pin.pin_id}`, range, outside: isOutsideSource(b) } : null;
          })
          .filter((o): o is RailSource => o !== null),
      };
    })
    .filter((s) => s.outputs.length > 0);
  const supplyIds = new Set(supplies.map((s) => s.board.instanceId));

  /** Joins a source pin and a consumer pin on the source's own rail net (a battery's is VBAT). */
  const railNameOf = (source: RailSource) =>
    kindOf(source.board) === 'BATTERY' ? (railOwners.get('VBAT') && railOwners.get('VBAT') !== source.key ? `VBAT_${source.board.instanceId.toUpperCase()}` : (railOwners.set('VBAT', source.key), 'VBAT')) : railNetName(source.volts, source.key, source.board.instanceId);
  const wireRail = (source: RailSource, consumer: Board, pin: HardwarePin) => {
    const name = railNameOf(source);
    nets.add(name, 'power', claim(source.board, source.pin, false));
    nets.add(name, 'power', claim(consumer, pin, false));
    if (consumer !== mcu) require(consumer.instanceId, pin);
    if (source.board !== mcu) require(source.board.instanceId, source.pin);
    return name;
  };
  const fits = (s: RailSource, range: [number, number]) =>
    s.range ? s.range[0] >= range[0] - VOLT_EPSILON && s.range[1] <= range[1] + VOLT_EPSILON : fitsRange(s.volts, range);
  /** The fitting source closest to the controller's logic level (3.3 V logic prefers a 3.3 V rail). */
  const pickSource = (sources: RailSource[], range: [number, number]): RailSource | null =>
    sources.filter((s) => fits(s, range)).sort((a, b) => Math.abs(a.volts - mcuLogic) - Math.abs(b.volts - mcuLogic))[0] ?? null;
  const sourceText = (s: RailSource) =>
    s.range ? `${s.board.label} (${s.range[0]}–${s.range[1]} V)` : `${s.board.label} ${s.pin.pin_name} (${Number(s.volts.toFixed(2))} V)`;

  /**
   * A converter's input range when its record gives none: a boost (step-up) converter only takes
   * inputs below its output. (prod 2026-10-16: a PowerBoost 1000 was put on a 7.4 V 2S LiPo; with no
   * input maximum in its record nothing flagged it.)
   */
  const BOOST = /boost|step[- ]?up|\bTPS6103\d|\bTPS6109\d|\bMT3608\b/i;
  const isBoost = (b: Board) => BOOST.test(`${b.label} ${b.record.identity.main_silicon ?? ''}`);
  const supplyInputRange = (b: Board, pin: HardwarePin, outVolts: number | null): [number, number] | null => {
    const own = inputRange(b, pin);
    if (own) return own;
    if (isBoost(b) && outVolts !== null) return [b.record.electrical.supply_voltage_min_v ?? 0.9, Number((outVolts - 0.2).toFixed(2))];
    return null;
  };

  // 1. The supply chain: each supply takes its input from another supply's output (never in a
  //    loop); one that nothing on the bench can feed is a primary source with an outside input.
  const fedBy = new Map<string, string>();
  const isUpstream = (candidate: string, of: string): boolean => {
    for (let id: string | undefined = fedBy.get(of), hops = 0; id && hops < 32; id = fedBy.get(id), hops++) if (id === candidate) return true;
    return false;
  };
  for (const s of supplies) {
    let chosen: { input: HardwarePin; source: RailSource; range: [number, number] } | null = null;
    const out = s.outputs[0]?.volts ?? null;
    for (const input of s.inputs) {
      const range = supplyInputRange(s.board, input, out);
      if (!range) continue;
      const feeders = supplies.filter((o) => o !== s && !isUpstream(s.board.instanceId, o.board.instanceId)).flatMap((o) => o.outputs);
      // The bench's own input (battery, DC jack) first: a regulator is fed from the source, not from a sibling regulator.
      const source = pickSource(feeders.filter((f) => f.outside), range) ?? pickSource(feeders, range);
      if (source) {
        chosen = { input, source, range };
        break;
      }
    }
    joinGround(s.board);
    if (chosen) {
      wireRail(chosen.source, s.board, chosen.input);
      fedBy.set(s.board.instanceId, chosen.source.board.instanceId);
      peripheralRails.set(s.board.instanceId, chosen.source.volts);
      results.push(
        result(
          'required_power_rail',
          'PASS',
          `${s.board.label} ${chosen.input.pin_name} (${rangeText(chosen.range)}) fed from ${sourceText(chosen.source)}.`,
          [chosen.source.board.instanceId, s.board.instanceId],
          [chosen.source.pin.pin_id, chosen.input.pin_id]
        )
      );
      continue;
    }
    peripheralRails.set(s.board.instanceId, null);
    if (isOutsideSource(s.board)) {
      // The supply the brief names (a 12 V adapter, a 2S LiPo): the bench's way in, by design.
      const o = s.outputs[0]!;
      results.push(
        result(
          'required_power_rail',
          'PASS',
          kindOf(s.board) === 'BATTERY'
            ? `${sourceText(o)} powers the bench${hasCharger ? '' : ': charge it before use'}.`
            : `${s.board.label} is the bench's outside supply: connect a ${Number(o.volts.toFixed(2))} V adapter or supply to it.`,
          [s.board.instanceId],
          [o.pin.pin_id]
        )
      );
      continue;
    }
    // A converter the bench's own input cannot feed: say why (wrong range, or a boost on a higher voltage).
    const outsideOut = supplies.filter((o) => o !== s && isOutsideSource(o.board)).flatMap((o) => o.outputs)[0];
    const input = s.inputs[0];
    const range = input ? supplyInputRange(s.board, input, out) : null;
    if (outsideOut && input && range) {
      const tooHigh = (outsideOut.range?.[1] ?? outsideOut.volts) > range[1];
      results.push(
        result(
          'required_power_rail',
          'BLOCKER',
          isBoost(s.board) && out !== null && tooHigh
            ? `${s.board.label} is a step-up (boost) converter: it needs less than its ${out} V output on ${input.pin_name}, but ${sourceText(outsideOut)} is above that, which would damage it.`
            : `${s.board.label} ${input.pin_name} takes ${rangeText(range)}; ${sourceText(outsideOut)} is outside that range.`,
          [s.board.instanceId, outsideOut.board.instanceId],
          [input.pin_id],
          tooHigh && out !== null
            ? `Use a ${out} V step-down (buck) regulator rated for ${outsideOut.range ? `${outsideOut.range[1]}` : outsideOut.volts} V in${out === 5 ? ' (e.g. Pololu D24V22F5, 5.3–36 V in)' : ''}.`
            : 'Use a regulator whose input range covers the supply.'
        )
      );
      continue;
    }
    const accepted = s.inputs
      .map((pin) => {
        const r = inputRange(s.board, pin);
        return `${pin.pin_name}${r ? ` (${rangeText(r)})` : ''}`;
      })
      .join(' or ');
    const listed = s.board.record.electrical.power_source_types;
    // A supply whose input is a plug (a USB-C breakout, a DC jack) is the bench's way in by design;
    // one that needs a battery or a supply the bench does not show is reported.
    const byConnector = s.inputs.length === 0 || (listed.some((t) => /usb|barrel|jack|wall|adapter|mains/i.test(t)) && !listed.some((t) => /batt|li-?po|li-?ion|solar/i.test(t)));
    results.push(
      result(
        'required_power_rail',
        byConnector ? 'PASS' : 'WARNING',
        byConnector
          ? `${s.board.label} is the bench's power source: plug ${listed.length > 0 ? listed.join(' / ') : 'its supply'} into it${accepted ? ` (${accepted})` : ''}.`
          : `${s.board.label} is the bench's power source: nothing on the bench feeds it, so connect ${accepted || 'its input'} from outside${listed.length > 0 ? ` (its record lists: ${listed.join(', ')})` : ''}.`,
        [s.board.instanceId],
        s.inputs.map((pin) => pin.pin_id)
      )
    );
  }
  const supplyOutputs = supplies.flatMap((s) => s.outputs);

  // 2. The controller runs from a bench supply when one fits its power input.
  let controllerFed = false;
  if (supplyOutputs.length > 0) {
    const rank = (pin: HardwarePin) => {
      const i = POWER_PIN_PREFERENCE.indexOf(pin.pin_name.toUpperCase());
      return i === -1 ? POWER_PIN_PREFERENCE.length : i;
    };
    const mcuInputs = mcu.record.pins.filter((pin) => pin.direction === 'power_in' && mcu.isWireable(pin.pin_id)).sort((a, b) => rank(a) - rank(b));
    // A regulated output on any input before the raw supply on any input: a Nucleo takes the buck's
    // 5 V on E5V rather than 12 V straight into VIN, and a 3.3 V regulator the brief asks for is used.
    const regulated = supplyOutputs.filter((s) => !s.outside);
    const candidates = [
      ...mcuInputs.map((input) => ({ input, pool: regulated })),
      ...mcuInputs.map((input) => ({ input, pool: supplyOutputs })),
    ];
    for (const { input, pool } of candidates) {
      const range = inputRange(mcu, input);
      const source = range ? pickSource(pool, range) : null;
      if (!range || !source) continue;
      wireRail(source, mcu, input);
      results.push(
        result('required_power_rail', 'PASS', `${mcu.label} ${input.pin_name} (${rangeText(range)}) on ${sourceText(source)}.`, [mcu.instanceId, source.board.instanceId], [input.pin_id, source.pin.pin_id])
      );
      controllerFed = true;
      break;
    }
    if (!controllerFed) {
      const accepted = mcuInputs
        .map((pin) => {
          const range = inputRange(mcu, pin);
          return range ? `${pin.pin_name} ${rangeText(range)}` : pin.pin_name;
        })
        .join(', ');
      results.push(
        result(
          'required_power_rail',
          'WARNING',
          `${mcu.label} is not powered from the bench supplies: ${accepted ? `its record accepts ${accepted}` : 'its record has no wireable power input'}, and they provide ${supplyOutputs.map(sourceText).join(', ')}. Power it over USB, or check its record.`,
          [mcu.instanceId, ...supplies.map((s) => s.board.instanceId)],
          mcuInputs.map((pin) => pin.pin_id)
        )
      );
    }
  }
  // A USB-powered controller passes USB 5 V out on its VBUS / 5V pin (Pico VBUS, DevKitC 5V), so
  // 5 V modules can run from it. Not on a battery bench: there VBUS is live only while USB is in.
  if (!controllerFed && !hasBattery) {
    for (const pin of mcu.record.pins) {
      if (pin.direction !== 'power_in' || !mcu.isWireable(pin.pin_id) || !/^(5V|VBUS|VUSB|USB|USB_5V)$/i.test(pin.pin_name.trim())) continue;
      if ((parseVolts(pin.voltage_domain) ?? 5) !== 5) continue;
      if (!controllerSources.some((s) => s.volts === 5)) controllerSources.push({ board: mcu, pin, volts: 5, key: mcuRailKey(5) });
    }
  }

  // 3. Chargers on a battery bench: BAT on the battery's own net, charged over the charger's input.
  const batterySource = supplyOutputs.find((s) => kindOf(s.board) === 'BATTERY') ?? null;
  const chargers = new Set<string>();
  for (const p of peripherals) {
    const board = boards.get(p.instanceId)!;
    if (supplyIds.has(p.instanceId) || !batterySource || !isCharger(board)) continue;
    const bat = board.record.pins.find((pin) => /^(BAT|BATT|VBAT|BAT\+|B\+|BATTERY)$/i.test(pin.pin_name.trim()) && board.isWireable(pin.pin_id));
    if (!bat) continue;
    chargers.add(p.instanceId);
    joinGround(board);
    const net = wireRail(batterySource, board, bat);
    peripheralRails.set(p.instanceId, null);
    const input = board.record.pins.find((pin) => pin.direction === 'power_in' && pin.pin_id !== bat.pin_id);
    results.push(
      result(
        'required_power_rail',
        'PASS',
        `${board.label} charges ${batterySource.board.label}: ${bat.pin_name} on ${net}${input ? `; charge it through ${input.pin_name} (${board.record.electrical.power_source_types.join(', ') || 'its input'})` : ''}.`,
        [p.instanceId, batterySource.board.instanceId],
        [bat.pin_id]
      )
    );
  }

  /** A motor or load driver: its supply is the bench's own input (motor current), not the logic rail. */
  const MOTOR_PAIRS: Array<[string, string]> = [
    ['OUT1', 'OUT2'], ['OUT3', 'OUT4'], ['AO1', 'AO2'], ['BO1', 'BO2'], ['AOUT1', 'AOUT2'], ['BOUT1', 'BOUT2'],
    ['MA+', 'MA-'], ['MB+', 'MB-'], ['M1A', 'M1B'], ['M2A', 'M2B'], ['M1+', 'M1-'], ['M2+', 'M2-'], ['MOTORA+', 'MOTORA-'], ['MOTORB+', 'MOTORB-'],
    ['1A', '1B'], ['2A', '2B'], ['A1', 'A2'], ['B1', 'B2'], ['OUTA', 'OUTB'], ['OUT+', 'OUT-'],
  ];
  /** Pairs whose names are also logic channels (a 74AHCT125's A1/A2): they count only on a board that is a motor driver. */
  const GENERIC_PAIRS = new Set(['1A', '2A', 'A1', 'B1', 'OUT+']);
  const MOTOR_DRIVER = /motor|h-?bridge|stepper|\bL29[38]|\bDRV8\d{3}|\bTB6612|\bA4988|\bULN2[08]0[34]|\bTMC2\d{3}/i;
  const squash = (name: string) => name.toUpperCase().replace(/[\s_]/g, '');
  const motorPairs = (b: Board): Array<[HardwarePin, HardwarePin]> => {
    if (isPlaceholderEntity(b.entity) || b === mcu || isShifter(b)) return [];
    const driver = MOTOR_DRIVER.test(`${b.label} ${b.record.identity.main_silicon ?? ''} ${b.record.identity.functional_categories.join(' ')}`);
    const byName = new Map(b.record.pins.filter((pin) => !isPowerPin(pin)).map((pin) => [squash(pin.pin_name), pin]));
    const pairs: Array<[HardwarePin, HardwarePin]> = [];
    for (const [a, z] of MOTOR_PAIRS) {
      if (GENERIC_PAIRS.has(a) && !driver) continue;
      const pa = byName.get(a);
      const pz = byName.get(z);
      if (pa && pz && b.isWireable(pa.pin_id) && b.isWireable(pz.pin_id)) pairs.push([pa, pz]);
    }
    return pairs;
  };
  const isDriver = (b: Board) => motorPairs(b).length > 0;


  /** Power for a placeholder: the controller's logic rail, or 12-24 V for a field-bus device; null when none fits. */
  const placeholderSupply = (board: Board): string | null => {
    const pin = board.record.pins.find((p) => p.direction === 'power_in' && board.isWireable(p.pin_id));
    if (!pin) return null;
    const all = [...supplyOutputs, ...controllerSources];
    const stated = parseVolts(board.label);
    const kind = kindOf(board);
    const source =
      stated !== null
        ? (all.find((s) => Math.abs(s.volts - stated) < 0.3 || (s.range !== undefined && stated >= s.range[0] && stated <= s.range[1])) ?? null)
        : kind === 'CAN' || kind === 'RS485'
          ? ([...all].filter((s) => s.volts >= 9).sort((a, b) => b.volts - a.volts)[0] ?? null)
          : pickSource(all, [mcuLogic - 0.2, mcuLogic + 0.2]);
    if (!source) return null;
    wireRail(source, board, pin);
    return sourceText(source);
  };

  // 4. Every other module: a fitting bench supply first, then a controller rail.
  for (const p of peripherals) {
    const board = boards.get(p.instanceId)!;
    if (supplyIds.has(p.instanceId) || chargers.has(p.instanceId)) continue;
    // A load switch takes its VIN from the load's supply below; here only its ground.
    if (loadSwitches.has(p.instanceId)) {
      joinGround(boards.get(p.instanceId)!);
      peripheralRails.set(p.instanceId, null);
      continue;
    }
    const kind = kindOf(board);
    // Motors and switched loads are wired to their driver or relay below.
    if (kind === 'MOTOR' || kind === 'STEPPER' || kind === 'LOAD') continue;
    // A placeholder has no known supply: its kind's usual rail, stated as an assumption in the
    // placeholder summary (the tester: "placeholders get ground only, with no power").
    if (isPlaceholderEntity(p.entity) && kind !== 'SERVO' && kind !== 'PIXELS') {
      joinGround(board);
      placeholderRails.set(p.instanceId, placeholderSupply(board));
      peripheralRails.set(p.instanceId, null);
      continue;
    }
    if (poweredByCable.has(p.instanceId)) {
      const volts = poweredByCable.get(p.instanceId) ?? null;
      peripheralRails.set(p.instanceId, volts);
      // The cable carries its host's rail: check it against what the module accepts (this used to
      // be skipped, so a cabled module's supply was never checked at all).
      const cp = cablePowerPin.get(p.instanceId);
      const range = cp ? inputRange(board, cp.pin) : null;
      if (!cp || volts === null || !range) {
        results.push(
          result(
            'required_power_rail',
            'UNKNOWN',
            `${board.label} is powered over its STEMMA QT / Qwiic cable, but its record does not say what supply it accepts, so the voltage cannot be checked.`,
            [p.instanceId],
            cp ? [cp.pin.pin_id] : []
          )
        );
      } else if (!fitsRange(volts, range)) {
        results.push(
          result(
            'required_power_rail',
            'BLOCKER',
            `${board.label} gets ${Number(volts.toFixed(2))} V over its STEMMA QT / Qwiic cable from ${cp.from}, but accepts ${rangeText(range)}.`,
            [p.instanceId],
            [cp.pin.pin_id],
            'Power it from a compatible supply instead of the cable.'
          )
        );
      } else {
        results.push(
          result(
            'required_power_rail',
            'PASS',
            `${board.label} powered over its STEMMA QT / Qwiic cable from ${cp.from} (${Number(volts.toFixed(2))} V; accepts ${rangeText(range)}).`,
            [p.instanceId],
            [cp.pin.pin_id]
          )
        );
      }
      continue;
    }
    // Other self-powered boards (no rated output in the record) keep their own supply: feeding
    // them from a rail would be wrong. Their status signals (if linked) still need a common ground.
    if (board.record.interfaces.host_requirement !== 'host_required' && !isDriver(board)) {
      if (p.links.length > 0) joinGround(board);
      results.push(
        result(
          'required_power_rail',
          'WARNING',
          `${board.label} has its own supply and is not powered from ${mcu.label}${p.links.length > 0 ? ' (only its signals and a common ground are wired)' : ''}. Connect its input and output as its documentation describes.`,
          [p.instanceId]
        )
      );
      peripheralRails.set(p.instanceId, null);
      continue;
    }

    const powerPins = board.record.pins.filter((pin) => pin.direction === 'power_in' && board.isWireable(pin.pin_id));
    const rank = (pin: HardwarePin) => {
      const i = POWER_PIN_PREFERENCE.indexOf(pin.pin_name.toUpperCase());
      return i === -1 ? POWER_PIN_PREFERENCE.length : i;
    };
    const powerPin = [...powerPins].sort((a, b) => rank(a) - rank(b))[0] ?? null;

    if (!joinGround(board)) {
      results.push(result('signal_direction_conflict', 'BLOCKER', `No wireable ground on ${groundOf(board) ? mcu.label : board.label}.`, [mcu.instanceId, p.instanceId]));
    }

    if (!powerPin) {
      const selfPowered = board.record.electrical.power_source_types.some((t) => /battery|external|barrel|own/i.test(t));
      results.push(
        result(
          'required_power_rail',
          selfPowered ? 'WARNING' : 'UNKNOWN',
          `${board.label} has no wireable power input in its record${selfPowered ? '; it lists its own supply' : ''}.`,
          [p.instanceId]
        )
      );
      peripheralRails.set(p.instanceId, null);
      continue;
    }
    require(p.instanceId, powerPin);

    // Supply range: the pin's own domain when numeric ("3V3"), else the record's rail for that pin, else its supply range.
    const range = inputRange(board, powerPin);

    if (!range) {
      // Unstructured supply: wire nothing on a guess. UNKNOWN is never reported as a pass.
      results.push(
        result(
          'required_power_rail',
          'UNKNOWN',
          `${board.label} supply voltage is not structured in its record, so its power rail cannot be checked.`,
          [p.instanceId],
          [powerPin.pin_id],
          'A reviewer needs to structure electrical.required_power_rails for this board.'
        )
      );
      peripheralRails.set(p.instanceId, null);
      continue;
    }

    // The rail closest to the controller's logic level wins, a bench supply before the controller's
    // own pin at the same voltage: a 3-5 V sensor on a 3.3 V controller runs from 3.3 V, so its
    // I/O matches the controller (the tester's 2026-10-15 report: sensors fed 5 V by the regulator
    // while the controller's 3.3 V rail sat unused). A motor driver takes the bench's own input
    // (motor current), else the highest rail it accepts.
    const all = [...supplyOutputs, ...controllerSources];
    const source = isDriver(board)
      ? ([...all].filter((s) => fits(s, range)).sort((a, b) => Number(Boolean(b.outside)) - Number(Boolean(a.outside)) || b.volts - a.volts)[0] ?? null)
      : pickSource(all, range);
    if (!source) {
      results.push(
        result(
          'required_power_rail',
          'BLOCKER',
          `${board.label} needs ${range[0].toFixed(1)}–${range[1].toFixed(1)} V; ${
            all.length > 0 ? `the bench provides ${all.map(sourceText).join(', ')}` : `${mcu.label} provides no wireable supply output`
          }.`,
          [mcu.instanceId, p.instanceId],
          [powerPin.pin_id],
          range[0] > 4 && all.every((s) => s.volts < range[0])
            ? `Add a ${range[0] <= 5 && range[1] >= 5 ? '5 V' : `${range[0]}–${range[1]} V`} supply for it, or choose a version of the module that runs from ${mcuLogic} V.`
            : 'Power it from a compatible supply or add a regulator.'
        )
      );
      peripheralRails.set(p.instanceId, null);
      continue;
    }
    wireRail(source, board, powerPin);
    peripheralRails.set(p.instanceId, source.volts);
    results.push(
      result(
        'required_power_rail',
        'PASS',
        `${board.label} ${powerPin.pin_name} (${range[0].toFixed(1)}–${range[1].toFixed(1)} V) on ${sourceText(source)}.`,
        [source.board.instanceId, p.instanceId],
        [powerPin.pin_id, source.pin.pin_id]
      )
    );
  }

  // --- motors and switched loads ------------------------------------------------------------------
  // Each motor lands on a free driver output pair; a pump, fan or valve is switched by a relay
  // (its supply on COM, NO to the load) or, failing that, by a free driver output.
  const freePairs: Array<{ board: Board; pins: [HardwarePin, HardwarePin] }> = peripherals
    .map((p) => boards.get(p.instanceId)!)
    .flatMap((b) => motorPairs(b).map((pins) => ({ board: b, pins })));
  const takePairs = (count: number): Array<{ board: Board; pins: [HardwarePin, HardwarePin] }> | null => {
    // A stepper needs both its coils on one driver.
    const byBoard = new Map<string, Array<{ board: Board; pins: [HardwarePin, HardwarePin] }>>();
    for (const f of freePairs) byBoard.set(f.board.instanceId, [...(byBoard.get(f.board.instanceId) ?? []), f]);
    const pick = [...byBoard.values()].find((list) => list.length >= count)?.slice(0, count) ?? null;
    if (pick) for (const f of pick) freePairs.splice(freePairs.indexOf(f), 1);
    return pick;
  };
  const wireLoadPair = (load: Board, loadPins: HardwarePin[], pair: { board: Board; pins: [HardwarePin, HardwarePin] }, netBase: string) => {
    pair.pins.forEach((dp, i) => {
      const name = `${netBase}_${i === 0 ? 'A' : 'B'}`;
      nets.add(name, 'load', claim(pair.board, dp, true));
      nets.add(name, 'load', claim(load, loadPins[i]!, true));
    });
    require(pair.board.instanceId, ...pair.pins);
  };
  const RELAY_COM = /^(COM|COM1|C)$/i;
  const RELAY_NO = /^(NO|NO1|N\.O\.)$/i;
  const usedRelays = new Set<string>();
  for (const p of peripherals) {
    const load = boards.get(p.instanceId)!;
    const kind = kindOf(load);
    if (kind === 'MOTOR' || kind === 'STEPPER') {
      const coils = kind === 'STEPPER' ? 2 : 1;
      const pairs = takePairs(coils);
      if (!pairs) {
        results.push(
          result('required_host_interface', 'WARNING', `${load.label} has no free motor-driver output on the bench.`, [p.instanceId], [], `Add a motor driver${coils === 2 ? ' for a stepper (two H-bridges)' : ''}, or a second one for more motors.`)
        );
        continue;
      }
      const terminals = load.record.pins.filter((pin) => pin.signal_class === 'other');
      pairs.forEach((pair, k) => wireLoadPair(load, terminals.slice(k * 2, k * 2 + 2), pair, `${p.instanceId.toUpperCase()}${coils === 2 ? (k === 0 ? '_COILA' : '_COILB') : ''}`));
      results.push(
        result(
          'required_power_rail',
          'PASS',
          `${load.label} on ${pairs[0]!.board.label} ${pairs.map((x) => `${x.pins[0].pin_name}/${x.pins[1].pin_name}`).join(' + ')}.`,
          [p.instanceId, pairs[0]!.board.instanceId]
        )
      );
      continue;
    }
    if (kind !== 'LOAD') continue;
    const plus = load.record.pins.find((pin) => pin.signal_class === 'other')!;
    // A relay (supply on COM, NO to the load) or a high-side load switch (supply on VIN, VOUT to the load).
    const switches = peripherals.map((x) => boards.get(x.instanceId)!).filter((b) => !usedRelays.has(b.instanceId) && !isPlaceholderEntity(b.entity));
    const relayBoard = switches.find((b) => b.record.pins.some((pin) => RELAY_COM.test(pin.pin_name.trim())) && b.record.pins.some((pin) => RELAY_NO.test(pin.pin_name.trim())));
    const switchBoard = relayBoard ? null : (switches.find((b) => loadSwitches.has(b.instanceId)) ?? null);
    const relay = relayBoard ?? switchBoard;
    if (relay) {
      usedRelays.add(relay.instanceId);
      const com = relayBoard ? relay.record.pins.find((pin) => RELAY_COM.test(pin.pin_name.trim()))! : switchPins(relay)!.vin;
      const no = relayBoard ? relay.record.pins.find((pin) => RELAY_NO.test(pin.pin_name.trim()))! : switchPins(relay)!.vout;
      const volts = parseVolts(load.label);
      const all = [...supplyOutputs, ...controllerSources];
      const supply =
        (volts !== null ? all.find((s) => Math.abs(s.volts - volts) < 0.3 || (s.range !== undefined && volts >= s.range[0] && volts <= s.range[1])) : null) ??
        (volts === null ? ([...supplyOutputs].filter((s) => s.outside).sort((a, b) => b.volts - a.volts)[0] ?? null) : null);
      const switched = `${p.instanceId.toUpperCase()}_SW`;
      nets.add(switched, 'load', claim(relay, no, true));
      nets.add(switched, 'load', claim(load, plus, true));
      require(relay.instanceId, no, com);
      joinGround(load);
      if (supply) {
        const rail = railNameOf(supply);
        nets.add(rail, 'power', claim(supply.board, supply.pin, false));
        nets.add(rail, 'power', claim(relay, com, true));
        results.push(
          result(
            'required_power_rail',
            'PASS',
            `${load.label} switched by ${relay.label}: ${rail} on ${com.pin_name}, ${no.pin_name} to the ${load.label.replace(/^\d+(?:\.\d+)? V /, '')} +, − to GND.`,
            [p.instanceId, relay.instanceId, supply.board.instanceId],
            [com.pin_id, no.pin_id]
          )
        );
      } else {
        results.push(
          result(
            'required_power_rail',
            'WARNING',
            `${load.label} is switched by ${relay.label}, but the bench has no ${volts !== null ? `${volts} V ` : ''}supply for it.`,
            [p.instanceId, relay.instanceId],
            [com.pin_id],
            `Connect a ${volts !== null ? `${volts} V ` : ''}supply to ${relay.label} ${com.pin_name}.`
          )
        );
      }
      continue;
    }
    const pairs = takePairs(1);
    if (pairs) {
      wireLoadPair(load, [plus, load.record.pins.find((pin) => pin.direction === 'ground')!], pairs[0]!, p.instanceId.toUpperCase());
      results.push(result('required_power_rail', 'PASS', `${load.label} driven by ${pairs[0]!.board.label} ${pairs[0]!.pins.map((x) => x.pin_name).join('/')}.`, [p.instanceId, pairs[0]!.board.instanceId]));
      continue;
    }
    results.push(
      result('required_host_interface', 'WARNING', `Nothing on the bench switches the ${load.label}.`, [p.instanceId], [], 'Add a relay or MOSFET module rated for it.')
    );
  }

  // --- I2C addresses ------------------------------------------------------------------------------
  // Every device on the shared bus gets its own address: the chip's datasheet addresses (reference
  // table), fixed-address devices first, and a device that has to move is strapped to its
  // alternate when its address pin is on the header.
  const i2cAddresses = new Map<string, I2cAssignment>();
  // A device on a mux channel has that channel to itself: its default address, no clash.
  for (const [id, n] of muxed) {
    if (!linked.get(id)?.has('I2C')) continue;
    const f = addressesFor(boards.get(id)!.entity.record);
    i2cAddresses.set(id, { address: f?.addresses[0] ?? null, chip: f?.chip ?? null, options: f?.addresses ?? [], moved: false, strap: null, clashWith: [], channel: { mux: muxBoard!.instanceId, n } });
  }
  const i2cDevices = peripherals.filter((p) => linked.get(p.instanceId)?.has('I2C') && !isPlaceholderEntity(p.entity) && !(muxed.has(p.instanceId) && i2cAddresses.has(p.instanceId)));
  const addressFacts = new Map(i2cDevices.map((p) => [p.instanceId, addressesFor(p.entity.record)]));
  const strapPinOf = (p: AllocInstance): HardwarePin | null => {
    const f = addressFacts.get(p.instanceId);
    const board = boards.get(p.instanceId)!;
    return f?.strap ? (board.record.pins.find((pin) => f.strap!.pin.test(pin.pin_name.trim()) && board.isHeaderWireable(pin.pin_id) && !nets.hasMember(p.instanceId, pin.pin_id)) ?? null) : null;
  };
  const order = [...i2cDevices].sort(
    (a, b) => (addressFacts.get(a.instanceId)?.addresses.length ?? 99) - (addressFacts.get(b.instanceId)?.addresses.length ?? 99) || Number(Boolean(strapPinOf(a))) - Number(Boolean(strapPinOf(b)))
  );
  const takenAddress = new Map<string, string>();
  for (const p of order) {
    const f = addressFacts.get(p.instanceId);
    if (!f) {
      i2cAddresses.set(p.instanceId, { address: null, chip: null, options: [], moved: false, strap: null, clashWith: [] });
      continue;
    }
    const choice = f.addresses.find((a) => !takenAddress.has(a));
    if (!choice) {
      i2cAddresses.set(p.instanceId, { address: f.addresses[0]!, chip: f.chip, options: f.addresses, moved: false, strap: null, clashWith: f.addresses.map((a) => takenAddress.get(a)!).filter(Boolean) });
      continue;
    }
    takenAddress.set(choice, p.instanceId);
    const moved = choice !== f.addresses[0];
    let strap: I2cAssignment['strap'] = null;
    const level = moved ? f.strap?.levels[choice] : undefined;
    if (moved && level) {
      const board = boards.get(p.instanceId)!;
      const pin = strapPinOf(p);
      let wired = false;
      if (pin && level === 'GND' && mcuGround) {
        nets.add('GND', 'ground', claim(mcu, mcuGround, false));
        nets.add('GND', 'ground', claim(board, pin, true));
        wired = true;
      } else if (pin && level === 'VCC') {
        const rail = nets.list().find((n) => n.class === 'power' && n.members.some((m) => m.instanceId === p.instanceId && board.pinsById.get(m.pinId)?.direction === 'power_in'));
        if (rail) {
          nets.add(rail.name, 'power', claim(board, pin, true));
          wired = true;
        }
      }
      if (wired && pin) require(p.instanceId, pin);
      strap = { pin: pin?.pin_name ?? null, level, wired };
    }
    i2cAddresses.set(p.instanceId, { address: choice, chip: f.chip, options: f.addresses, moved, strap, clashWith: [] });
  }

  // --- jumper wires: every member of a net runs to the net's hub ----------------------------------
  // The hub is the rail's source on a power net (the regulator output, or the controller's own
  // rail), otherwise the controller's pin. A net with neither (a supply feeding a supply) still
  // gets its wires: every net in the graph is drawn, nothing is implied by proximity.
  const boardOf = (instanceId: string): Board | undefined => (instanceId === mcu.instanceId ? mcu : boards.get(instanceId));
  const directionOf = (m: NetMember) => boardOf(m.instanceId)?.pinsById.get(m.pinId)?.direction;
  const wires: AllocatedConnection[] = [];
  for (const net of nets.list()) {
    const hub =
      (net.class === 'power'
        ? (net.members.find((m) => m.instanceId === mcu.instanceId && directionOf(m) === 'power_out') ?? net.members.find((m) => directionOf(m) === 'power_out'))
        : undefined) ??
      net.members.find((m) => m.instanceId === mcu.instanceId) ??
      net.members[0];
    if (!hub) continue;
    const hubBoard = boardOf(hub.instanceId)!;
    for (const member of net.members) {
      if (member === hub || cabled.has(`${member.instanceId}|${member.pinId}`)) continue;
      if (member.instanceId === mcu.instanceId && hub.instanceId === mcu.instanceId) continue;
      if (!member.anchorId) continue;
      if (!hub.anchorId) {
        // The hub pin is only on its cable connector but this module needs a jumper.
        const hubPin = hubBoard.pinsById.get(hub.pinId);
        const ref = hubPin ? hubBoard.pickContact(hubPin.pin_id, new Set()) : null;
        if (!ref) {
          results.push(result('connector_family_compatibility', 'WARNING', `${hubBoard.label} ${hub.pinName} is only on a cable connector; a jumper cannot reach it.`, [hub.instanceId, member.instanceId], [hub.pinId]));
          continue;
        }
        hub.contactId = ref.contact.contact_id;
        hub.anchorId = ref.anchorId;
      }
      wires.push({
        id: `w${wires.length + 1}`,
        kind: 'wire',
        cableType: null,
        netIds: [net.netId],
        from: { instanceId: member.instanceId, anchorId: member.anchorId, contactId: member.contactId, connectorId: null },
        to: { instanceId: hub.instanceId, anchorId: hub.anchorId!, contactId: hub.contactId, connectorId: null },
      });
    }
  }

  // Jumpers that land on a STEMMA QT / Qwiic socket need a socket-to-header cable.
  for (const board of [mcu, ...boards.values()]) {
    const viaAdapter = nets
      .list()
      .flatMap((n) => n.members)
      .filter((m) => m.instanceId === board.instanceId && !cabled.has(`${m.instanceId}|${m.pinId}`))
      .filter((m) => board.contactsOf(m.pinId).some((c) => c.viaAdapter && c.contact.contact_id === m.contactId));
    if (viaAdapter.length > 0) {
      results.push(
        result(
          'connector_family_compatibility',
          'WARNING',
          `${board.label} ${viaAdapter.map((m) => m.pinName).join('/')} ${viaAdapter.length === 1 ? 'is' : 'are'} only on its STEMMA QT / Qwiic socket.`,
          [board.instanceId],
          viaAdapter.map((m) => m.pinId),
          'Use a STEMMA QT / Qwiic to male-header jumper cable (e.g. Adafruit 4209 or SparkFun PRT-14425): black GND, red V+, blue SDA, yellow SCL.'
        )
      );
    }
  }

  return {
    nets: nets.list(),
    connections: [...cables, ...wires],
    results,
    peripheralRails,
    linked,
    requiredPins,
    i2cAddresses,
    placeholderRails,
  };
}
