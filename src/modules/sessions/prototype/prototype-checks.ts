import { HardwarePin } from '../../hardware/hardware.schema.js';
import { Board, parseVolts } from './prototype-board.js';
import { AllocationResult, AllocInstance } from './prototype-allocator.js';
import { CompatibilityResult, RuleStatus } from './prototype.types.js';

/**
 * Composition-wide rules that need the finished net list (truth file §10, plan D5 step 5).
 * The allocator already reports what it could not do (no bus, no rail); these read what it did.
 * UNKNOWN is a first-class outcome: a fact missing from a record is never treated as a pass.
 */

const LEVEL_SHIFTED = /level.?shift|3\s*-\s*5\s*v|3\.3\s*-\s*5|5\s*v\s*tolerant/i;
const SIGNAL_CLASSES = new Set(['i2c', 'spi', 'uart', 'gpio', 'analog', 'pwm']);

const make = (
  ruleType: string,
  status: RuleStatus,
  message: string,
  instanceIds: string[],
  pinIds: string[] = [],
  suggestedFix: string | null = null
): CompatibilityResult => ({ ruleType, status, message, suggestedFix, instanceIds, pinIds });

const accessoryName = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null
      ? String((value as Record<string, unknown>)['name'] ?? (value as Record<string, unknown>)['accessory'] ?? JSON.stringify(value))
      : String(value);

