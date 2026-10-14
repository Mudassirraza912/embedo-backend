import { HardwareConnector, HardwarePin } from '../../hardware/hardware.schema.js';
import { isStemmaConnector } from './prototype-board.js';
import {
  CompatibilityResult,
  ConnectionState,
  PinList,
  PinListRow,
  PinRowStatus,
  PrototypeConnection,
  PrototypeInstance,
  PrototypeNet,
} from './prototype.types.js';
import { LibraryEntity } from '../../hardware/hardware-library.service.js';

/**
 * The detailed pin list (plan D5 step 7): one row per wireable contact of every placed module.
 * Unused contacts are listed too — "shown, not omitted" — so the engineer sees every pad on the
 * board and which ones carry the design.
 */

export interface PinListInput {
  instances: PrototypeInstance[];
  entities: Map<string, LibraryEntity>;
  nets: PrototypeNet[];
  connections: PrototypeConnection[];
  results: CompatibilityResult[];
  requiredPins: Map<string, Set<string>>;
}

const STATE_RANK: Record<ConnectionState, number> = { drawn: 0, proposed: 1, blocked: 2 };

const shortId = (id: string) => id.split(':').slice(1).join(':') || id;

function contactLabel(connector: HardwareConnector, contactId: string): string {
  const ref = shortId(connector.connector_id);
  const pad = contactId.split(':').pop() ?? contactId;
  return connector.connection_mode === 'whole_connector'
    ? `${ref}:${pad} (${isStemmaConnector(connector) ? 'STEMMA QT' : 'connector'})`
    : `${ref}:${pad}`;
}

function functionLabel(pin: HardwarePin, net: PrototypeNet | null): string {
  if (net) {
    const suffix = net.name.split('_').pop() ?? '';
    switch (net.class) {
      case 'power':
        return 'POWER';
      case 'ground':
        return 'GROUND';
      case 'i2c':
        return `I2C ${suffix}`;
      case 'spi':
        return `SPI ${suffix}`;
      case 'uart':
        // Name the pin's own role: the net is named from the controller's side.
        return /TX/i.test(pin.pin_name) || pin.functions.some((f) => /_TX$/i.test(f)) ? 'UART TX' : 'UART RX';
      case 'analog':
        return 'ANALOG';
      case 'pwm':
        return 'PWM';
      default:
        return 'GPIO';
    }
  }
  if (pin.direction === 'power_in' || pin.direction === 'power_out' || pin.signal_class === 'power') return 'POWER';
  if (pin.direction === 'ground' || pin.signal_class === 'ground') return 'GROUND';
  if (pin.signal_class === 'analog') return 'ANALOG';
  if (pin.signal_class === 'control') return 'CONTROL';
  if (pin.signal_class === 'debug') return 'DEBUG';
  if (pin.signal_class === 'data') return 'GPIO';
  return 'OTHER';
}

