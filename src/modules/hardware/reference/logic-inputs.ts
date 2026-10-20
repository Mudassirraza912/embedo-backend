/**
 * How 5 V parts read a 3.3 V logic high, from their datasheets.
 *
 * Comparing supply voltages fails parts that work: an L298N runs from 5 V but its inputs read
 * anything above 2.3 V as high, so a 3.3 V controller drives it directly (the tester's 2026-10-16
 * report: four false "different logic levels" failures on an L298N). Other 5 V parts really need a
 * 5 V high (CMOS inputs at 0.7 × VDD), and relay boards depend on their driver stage.
 */

export type InputKind = 'ttl' | 'cmos5' | 'relay';

export interface LogicInput {
  part: string;
  match: RegExp;
  /** Only these module pins (e.g. a sensor's trigger input); every input pin when absent. */
  pins?: RegExp;
  kind: InputKind;
  /** Input-high threshold (V) for TTL inputs. */
  vih?: number;
  note: string;
}

export const LOGIC_INPUTS: LogicInput[] = [
  { part: 'L298', match: /\bL298N?\b/i, kind: 'ttl', vih: 2.3, note: 'L298 logic inputs read 2.3 V and above as high' },
  { part: 'L293', match: /\bL293D?\b/i, kind: 'ttl', vih: 2.3, note: 'L293 inputs read 2.3 V and above as high' },
  { part: 'ULN2003 / ULN2803', match: /\bULN2[08]0[34]A?\b/i, kind: 'ttl', vih: 2.4, note: 'ULN2003/2803 inputs switch on from about 2.4 V' },
  { part: 'DRV8833 / DRV8871', match: /\bDRV8(?:833|835|871|848)\b/i, kind: 'ttl', vih: 2, note: 'DRV88xx logic inputs read 2 V and above as high' },
  { part: '74HCT / 74AHCT', match: /\b74A?HCT\d+/i, kind: 'ttl', vih: 2, note: 'HCT logic reads 2 V and above as high' },
  { part: 'HC-SR04', match: /\bHC-?SR04\b/i, pins: /^TRIG/i, kind: 'ttl', vih: 2, note: 'the HC-SR04 trigger input accepts a 3.3 V pulse' },
  { part: 'Hobby servo', match: /\bservo\b/i, pins: /^(SIG|SIGNAL|PWM|S)$/i, kind: 'ttl', vih: 2, note: 'servo signal inputs accept 3.3 V pulses' },
  { part: 'WS2812 / NeoPixel', match: /\bWS281[2-5]B?\b|\bSK6812\b|neopixel/i, kind: 'cmos5', note: 'WS2812 data needs 0.7 × VDD (3.5 V at 5 V)' },
  { part: 'MAX7219', match: /\bMAX72(?:19|21)\b/i, kind: 'cmos5', note: 'MAX7219 inputs need 3.5 V at 5 V supply' },
  { part: 'Relay module', match: /\brelay\b/i, kind: 'relay', note: 'relay boards switch through a transistor or optocoupler stage built for 5 V' },
];

/** What a module's input pin needs to see as a logic high, when the part is known. */
export function logicInputFor(record: { identity: { product_name: string; main_silicon?: string | null } }, pinName: string): LogicInput | null {
  const text = `${record.identity.main_silicon ?? ''} ${record.identity.product_name}`;
  return LOGIC_INPUTS.find((l) => l.match.test(text) && (!l.pins || l.pins.test(pinName.trim()))) ?? null;
}

/** A controller pin that accepts 5 V inputs: an STM32 "FT" pin, or one the record calls 5 V tolerant. */
export const isFiveVoltTolerant = (domain: string | null | undefined): boolean => /(?:^|[^A-Z])FT(?:$|[^A-Z])|5\s*V\s*tol/i.test(domain ?? '');
