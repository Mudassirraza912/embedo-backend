import { PlaceholderKind } from './prototype-placeholders.js';

/**
 * Off-board parts a brief names: a battery, DC or stepper motors, servos, and switched loads
 * (pumps, fans, valves, heaters, LED strips). They are not library modules, but a bench without
 * them is incomplete: the tester's 2026-10-16 runs showed a rover with no motors or battery and a
 * watering controller with no pump, so nothing showed what the driver or relay actually drives.
 *
 * Read from the brief's own words only; a part the brief does not name is never added.
 */

export interface OutsidePartSpec {
  kind: Extract<PlaceholderKind, 'BATTERY' | 'MOTOR' | 'STEPPER' | 'LOAD' | 'SERVO'>;
  /** Block label, e.g. "7.4 V 2S LiPo battery", "DC motor 2", "12 V water pump". */
  label: string;
  /** Instance id stem: "battery", "motor", "pump", "servo". */
  stem: string;
}

const COUNT_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, single: 1, two: 2, dual: 2, pair: 2, three: 3, four: 4, quad: 4, six: 6 };
const countOf = (word: string | undefined, plural: boolean): number => {
  if (!word) return plural ? 2 : 1;
  const n = Number(word);
  return Math.min(8, Number.isFinite(n) && n > 0 ? n : (COUNT_WORDS[word.toLowerCase()] ?? (plural ? 2 : 1)));
};

const CHEMISTRY = /\b(li-?po(?:ly(?:mer)?)?|li-?ion|lithium(?:[- ](?:ion|polymer))?|lifepo4|18650|nimh|alkaline)\b/i;
const NOT_A_SUPPLY = /coin|cr20\d\d|backup|\brtc\b|fuel gauge|gauge|monitor|level|sens(?:e|ing)|measur|percentage|charge (?:state|level)/i;

const CELL_VOLTS: Array<[RegExp, number, string]> = [
  [/^aaa?$/i, 1.5, 'AA'],
  [/^nimh$/i, 1.2, 'NiMH'],
  [/^(?:18650|li-?ion)$/i, 3.7, 'Li-ion 18650'],
];

