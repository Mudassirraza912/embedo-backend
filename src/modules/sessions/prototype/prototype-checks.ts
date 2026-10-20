import { HardwarePin } from '../../hardware/hardware.schema.js';
import { isFiveVoltTolerant, logicInputFor } from '../../hardware/reference/logic-inputs.js';
import { Board, parseVolts } from './prototype-board.js';
import { AllocationResult, AllocInstance } from './prototype-allocator.js';
import { CompatibilityResult, RuleStatus } from './prototype.types.js';
import { isOutsideKind, isPlaceholderEntity, placeholderKindOf } from './prototype-placeholders.js';

/**
 * Composition-wide rules that need the finished net list (truth file §10, plan D5 step 5).
 * The allocator already reports what it could not do (no bus, no rail); these read what it did.
 * UNKNOWN is a first-class outcome: a fact missing from a record is never treated as a pass.
 */

/**
 * Boards whose I/O works at 3.3 V and 5 V (on-board level shifting, or a regulator + shifter as on
 * most Adafruit breakouts). Vendors write it many ways: "3-5V", "3.3V or 5V compatible", "3V or 5V
 * compliant", "5V tolerant", "3.3V/5V logic" (the last ones were missed before 2026-10-16, so an
 * SHT31-D and a VEML7700 failed a logic check their boards are built to pass).
 */
const LEVEL_SHIFTED = /level.?shift|\b3(?:\.3)?\s*v?\s*(?:-|–|to|or|and|\/)\s*5\s*v|5\s*v\s*(?:tolerant|compliant|compatible|safe)/i;
const SIGNAL_CLASSES = new Set(['i2c', 'spi', 'uart', 'can', 'rs485', 'gpio', 'analog', 'pwm']);

const make = (
  ruleType: string,
  status: RuleStatus,
  message: string,
  instanceIds: string[],
  pinIds: string[] = [],
  suggestedFix: string | null = null
): CompatibilityResult => ({ ruleType, status, message, suggestedFix, instanceIds, pinIds });

const NOT_AN_ACCESSORY =
  /\b(micro ?controller|mcu|host\b|controller (?:board|with)|wiring|wires?\b|twisted[- ]pair|bus cable|power supply|supply capable|logic level|level shifter|uart|i2c|spi\b|gpio)/i;

const accessoryName = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'object' && value !== null
      ? String((value as Record<string, unknown>)['name'] ?? (value as Record<string, unknown>)['accessory'] ?? JSON.stringify(value))
      : String(value);

