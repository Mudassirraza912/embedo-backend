import { HardwareConnector, HardwareContact, HardwarePin, wholeConnectorAnchorId } from '../../hardware/hardware.schema.js';
import { LibraryEntity } from '../../hardware/hardware-library.service.js';

/**
 * Read-only view of one placed board for the allocator: pins, the contacts that expose them, and
 * which of those contacts can actually take a wire (an anchor that exists in the artwork).
 */

export interface ContactRef {
  contact: HardwareContact;
  connector: HardwareConnector;
  anchorId: string | null;
  /** Reached through a STEMMA QT / Qwiic to male-header cable on a whole connector. */
  viaAdapter?: boolean;
}

/** Function tokens are instance-qualified in the library (I2C1_SDA, SPI0_RX, UART1_TX, PWM5_A, ADC0). */
const FUNCTION_TOKEN = /^(I2C|SPI|UART|PWM|ADC|CAN|I2S)(\d+)?(?:_([A-Z0-9]+))?$/;

export interface ParsedFunction {
  family: string;
  instance: number | null;
  role: string | null;
}

export function parseFunction(token: string): ParsedFunction | null {
  const match = FUNCTION_TOKEN.exec(token.trim().toUpperCase());
  if (!match) return null;
  return { family: match[1]!, instance: match[2] !== undefined ? Number(match[2]) : null, role: match[3] ?? null };
}

/**
 * Pins the allocator must never hand out for a signal: boot/strapping, native USB, debug, flash,
 * and the board's own power/reset pins. v3.3 has no controlled strapping flag yet (plan open
 * question 2), so this reads the function tokens and pin names conservatively.
 */
const RESERVED_FUNCTION = /BOOT|STRAP|USB|SWD|SWCLK|SWDIO|SWO|JTAG|TCK|TMS|TDI|TDO|FLASH|PSRAM|XTAL|NRST|RESET/i;
const RESERVED_NAME = /^(RUN|RST|NRST|RESET|EN|CHIP_PU|BOOT\d*|3V3_EN|ADC_VREF|AREF|IOREF|AGND|VBAT|VBUS|VSYS|VIN|VCC|VDD|VUSB|3V3|3\.3V|5V|GND)$/i;

export function isReservedForSignal(pin: HardwarePin): boolean {
  if (pin.signal_class === 'power' || pin.signal_class === 'ground' || pin.signal_class === 'debug' || pin.signal_class === 'control') return true;
  if (pin.direction === 'power_in' || pin.direction === 'power_out' || pin.direction === 'ground') return true;
  if (RESERVED_NAME.test(pin.pin_name.replace(/\(.*\)$/, '').trim())) return true;
  return pin.functions.some((f) => RESERVED_FUNCTION.test(f));
}

/** Volts from a pin name or voltage domain: "3V3", "3.3V", "5V", "VBUS". Null when not numeric. */
export function parseVolts(text: string | null | undefined): number | null {
  if (!text) return null;
  const t = text.toUpperCase();
  if (/\b(VBUS|VUSB|USB)\b/.test(t)) return 5;
  const split = /(\d+)V(\d+)/.exec(t);
  if (split) return Number(`${split[1]}.${split[2]}`);
  const plain = /(\d+(?:\.\d+)?)\s*V\b/.exec(t);
  return plain ? Number(plain[1]) : null;
}

export const isStemmaConnector = (connector: HardwareConnector): boolean => /stemma|qwiic/i.test(connector.connector_type);

export class Board {
  readonly pinsById: Map<string, HardwarePin>;
  private readonly contactsByPin = new Map<string, ContactRef[]>();

  constructor(
    readonly instanceId: string,
    readonly entity: LibraryEntity
  ) {
    this.pinsById = new Map(entity.record.pins.map((p) => [p.pin_id, p]));
    for (const connector of entity.record.connectors) {
      // A whole connector (STEMMA QT / Qwiic) can still reach jumper wires through a socket-to-
      // male-header cable; those contacts land on the connector's whole anchor.
      const adapterAnchor = connector.connection_mode === 'whole_connector' && isStemmaConnector(connector) ? this.wholeAnchorOf(connector) : null;
      for (const contact of connector.contacts) {
        const direct =
          connector.connection_mode !== 'whole_connector' && contact.svg_anchor_id && this.hasAnchor(contact.svg_anchor_id)
            ? contact.svg_anchor_id
            : null;
        const list = this.contactsByPin.get(contact.pin_id) ?? [];
        list.push(direct ? { contact, connector, anchorId: direct } : { contact, connector, anchorId: adapterAnchor, viaAdapter: adapterAnchor !== null });
        this.contactsByPin.set(contact.pin_id, list);
      }
    }
  }