function batteryOf(text: string): OutsidePartSpec | null {
  // A pack of cells: "4 AA batteries" (6 V), "two 18650 cells" (7.4 V).
  const pack = /\b(\d+|two|three|four|six|eight)\s+(aaa?|nimh|18650|li-?ion)\s*(?:batter(?:y|ies)|cells?)\b/i.exec(text);
  if (pack && !NOT_A_SUPPLY.test(text.slice(Math.max(0, (pack.index ?? 0) - 24), (pack.index ?? 0) + pack[0].length + 24))) {
    const n = countOf(pack[1], true);
    const cell = CELL_VOLTS.find(([re]) => re.test(pack[2]!))!;
    const kind = /^aaa$/i.test(pack[2]!) ? 'AAA' : cell[2];
    return { kind: 'BATTERY', label: `${Number((n * cell[1]).toFixed(1))} V battery (${n} × ${kind})`, stem: 'battery' };
  }
  for (const m of text.matchAll(/\b(battery|batteries|li-?po(?:ly(?:mer)?)?|li-?ion|lithium|lifepo4|18650)\b/gi)) {
    const at = m.index ?? 0;
    const before = text.slice(Math.max(0, at - 32), at);
    const around = text.slice(Math.max(0, at - 32), at + m[0].length + 24);
    if (NOT_A_SUPPLY.test(around)) continue;
    const volts = [...before.matchAll(/(\d+(?:\.\d+)?)\s*v\b/gi)].pop()?.[1] ?? /^\s*\(?\s*(\d+(?:\.\d+)?)\s*v\b/i.exec(text.slice(at + m[0].length))?.[1];
    const cells = /\b(\d)\s*s(?:\d+p)?\b/i.exec(around)?.[1];
    const chem = CHEMISTRY.exec(around)?.[1];
    if (!volts && !chem) continue; // "battery powered" alone says nothing about the pack
    const chemName = chem ? (/li-?po/i.test(chem) ? 'LiPo' : /li-?ion|lithium|18650/i.test(chem) ? 'Li-ion' : chem.toUpperCase() === 'LIFEPO4' ? 'LiFePO4' : chem) : null;
    const v = volts ? Number(volts) : chemName && /li/i.test(chemName) ? Number((3.7 * (cells ? Number(cells) : 1)).toFixed(1)) : null;
    const label = [v !== null ? `${v} V` : null, cells && Number(cells) > 1 ? `${cells}S` : null, chemName, 'battery'].filter(Boolean).join(' ');
    return { kind: 'BATTERY', label, stem: 'battery' };
  }
  return null;
}

const LOADS: Array<[RegExp, string, string]> = [
  [/peristaltic pump/i, 'peristaltic pump', 'pump'],
  [/water pump/i, 'water pump', 'pump'],
  [/air pump/i, 'air pump', 'pump'],
  [/\bpump\b/i, 'pump', 'pump'],
  [/solenoid valve/i, 'solenoid valve', 'valve'],
  [/solenoid lock|door lock|electric lock/i, 'solenoid lock', 'lock'],
  [/\bsolenoid\b/i, 'solenoid', 'solenoid'],
  [/\bvalve\b/i, 'valve', 'valve'],
  [/cooling fan|\bfan\b/i, 'fan', 'fan'],
  [/heating pad|\bheater\b/i, 'heater', 'heater'],
  [/led strip/i, 'LED strip', 'ledstrip'],
];
const DRIVER_AFTER = /^\s*(?:driver|controller|shield|hat|module|board|breakout|header|connector|port)/i;

export function outsidePartsOf(brief: string): OutsidePartSpec[] {
  // "4x SG90 servos", "2 × motors" read as "4 SG90 servos".
  const text = brief.replace(/\s+/g, ' ').replace(/\b(\d+)\s*[x×]\s*/gi, '$1 ');
  const out: OutsidePartSpec[] = [];
  const battery = batteryOf(text);
  if (battery) out.push(battery);

  // DC / gear motors: "2 brushed DC motors", "two TT gear motors"; never "DC motor driver".
  let motors = 0;
  for (const m of text.matchAll(/\b(?:(\d+|one|two|three|four|six|a|an|dual|pair of)\s+)?(?:x\s*)?(?:small\s+|micro\s+|brushed\s+|geared\s+)*(?:dc|gear|tt|n20)\s+(?:gear\s*)?(motors?)\b/gi)) {
    if (DRIVER_AFTER.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    motors = Math.max(motors, countOf(m[1]?.replace(/ of$/i, ''), /s$/i.test(m[2]!)));
  }
  for (let i = 1; i <= motors; i++) out.push({ kind: 'MOTOR', label: motors > 1 ? `DC motor ${i}` : 'DC motor', stem: 'motor' });

  let steppers = 0;
  for (const m of text.matchAll(/\b(?:(\d+|one|two|three|four|a|an|dual)\s+)?(?:nema\s*\d+\s+)?stepper(?:\s+(motors?))?\b/gi)) {
    if (DRIVER_AFTER.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    steppers = Math.max(steppers, countOf(m[1], /s$/i.test(m[2] ?? '')));
  }
  for (let i = 1; i <= steppers; i++) out.push({ kind: 'STEPPER', label: steppers > 1 ? `Stepper motor ${i}` : 'Stepper motor', stem: 'stepper' });

  let servos = 0;
  for (const m of text.matchAll(/\b(?:(\d+|one|two|three|four|six|a|an|dual|pair of)\s+)?(?:x\s*)?(?:micro\s+|mini\s+|sg90\s+|mg9\d\s+)*(servos?)(?:\s+motors?)?\b/gi)) {
    if (DRIVER_AFTER.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    servos = Math.max(servos, countOf(m[1]?.replace(/ of$/i, ''), /s$/i.test(m[2]!)));
  }
  for (let i = 1; i <= servos; i++) out.push({ kind: 'SERVO', label: servos > 1 ? `Servo ${i}` : 'Servo', stem: 'servo' });

  // One block per kind of load; a matched phrase is consumed, so "solenoid valve" is not also a
  // "solenoid" and "water pump" not also a "pump".
  const seen = new Set<string>();
  let rest = text;
  for (const [re, name, stem] of LOADS) {
    const m = re.exec(rest);
    if (!m || seen.has(stem)) continue;
    const at = m.index ?? 0;
    rest = `${rest.slice(0, at)}${' '.repeat(m[0].length)}${rest.slice(at + m[0].length)}`;
    if (DRIVER_AFTER.test(text.slice(at + m[0].length))) continue;
    seen.add(stem);
    const volts = /(\d+(?:\.\d+)?)\s*v(?:dc)?\s*(?:dc\s+)?$/i.exec(text.slice(Math.max(0, at - 12), at))?.[1];
    out.push({ kind: 'LOAD', label: `${volts ? `${volts} V ` : ''}${name}`, stem });
  }
  return out;
}