export function evaluateCompatibility(controller: AllocInstance, allPeripherals: AllocInstance[], allocation: AllocationResult): CompatibilityResult[] {
  const out: CompatibilityResult[] = [];
  // Placeholders have generic pins and no facts: they are wired for the protocol design but never
  // checked as if they were parts. One summary result says what they are.
  // Outside parts (the 12 V input, a battery, motors, a pump) are drawn as blocks but are not missing modules.
  const placeholders = allPeripherals.filter((p) => isPlaceholderEntity(p.entity) && !isOutsideKind(placeholderKindOf(p.entity.hardwareEntityId)));
  const peripherals = allPeripherals.filter((p) => !isPlaceholderEntity(p.entity));
  const mcu = new Board(controller.instanceId, controller.entity);
  const boards = new Map<string, Board>([[mcu.instanceId, mcu], ...allPeripherals.map((p) => [p.instanceId, new Board(p.instanceId, p.entity)] as const)]);
  const pinOf = (instanceId: string, pinId: string): HardwarePin | undefined => boards.get(instanceId)?.pinsById.get(pinId);

  // bus_address_conflict — every I2C device on the shared bus needs its own address. The allocator
  // gave each one an address from its chip's datasheet set (moving one to its alternate, and
  // strapping it when its address pin is on the header); this reports what it did.
  const onBus = peripherals.filter((p) => allocation.linked.get(p.instanceId)?.has('I2C'));
  if (onBus.length > 0) {
    const label = (id: string) => boards.get(id)?.label ?? id;
    const busPinsOf = (ids: Set<string>) =>
      allocation.nets.filter((n) => n.class === 'i2c').flatMap((n) => n.members.filter((m) => ids.has(m.instanceId)).map((m) => m.pinId));
    let clashes = 0;
    let unknown = 0;
    for (const p of onBus) {
      const a = allocation.i2cAddresses.get(p.instanceId);
      if (!a || a.address === null) {
        unknown += 1;
        out.push(make('bus_address_conflict', 'UNKNOWN', `${label(p.instanceId)} has no I2C address in its record.`, [p.instanceId], [], "Check the address in the board's documentation."));
        continue;
      }
      if (a.clashWith.length > 0) {
        clashes += 1;
        const ids = new Set([p.instanceId, ...a.clashWith]);
        out.push(
          make(
            'bus_address_conflict',
            'BLOCKER',
            `${label(p.instanceId)} can only use ${a.options.join(' or ')}, and ${a.clashWith.map(label).join(', ')} already ${a.clashWith.length === 1 ? 'uses' : 'use'} ${a.options.length === 1 ? 'it' : 'them'}.`,
            [...ids],
            [...new Set(busPinsOf(ids))],
            'Add an I2C multiplexer (e.g. TCA9548A) or put one of them on a second I2C bus.'
          )
        );
        continue;
      }
      if (a.moved && a.strap && !a.strap.wired) {
        out.push(
          make(
            'bus_address_conflict',
            'WARNING',
            `Set ${label(p.instanceId)} to ${a.address}: its default ${a.options[0]} is taken on the bus.`,
            [p.instanceId],
            [],
            `Tie its ${a.strap.pin ?? 'address'} pin to ${a.strap.level === 'GND' ? 'GND' : 'its supply'} (or close its address jumper) for ${a.address}.`
          )
        );
      } else if (a.moved && !a.strap) {
        out.push(
          make('bus_address_conflict', 'WARNING', `Set ${label(p.instanceId)} to ${a.address}: its default ${a.options[0]} is taken on the bus.`, [p.instanceId], [], "Select the alternate address as the board's documentation describes.")
        );
      }
    }
    if (clashes === 0 && unknown === 0) {
      const entries = onBus.map((p) => {
        const a = allocation.i2cAddresses.get(p.instanceId)!;
        const how = a.channel ? ` (${label(a.channel.mux)} channel ${a.channel.n})` : a.moved && a.strap?.wired ? ` (${a.strap.pin} to ${a.strap.level === 'GND' ? 'GND' : 'V+'})` : '';
        return `${a.address} ${label(p.instanceId)}${how}`;
      });
      out.push(make('bus_address_conflict', 'PASS', `I2C bus, every address unique: ${entries.join(', ')}.`, onBus.map((p) => p.instanceId)));
    }
  }

  // logic_voltage_compatibility — every signal must be read correctly in its direction. A 3.3 V
  // controller drives a 5 V module whose inputs are TTL level (L298N: high above 2.3 V); a 5 V
  // output into the controller needs a 5 V tolerant pin, a divider or a level shifter.
  const mcuLogic = mcu.logicVolts();
  for (const p of peripherals) {
    const board = boards.get(p.instanceId)!;
    const shifted = LEVEL_SHIFTED.test(board.record.electrical.logic_level_summary ?? '');
    const rail = allocation.peripheralRails.get(p.instanceId) ?? null;
    let checked = 0;
    let failed = 0;
    const notes = new Set<string>();
    for (const net of allocation.nets) {
      if (!SIGNAL_CLASSES.has(net.class)) continue;
      const mine = net.members.filter((m) => m.instanceId === p.instanceId);
      const hub = net.members.find((m) => m.instanceId === mcu.instanceId);
      if (mine.length === 0 || !hub) continue;
      const hubPin = pinOf(hub.instanceId, hub.pinId);
      const hubVolts = parseVolts(hubPin?.voltage_domain) ?? mcuLogic;
      const hubTolerant = isFiveVoltTolerant(hubPin?.voltage_domain);
      for (const m of mine) {
        checked += 1;
        const pin = pinOf(m.instanceId, m.pinId);
        const declared = parseVolts(pin?.voltage_domain);
        // A domain like "VIN" means the pin follows the module's supply.
        const volts = declared ?? rail;
        const direction = pin?.direction === 'input' ? 'in' : pin?.direction === 'output' ? 'out' : 'both';
        if (volts === null) {
          if (shifted) continue;
          out.push(make('logic_voltage_compatibility', 'UNKNOWN', `${board.label} ${m.pinName} has no known logic level.`, [p.instanceId], [m.pinId]));
          failed += 1;
          continue;
        }
        if (Math.abs(volts - hubVolts) <= 0.3) continue;
        // On-board level shifting covers the pin unless the record says it drives a fixed higher level.
        if (shifted && !(direction === 'out' && declared !== null && volts > hubVolts && !hubTolerant)) continue;
        const pair = `${board.label} ${m.pinName} (${volts} V) and ${mcu.label} ${hub.pinName} (${hubVolts} V)`;
        if (volts > hubVolts && direction === 'in') {
          // The controller drives a higher-voltage input: fine when the part reads its logic high low enough.
          const input = logicInputFor(board.record, m.pinName);
          if (input?.kind === 'ttl' && input.vih !== undefined && input.vih <= hubVolts - 0.5) {
            notes.add(`${input.note}, so ${hubVolts} V drives ${m.pinName}`);
            continue;
          }
          if (input?.kind === 'relay') {
            out.push(
              make(
                'logic_voltage_compatibility',
                'WARNING',
                `${board.label} ${m.pinName} is a ${volts} V relay input driven at ${hubVolts} V by ${mcu.label} ${hub.pinName}: ${input.note}, so it may not switch reliably.`,
                [p.instanceId, mcu.instanceId],
                [m.pinId, hub.pinId],
                `Use a relay board rated for ${hubVolts} V logic, or drive ${m.pinName} through an NPN transistor (e.g. 2N2222 with a 1 kΩ base resistor).`
              )
            );
            failed += 1;
            continue;
          }
          out.push(
            input?.kind === 'cmos5'
              ? make('logic_voltage_compatibility', 'BLOCKER', `${pair}: ${input.note}, so ${hubVolts} V is not a valid high.`, [p.instanceId, mcu.instanceId], [m.pinId, hub.pinId], `Buffer ${m.pinName} with a 74AHCT125 powered from ${volts} V.`)
              : make(
                  'logic_voltage_compatibility',
                  'UNKNOWN',
                  `${pair}: the record does not give ${m.pinName}'s input-high threshold, so it is unverified whether ${hubVolts} V reads as high.`,
                  [p.instanceId, mcu.instanceId],
                  [m.pinId, hub.pinId],
                  `Check ${m.pinName}'s input-high voltage (VIH) in the datasheet; above ${(hubVolts - 0.5).toFixed(1)} V it needs a 74AHCT125 buffer.`
                )
          );
          failed += 1;
          continue;
        }
        if (volts > hubVolts && direction === 'out') {
          if (hubTolerant) {
            notes.add(`${mcu.label} ${hub.pinName} is 5 V tolerant, so it takes ${m.pinName}'s ${volts} V output`);
            continue;
          }
          out.push(
            make(
              'logic_voltage_compatibility',
              'BLOCKER',
              `${pair}: ${m.pinName} drives ${volts} V into a ${hubVolts} V controller pin that is not 5 V tolerant.`,
              [p.instanceId, mcu.instanceId],
              [m.pinId, hub.pinId],
              `Add a voltage divider on ${m.pinName} (e.g. 10 kΩ in series, 20 kΩ to GND) or a level shifter, or power the module from ${hubVolts} V if it supports it.`
            )
          );
          failed += 1;
          continue;
        }
        if (volts < hubVolts && direction === 'out' && volts >= 0.6 * hubVolts) {
          notes.add(`${mcu.label} reads ${m.pinName}'s ${volts} V output as high`);
          continue;
        }
        out.push(
          make(
            'logic_voltage_compatibility',
            'BLOCKER',
            `${pair} use different logic levels.`,
            [p.instanceId, mcu.instanceId],
            [m.pinId, hub.pinId],
            direction === 'both'
              ? 'Add a bidirectional level shifter (BSS138-based, e.g. Adafruit 757), or power the module from the controller logic rail.'
              : `Add a level shifter or voltage divider on ${m.pinName}, or power the module from the controller logic rail.`
          )
        );
        failed += 1;
      }
    }
    if (checked > 0 && failed === 0) {
      const how = notes.size > 0 ? [...notes].join('; ') : shifted ? 'level shifted on board' : `${mcuLogic} V`;
      out.push(make('logic_voltage_compatibility', 'PASS', `${board.label} signals match ${mcu.label} (${how}).`, [p.instanceId, mcu.instanceId]));
    }
  }

  // required_host_interface — a host-dependent module that ended up with no data link is useless.
  for (const p of allPeripherals) {
    const board = boards.get(p.instanceId)!;
    const links = allocation.linked.get(p.instanceId) ?? new Set();
    if (board.record.interfaces.host_requirement !== 'host_required') continue;
    // The allocator already said why this module is not linked (no free UART, no transceiver, ...):
    // one failure, reported once.
    const explained = allocation.results.some(
      (r) => (r.ruleType === 'required_host_interface' || r.ruleType === 'protocol_compatibility') && r.status !== 'PASS' && r.instanceIds.includes(p.instanceId)
    );
    if (links.size === 0 && explained) continue;
    if (links.size === 0) {
      const required = board.record.interfaces.required_host_interfaces;
      out.push(
        make(
          'required_host_interface',
          'BLOCKER',
          `${board.label} needs a host link${required.length > 0 ? ` (${required.join(', ')})` : ''} but none was wired.`,
          [p.instanceId, mcu.instanceId]
        )
      );
    } else {
      // The check ran and passed: record it, so the summary counts what was actually checked.
      out.push(make('required_host_interface', 'PASS', `${board.label} is linked to ${mcu.label} over ${[...links].join(', ')}.`, [p.instanceId, mcu.instanceId]));
    }
  }

  // signal_direction_conflict — two supplies, or two drivers, on one net.
  let conflicts = 0;
  for (const net of allocation.nets) {
    if (net.class === 'ground') continue;
    const directions = net.members.map((m) => ({ m, dir: pinOf(m.instanceId, m.pinId)?.direction }));
    // On the battery's net a charger's BAT terminal charges the battery: it is not a second supply.
    const isBattery = (id: string) => placeholderKindOf(boards.get(id)?.entity.hardwareEntityId ?? '') === 'BATTERY';
    const batteryNet = net.members.some((m) => isBattery(m.instanceId));
    const supplies = directions.filter((d) => d.dir === 'power_out' && (!batteryNet || isBattery(d.m.instanceId)));
    // Shared bus lines are driven by one device at a time by design: SPI MISO (tri-state, chip
    // select picks the driver), I2C (open drain), CAN and RS-485 pairs (bus arbitration / half
    // duplex). Two outputs there are not a conflict (a 3-device SPI bus used to fail this check).
    const sharedBus =
      net.class === 'i2c' || net.class === 'can' || (net.class === 'rs485' && /^RS485_[AB]$/.test(net.name)) || (net.class === 'spi' && /(MISO|CIPO)$/i.test(net.name));
    const drivers = sharedBus ? [] : directions.filter((d) => d.dir === 'output');
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
      conflicts += 1;
    }
  }
  const drivenNets = allocation.nets.filter((n) => n.class !== 'ground');
  if (conflicts === 0 && drivenNets.length > 0) {
    out.push(
      make(
        'signal_direction_conflict',
        'PASS',
        `No net has two outputs or two supplies driving it (${drivenNets.length} net${drivenNets.length === 1 ? '' : 's'} checked).`,
        [...new Set(drivenNets.flatMap((n) => n.members.map((m) => m.instanceId)))]
      )
    );
  }

  // record_evidence — where each board's pinout and ratings come from. Every other check is only as
  // good as these facts: a pinout from AI product knowledge is Unverified until checked against
  // the board's documentation. (This is about evidence, not about library review status.)
  for (const instance of [controller, ...peripherals]) {
    const label = instance.entity.record.identity.product_name;
    const method = instance.entity.verificationMethod;
    if (method === 'vendor_live' || method === 'manual_verified' || method === 'verified_third_party') {
      const from = method === 'vendor_live' ? "the vendor's product page" : method === 'manual_verified' ? "the board's documentation" : 'a third-party reference';
      out.push(make('record_evidence', 'PASS', `${label}: pinout and ratings read from ${from}.`, [instance.instanceId]));
    } else {
      out.push(
        make(
          'record_evidence',
          'UNKNOWN',
          method === 'generic_reference'
            ? `${label}: pinout follows a generic reference design, not this exact board's documentation.`
            : `${label}: pinout and ratings come from AI product knowledge, not from the board's documentation.`,
          [instance.instanceId],
          [],
          "Check the pin labels and supply range against the board's datasheet before powering up."
        )
      );
    }
  }

  if (placeholders.length > 0) {
    // Power is wired from each placeholder's usual rail (logic rail, or 12-24 V for a field device): an assumption until a part is chosen.
    const rails = new Map<string, string[]>();
    for (const p of placeholders) {
      const rail = allocation.placeholderRails.get(p.instanceId) ?? 'not wired (no suitable supply on the bench)';
      rails.set(rail, [...(rails.get(rail) ?? []), p.entity.record.identity.product_name]);
    }
    const power = [...rails.entries()].map(([rail, names]) => `${names.length === placeholders.length ? 'all' : names.join(', ')} on ${rail}`).join('; ');
    out.push(
      make(
        'placeholder_module',
        'WARNING',
        `${placeholders.length} block${placeholders.length === 1 ? ' is a placeholder' : 's are placeholders'} (no matching module in the library): ${placeholders
          .map((p) => p.entity.record.identity.product_name)
          .join(', ')}. Their pins are generic; power is wired as a starting point (${power}).`,
        placeholders.map((p) => p.instanceId),
        [],
        "Choose a real module for each placeholder; its supply and pins are then wired and checked from its record."
      )
    );
  }

  // dependency_presence — only required_accessories are enforced; related_modules never are.
  // Sourced records sometimes list what the board connects to as an "accessory" ("a microcontroller
  // with a UART", "CAN bus wiring", "5 V supply"): the bench and the other checks cover those.
  for (const instance of [controller, ...peripherals]) {
    for (const accessory of instance.entity.record.dependencies.required_accessories) {
      const name = accessoryName(accessory);
      if (NOT_AN_ACCESSORY.test(name)) continue;
      // A STEMMA QT / Qwiic cable for a board whose I2C is wired: the bench already has that cable or adapter (Source lists it).
      if (/stemma|qwiic|\bqt\b|jst[- ]?sh/i.test(name) && allocation.linked.get(instance.instanceId)?.has('I2C')) continue;
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