  get record() {
    return this.entity.record;
  }

  get label(): string {
    return this.record.identity.product_name;
  }

  hasAnchor(anchorId: string): boolean {
    return this.entity.svg?.parsed.anchors.has(anchorId) ?? false;
  }

  pinsByName(name: string): HardwarePin[] {
    const wanted = name.trim().toUpperCase();
    return this.record.pins.filter((p) => p.pin_name.toUpperCase() === wanted);
  }

  contactsOf(pinId: string): ContactRef[] {
    return this.contactsByPin.get(pinId) ?? [];
  }

  /** Contacts of a pin that a jumper wire can land on, in record order. */
  wireableContacts(pinId: string): ContactRef[] {
    return this.contactsOf(pinId).filter((c) => c.anchorId !== null);
  }

  isWireable(pinId: string): boolean {
    return this.wireableContacts(pinId).length > 0;
  }

  /** On a header contact a jumper reaches directly (no adapter cable). */
  isHeaderWireable(pinId: string): boolean {
    return this.wireableContacts(pinId).some((c) => !c.viaAdapter);
  }

  /**
   * One wireable contact for a pin. Prefers a connector already in use on this board (keeps a
   * module's wires on one header), then a contact not yet taken, then record order.
   */
  pickContact(pinId: string, usedContacts: Set<string>, preferConnectors: Set<string> = new Set()): ContactRef | null {
    const candidates = this.wireableContacts(pinId);
    if (candidates.length === 0) return null;
    // Header contacts first; an adapter cable only when the pin has no header contact at all.
    const score = (c: ContactRef) =>
      (c.viaAdapter ? 4 : 0) + (preferConnectors.has(c.connector.connector_id) ? 0 : 2) + (usedContacts.has(c.contact.contact_id) ? 1 : 0);
    return [...candidates].sort((a, b) => score(a) - score(b))[0]!;
  }

  /** Whole-connector anchor of a connector: from the record, else the SVG's embedo-anchor-whole. */
  wholeAnchorOf(connector: HardwareConnector): string | null {
    const fromRecord = wholeConnectorAnchorId(connector);
    if (fromRecord && this.hasAnchor(fromRecord)) return fromRecord;
    for (const anchor of this.entity.svg?.parsed.anchors.values() ?? []) {
      if (anchor.whole && anchor.connectorId === connector.connector_id) return anchor.id;
    }
    return null;
  }

  /** STEMMA QT / Qwiic connectors that can take a cable (have a whole-connector anchor). */
  cablePorts(): Array<{ connector: HardwareConnector; anchorId: string }> {
    return this.record.connectors
      .filter((c) => c.connection_mode !== 'individual_contacts' && isStemmaConnector(c))
      .map((connector) => ({ connector, anchorId: this.wholeAnchorOf(connector) }))
      .filter((p): p is { connector: HardwareConnector; anchorId: string } => p.anchorId !== null);
  }

  functionsOf(pin: HardwarePin): ParsedFunction[] {
    return pin.functions.map(parseFunction).filter((f): f is ParsedFunction => f !== null);
  }

  /** Board logic level: the most common numeric voltage domain on its data pins, else 3.3 V. */
  logicVolts(): number {
    const counts = new Map<number, number>();
    for (const pin of this.record.pins) {
      if (pin.signal_class !== 'data' && pin.signal_class !== 'analog') continue;
      const v = parseVolts(pin.voltage_domain);
      if (v !== null) counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? best[0] : 3.3;
  }

  /** Interface detail pin ids for an interface type (I2C, SPI, UART), from the record. */
  interfaceDetails(type: string): Array<Record<string, unknown>> {
    const wanted = type.toUpperCase();
    return this.record.interfaces.interfaces
      .filter((i) => i.type.toUpperCase() === wanted)
      .map((i) => i.details as Record<string, unknown>);
  }

  pinFromDetail(details: Record<string, unknown>, key: string): HardwarePin | null {
    const id = details[key];
    return typeof id === 'string' ? (this.pinsById.get(id) ?? null) : null;
  }
}