export function evaluateCompatibility(controller: AllocInstance, peripherals: AllocInstance[], allocation: AllocationResult): CompatibilityResult[] {
  const out: CompatibilityResult[] = [];
  const mcu = new Board(controller.instanceId, controller.entity);
  const boards = new Map<string, Board>([[mcu.instanceId, mcu], ...peripherals.map((p) => [p.instanceId, new Board(p.instanceId, p.entity)] as const)]);
  const pinOf = (instanceId: string, pinId: string): HardwarePin | undefined => boards.get(instanceId)?.pinsById.get(pinId);

  // bus_address_conflict — every I2C device on the shared bus needs its own address.
  const onBus = peripherals.filter((p) => allocation.linked.get(p.instanceId)?.has('I2C'));
  if (onBus.length > 0) {
    const byAddress = new Map<string, Array<{ p: AllocInstance; alternates: string[]; altNote: string | null }>>();
    const unknown: AllocInstance[] = [];
    for (const p of onBus) {
      const iface = p.entity.record.interfaces.interfaces.find((i) => /I2C|STEMMA|QWIIC/i.test(i.type) && i.addresses.length > 0);
      const details = (iface?.details ?? {}) as Record<string, unknown>;
      const address = typeof details['default_address'] === 'string' ? details['default_address'] : iface?.addresses[0];
      if (!address) {
        unknown.push(p);
        continue;
      }
      const key = address.toLowerCase();
      const list = byAddress.get(key) ?? [];
      list.push({
        p,
        alternates: (iface?.addresses ?? []).filter((a) => a.toLowerCase() !== key),
        altNote: typeof details['alt_address'] === 'string' ? details['alt_address'] : null,
      });
      byAddress.set(key, list);
    }
    for (const [address, devices] of byAddress) {
      if (devices.length < 2) continue;
      const movable = devices.find((d) => d.alternates.length > 0);
      out.push(
        make(
          'bus_address_conflict',
          'BLOCKER',
          `${devices.length} devices share I2C address ${address}: ${devices.map((d) => d.p.instanceId).join(', ')}.`,
          devices.map((d) => d.p.instanceId),
          [],
          movable
            ? `Set ${movable.p.instanceId} to ${movable.alternates[0]}${movable.altNote ? ` (${movable.altNote})` : ''}, or add an I2C multiplexer.`
            : 'Add an I2C multiplexer (e.g. TCA9548A) — these boards have no alternate address.'
        )
      );
    }
    for (const p of unknown) {
      out.push(make('bus_address_conflict', 'UNKNOWN', `${p.entity.record.identity.product_name} has no I2C address in its record.`, [p.instanceId]));
    }
    if (![...byAddress.values()].some((d) => d.length > 1) && unknown.length === 0) {
      out.push(
        make(
          'bus_address_conflict',
          'PASS',
          `I2C bus: ${[...byAddress.entries()].map(([a, d]) => `${a} (${d[0]!.p.instanceId})`).join(', ')}.`,
          onBus.map((p) => p.instanceId)
        )
      );
    }
  }

  // logic_voltage_compatibility — signal pins on one net must share a logic level.
  const mcuLogic = mcu.logicVolts();
  for (const p of peripherals) {
    const board = boards.get(p.instanceId)!;
    const shifted = LEVEL_SHIFTED.test(board.record.electrical.logic_level_summary ?? '');
    const rail = allocation.peripheralRails.get(p.instanceId) ?? null;
    let checked = 0;
    let failed = 0;
    for (const net of allocation.nets) {
      if (!SIGNAL_CLASSES.has(net.class)) continue;
      const mine = net.members.filter((m) => m.instanceId === p.instanceId);
      const hub = net.members.find((m) => m.instanceId === mcu.instanceId);
      if (mine.length === 0 || !hub) continue;
      const hubVolts = parseVolts(pinOf(hub.instanceId, hub.pinId)?.voltage_domain) ?? mcuLogic;
      for (const m of mine) {
        checked += 1;
        if (shifted) continue;
        // A domain like "VIN" means the pin follows the module's supply.
        const volts = parseVolts(pinOf(m.instanceId, m.pinId)?.voltage_domain) ?? rail;
        if (volts === null) {
          out.push(make('logic_voltage_compatibility', 'UNKNOWN', `${board.label} ${m.pinName} has no known logic level.`, [p.instanceId], [m.pinId]));
          failed += 1;
        } else if (Math.abs(volts - hubVolts) > 0.3) {
          out.push(
            make(
              'logic_voltage_compatibility',
              'BLOCKER',
              `${board.label} ${m.pinName} (${volts} V) and ${mcu.label} ${hub.pinName} (${hubVolts} V) use different logic levels.`,
              [p.instanceId, mcu.instanceId],
              [m.pinId, hub.pinId],
              'Add a bidirectional level shifter between them, or power the module from the controller logic rail.'
            )
          );
          failed += 1;
        }
      }
    }
    if (checked > 0 && failed === 0) {
      out.push(
        make('logic_voltage_compatibility', 'PASS', `${board.label} signals match ${mcu.label} (${shifted ? 'level shifted on board' : `${mcuLogic} V`}).`, [p.instanceId, mcu.instanceId])
      );
    }
  }

  // required_host_interface — a host-dependent module that ended up with no data link is useless.
  for (const p of peripherals) {
    const board = boards.get(p.instanceId)!;
    const links = allocation.linked.get(p.instanceId) ?? new Set();
    if (board.record.interfaces.host_requirement === 'host_required' && links.size === 0) {
      const required = board.record.interfaces.required_host_interfaces;
      out.push(
        make(
          'required_host_interface',
          'BLOCKER',
          `${board.label} needs a host link${required.length > 0 ? ` (${required.join(', ')})` : ''} but none was wired.`,
          [p.instanceId, mcu.instanceId]
        )
      );
    }
  }

  // signal_direction_conflict — two supplies, or two drivers, on one net.
  for (const net of allocation.nets) {
    if (net.class === 'ground') continue;
    const directions = net.members.map((m) => ({ m, dir: pinOf(m.instanceId, m.pinId)?.direction }));
    const supplies = directions.filter((d) => d.dir === 'power_out');
    const drivers = directions.filter((d) => d.dir === 'output');
    if (supplies.length > 1 || drivers.length > 1) {
      const offenders = supplies.length > 1 ? supplies : drivers;
      out.push(
        make(
          'signal_direction_conflict',
          'BLOCKER',
          `${net.name} has ${offenders.length} ${supplies.length > 1 ? 'power outputs' : 'outputs'} driving it.`,
          [...new Set(offenders.map((d) => d.m.instanceId))],
          offenders.map((d) => d.m.pinId)
        )
      );
    }
  }

  // dependency_presence — only required_accessories are enforced; related_modules never are.
  for (const instance of [controller, ...peripherals]) {
    for (const accessory of instance.entity.record.dependencies.required_accessories) {
      const name = accessoryName(accessory);
      out.push(
        make(
          'dependency_presence',
          'WARNING',
          `${instance.entity.record.identity.product_name} requires ${name}.`,
          [instance.instanceId],
          [],
          `Add ${name} to the bench.`
        )
      );
    }
  }

  return out;
}

export function countResults(results: CompatibilityResult[]): Record<RuleStatus, number> {
  const counts: Record<RuleStatus, number> = { PASS: 0, WARNING: 0, BLOCKER: 0, UNKNOWN: 0 };
  for (const r of results) counts[r.status] += 1;
  return counts;
}
