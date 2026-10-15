import { HardwarePin } from '../../hardware/hardware.schema.js';
import { LibraryEntity } from '../../hardware/hardware-library.service.js';
import { Board, ContactRef, isReservedForSignal, parseVolts } from './prototype-board.js';
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
  const freeSignalPin = (predicate: (pin: HardwarePin) => boolean): HardwarePin | null =>
    mcu.record.pins.find(
      (pin) => !usedMcuSignalPins.has(pin.pin_id) && !isReservedForSignal(pin) && mcu.isHeaderWireable(pin.pin_id) && predicate(pin)
    ) ?? null;

  const hasFunction = (pin: HardwarePin, family: string, roles?: string[], instance?: number | null) =>
    mcu.functionsOf(pin).some(
      (f) => f.family === family && (roles === undefined || (f.role !== null && roles.includes(f.role))) && (instance === undefined || f.instance === instance)
    );

  const isGpioCapable = (pin: HardwarePin) =>
    pin.signal_class === 'data' || pin.signal_class === 'analog' || pin.functions.some((f) => /^GPIO/i.test(f));

  /** Lowest-numbered bus instance whose role pins are all free; instance number keeps a bus on one peripheral block. */
  const pickBus = (family: 'I2C' | 'SPI' | 'UART', roles: Record<string, string[]>, optionalRoles: string[] = []) => {
    const instances = new Set<number | null>();
    for (const pin of mcu.record.pins) for (const f of mcu.functionsOf(pin)) if (f.family === family) instances.add(f.instance);
    const ordered = [...instances].sort((a, b) => (a ?? -1) - (b ?? -1));
    for (const instance of ordered) {
      const chosen: Record<string, HardwarePin> = {};
      const taken = new Set<string>();
      let complete = true;
      for (const [role, aliases] of Object.entries(roles)) {
        const pin = freeSignalPin((p) => !taken.has(p.pin_id) && hasFunction(p, family, aliases, instance));
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

      for (const p of i2cPeripherals) {
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

  // --- UART: point to point, one controller UART per device, TX crossed to RX -------------------
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
    // The board's labelled UART (record details) first, then any free TX/RX-capable pair.
    let bus: { instance: number | null; pins: Record<string, HardwarePin> } | null = null;
    for (const details of mcu.interfaceDetails('UART')) {
      const tx = mcu.pinFromDetail(details, 'tx_pin_id');
      const rx = mcu.pinFromDetail(details, 'rx_pin_id');
      if (tx && rx && !usedMcuSignalPins.has(tx.pin_id) && !usedMcuSignalPins.has(rx.pin_id) && mcu.isWireable(tx.pin_id) && mcu.isWireable(rx.pin_id)) {
        bus = { instance: mcu.functionsOf(tx).find((f) => f.family === 'UART')?.instance ?? null, pins: { tx, rx } };
        break;
      }
    }
    bus ??= pickBus('UART', { tx: ['TX'], rx: ['RX'] });
    if (!bus) {
      const named = (names: string[]) => names.flatMap((n) => mcu.pinsByName(n)).find((p) => !usedMcuSignalPins.has(p.pin_id) && mcu.isWireable(p.pin_id)) ?? null;
      const tx = named(['TX', 'TXD', 'TX0']);
      const rx = named(['RX', 'RXD', 'RX0']);
      if (tx && rx) bus = { instance: null, pins: { tx, rx } };
    }
    if (!bus) {
      results.push(
        result('required_host_interface', 'BLOCKER', `${mcu.label} has no free UART for ${board.label}.`, [mcu.instanceId, p.instanceId], [pTx.pin_id, pRx.pin_id], 'Use a controller with another UART, or move a module to I2C.')
      );
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
          : null) ?? freeSignalPin(isGpioCapable);
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

  // --- GPIO / ANALOG / PWM: the module pin the resolver named, a capable free controller pin ------
  for (const p of peripherals) {
    const board = boards.get(p.instanceId)!;
    for (const link of p.links) {
      if (link.interface !== 'GPIO' && link.interface !== 'ANALOG' && link.interface !== 'PWM') continue;
      const pPin = link.pinName ? board.pinsByName(link.pinName)[0] : undefined;
      if (!pPin) continue; // validated upstream; a stale composition just skips the line
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
      const mPin = freeSignalPin(capable);
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
  const mcuRails = mcu.record.pins
    .filter((pin) => pin.direction === 'power_out' && mcu.isWireable(pin.pin_id))
    // The declared domain first: a pin named "3V" (QT Py) is a 3.3 V rail, which its name alone misreads as 3.0 V.
    .map((pin) => ({ pin, volts: parseVolts(pin.voltage_domain) ?? parseVolts(pin.pin_name) }))
    .filter((r): r is { pin: HardwarePin; volts: number } => r.volts !== null && (r.volts === 3.3 || r.volts === 5));
  const mcuLogic = mcu.logicVolts();
  const peripheralRails = new Map<string, number | null>();

  interface RailSource {
    board: Board;
    pin: HardwarePin;
    volts: number;
    key: string;
  }
  const controllerSources: RailSource[] = mcuRails.map((r) => ({ board: mcu, pin: r.pin, volts: r.volts, key: mcuRailKey(r.volts) }));
  const supplies = peripherals
    .map((p) => boards.get(p.instanceId)!)
    .filter((b) => b.record.interfaces.host_requirement !== 'host_required' && !poweredByCable.has(b.instanceId))
    .map((b) => ({
      board: b,
      inputs: b.record.pins.filter((pin) => pin.direction === 'power_in' && b.isWireable(pin.pin_id)),
      outputs: b.record.pins
        .filter((pin) => pin.direction === 'power_out' && b.isWireable(pin.pin_id))
        .map((pin) => ({ board: b, pin, volts: parseVolts(pin.voltage_domain) ?? parseVolts(pin.pin_name), key: `${b.instanceId}:${pin.pin_id}` }))
        .filter((o): o is RailSource => o.volts !== null && o.volts > 0),
    }))
    .filter((s) => s.outputs.length > 0);
  const supplyIds = new Set(supplies.map((s) => s.board.instanceId));

  /** Joins a source pin and a consumer pin on the source's own rail net. */
  const wireRail = (source: RailSource, consumer: Board, pin: HardwarePin) => {
    const name = railNetName(source.volts, source.key, source.board.instanceId);
    nets.add(name, 'power', claim(source.board, source.pin, false));
    nets.add(name, 'power', claim(consumer, pin, false));
    if (consumer !== mcu) require(consumer.instanceId, pin);
    if (source.board !== mcu) require(source.board.instanceId, source.pin);
  };
  /** The fitting source closest to the controller's logic level (3.3 V logic prefers a 3.3 V rail). */
  const pickSource = (sources: RailSource[], range: [number, number]): RailSource | null =>
    sources.filter((s) => fitsRange(s.volts, range)).sort((a, b) => Math.abs(a.volts - mcuLogic) - Math.abs(b.volts - mcuLogic))[0] ?? null;
  const sourceText = (s: RailSource) => `${s.board.label} ${s.pin.pin_name} (${Number(s.volts.toFixed(2))} V)`;

  // 1. The supply chain: each supply takes its input from another supply's output (never in a
  //    loop); one that nothing on the bench can feed is a primary source with an outside input.
  const fedBy = new Map<string, string>();
  const isUpstream = (candidate: string, of: string): boolean => {
    for (let id: string | undefined = fedBy.get(of), hops = 0; id && hops < 32; id = fedBy.get(id), hops++) if (id === candidate) return true;
    return false;
  };
  for (const s of supplies) {
    let chosen: { input: HardwarePin; source: RailSource; range: [number, number] } | null = null;
    for (const input of s.inputs) {
      const range = inputRange(s.board, input);
      if (!range) continue;
      const feeders = supplies.filter((o) => o !== s && !isUpstream(s.board.instanceId, o.board.instanceId)).flatMap((o) => o.outputs);
      const source = pickSource(feeders, range);
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
    } else {
      const accepted = s.inputs
        .map((pin) => {
          const range = inputRange(s.board, pin);
          return `${pin.pin_name}${range ? ` (${rangeText(range)})` : ''}`;
        })
        .join(' or ');
      const listed = s.board.record.electrical.power_source_types;
      peripheralRails.set(s.board.instanceId, null);
      results.push(
        result(
          'required_power_rail',
          'WARNING',
          `${s.board.label} is the bench's power source: nothing on the bench feeds it, so connect ${accepted || 'its input'} from outside${listed.length > 0 ? ` (its record lists: ${listed.join(', ')})` : ''}.`,
          [s.board.instanceId],
          s.inputs.map((pin) => pin.pin_id)
        )
      );
    }
  }
  const supplyOutputs = supplies.flatMap((s) => s.outputs);

  // 2. The controller runs from a bench supply when one fits its power input.
  if (supplyOutputs.length > 0) {
    const rank = (pin: HardwarePin) => {
      const i = POWER_PIN_PREFERENCE.indexOf(pin.pin_name.toUpperCase());
      return i === -1 ? POWER_PIN_PREFERENCE.length : i;
    };
    const mcuInputs = mcu.record.pins.filter((pin) => pin.direction === 'power_in' && mcu.isWireable(pin.pin_id)).sort((a, b) => rank(a) - rank(b));
    let powered = false;
    for (const input of mcuInputs) {
      const range = inputRange(mcu, input);
      const source = range ? pickSource(supplyOutputs, range) : null;
      if (!range || !source) continue;
      wireRail(source, mcu, input);
      results.push(
        result('required_power_rail', 'PASS', `${mcu.label} ${input.pin_name} (${rangeText(range)}) on ${sourceText(source)}.`, [mcu.instanceId, source.board.instanceId], [input.pin_id, source.pin.pin_id])
      );
      powered = true;
      break;
    }
    if (!powered) {
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

  // 3. Every other module: a fitting bench supply first, then a controller rail.
  for (const p of peripherals) {
    const board = boards.get(p.instanceId)!;
    if (supplyIds.has(p.instanceId)) continue;
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
    if (board.record.interfaces.host_requirement !== 'host_required') {
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

    // Supply range: the pin's own domain when numeric ("3V3"), else the record's supply range.
    const pinVolts = parseVolts(powerPin.voltage_domain) ?? parseVolts(powerPin.pin_name);
    const { supply_voltage_min_v: min, supply_voltage_max_v: max } = board.record.electrical;
    const range: [number, number] | null =
      pinVolts !== null ? [pinVolts - 0.2, pinVolts + 0.2] : min != null && max != null ? [min, max] : null;

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

    const source = pickSource(supplyOutputs, range) ?? pickSource(controllerSources, range);
    if (!source) {
      const offered = [...supplyOutputs, ...controllerSources];
      results.push(
        result(
          'required_power_rail',
          'BLOCKER',
          `${board.label} needs ${range[0].toFixed(1)}–${range[1].toFixed(1)} V; ${
            offered.length > 0 ? `the bench provides ${offered.map(sourceText).join(', ')}` : `${mcu.label} provides no wireable supply output`
          }.`,
          [mcu.instanceId, p.instanceId],
          [powerPin.pin_id],
          'Power it from a compatible supply or add a regulator.'
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
        `${board.label} ${powerPin.pin_name} (${range[0].toFixed(1)}–${range[1].toFixed(1)} V) on ${source.board.label} ${source.pin.pin_name}.`,
        [source.board.instanceId, p.instanceId],
        [powerPin.pin_id, source.pin.pin_id]
      )
    );
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
  };
}