export function buildPinList(input: PinListInput): PinList {
  const controller = input.instances.find((i) => i.isController) ?? null;
  const memberIndex = new Map<string, { net: PrototypeNet; contactId: string | null }>();
  for (const net of input.nets) {
    for (const m of net.members) memberIndex.set(`${m.instanceId}|${m.pinId}`, { net, contactId: m.contactId });
  }

  // Contact- and connector-level connection states (a controller contact can feed several wires).
  const contactState = new Map<string, ConnectionState>();
  const cableEnds = new Map<string, { state: ConnectionState; peer: string }>();
  const worse = (a: ConnectionState | undefined, b: ConnectionState) => (a === undefined || STATE_RANK[b] > STATE_RANK[a] ? b : a);
  const labelOf = (instanceId: string) => input.instances.find((i) => i.instanceId === instanceId)?.label ?? instanceId;
  for (const c of input.connections) {
    if (c.kind === 'cable') {
      for (const [end, other] of [
        [c.from, c.to],
        [c.to, c.from],
      ] as const) {
        if (end.connectorId) {
          cableEnds.set(`${end.instanceId}|${end.connectorId}`, {
            state: c.state,
            peer: `${labelOf(other.instanceId)} ${shortId(other.connectorId ?? '')}`.trim(),
          });
        }
      }
    } else {
      for (const end of [c.from, c.to]) {
        if (end.contactId) {
          const key = `${end.instanceId}|${end.contactId}`;
          contactState.set(key, worse(contactState.get(key), c.state));
        }
      }
    }
  }

  const rulesFor = (pinId: string) => input.results.filter((r) => r.pinIds.includes(pinId) && r.status !== 'PASS');
  const rows: PinListRow[] = [];

  for (const instance of input.instances) {
    const entity = input.entities.get(instance.hardwareEntityId);
    if (!entity) continue;
    const pins = new Map(entity.record.pins.map((p) => [p.pin_id, p]));
    const required = input.requiredPins.get(instance.instanceId) ?? new Set<string>();
    const isController = instance.instanceId === controller?.instanceId;
    // Pins that reached their net through some contact: a second contact of the same pin is spare.
    const assignedPins = new Set<string>();

    const pending: Array<{ row: PinListRow; pin: HardwarePin; assigned: boolean }> = [];
    for (const connector of entity.record.connectors) {
      const cable = cableEnds.get(`${instance.instanceId}|${connector.connector_id}`);
      for (const contact of connector.contacts) {
        const pin = pins.get(contact.pin_id);
        if (!pin) continue;
        const membership = memberIndex.get(`${instance.instanceId}|${pin.pin_id}`) ?? null;
        const net = membership?.net ?? null;
        const viaThisContact = Boolean(membership && membership.contactId === contact.contact_id);
        const viaCable = Boolean(net && cable);
        const assigned = viaThisContact || viaCable;
        if (assigned) assignedPins.add(pin.pin_id);

        let boardPin: string | null = null;
        if (net && assigned) {
          if (viaCable) boardPin = `via STEMMA QT cable → ${cable!.peer}`;
          else if (isController) boardPin = net.name;
          else {
            const hub = net.members.filter((m) => m.instanceId === controller?.instanceId).map((m) => m.pinName);
            boardPin = hub.length > 0 ? hub.join(', ') : net.name;
          }
        }

        const state = viaCable ? cable!.state : contactState.get(`${instance.instanceId}|${contact.contact_id}`);
        let status: PinRowStatus;
        let note: string | null = null;
        if (assigned) {
          const rules = rulesFor(pin.pin_id);
          if (rules.some((r) => r.status === 'BLOCKER')) status = 'conflict';
          else if (rules.some((r) => r.status === 'UNKNOWN')) status = 'unknown';
          else if (rules.some((r) => r.status === 'WARNING')) status = 'warning';
          else if (state === 'blocked') status = 'conflict';
          // Library review status is internal: a connected pin with no failing check is assigned.
          else status = 'assigned';
          const firstRule = rules[0];
          if (firstRule) note = firstRule.suggestedFix ? `${firstRule.message} ${firstRule.suggestedFix}` : firstRule.message;
        } else {
          status = 'optional'; // settled below once every contact of the pin has been seen
        }

        pending.push({
          pin,
          assigned,
          row: {
            instanceId: instance.instanceId,
            component: instance.label,
            hardwareEntityId: instance.hardwareEntityId,
            pinId: pin.pin_id,
            pin: pin.pin_name,
            contactId: contact.contact_id,
            contact: contactLabel(connector, contact.contact_id),
            boardPin,
            netId: assigned ? (net?.netId ?? null) : null,
            net: assigned ? (net?.name ?? null) : null,
            function: functionLabel(pin, assigned ? net : null),
            functions: pin.functions,
            direction: pin.direction,
            level: pin.voltage_domain ?? null,
            status,
            note,
          },
        });
      }
    }

    for (const { row, pin, assigned } of pending) {
      if (assigned) continue;
      if (assignedPins.has(pin.pin_id)) {
        row.note = 'same pin is connected on another contact';
      } else if (!isController && required.has(pin.pin_id)) {
        row.status = 'blocking';
        row.note = 'required by the design but not connected';
      }
      if (/relay|contact|^NO$|^NC$|^COM$/i.test(pin.pin_name) && pin.signal_class === 'other') {
        row.note = row.note ?? 'switched load side — not wired to the controller';
      }
    }
    rows.push(...pending.map((p) => p.row));
  }

  const summary = { rows: rows.length, assigned: 0, proposed: 0, blocking: 0, conflict: 0, warning: 0, unknown: 0, optional: 0 };
  for (const row of rows) summary[row.status] += 1;
  return { summary, rows };
}
