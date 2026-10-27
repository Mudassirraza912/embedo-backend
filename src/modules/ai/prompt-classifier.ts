import winkNLP from 'wink-nlp';
import model from 'wink-eng-lite-web-model';

/**
 * Prompt difficulty classifier. Deterministic, local, no AI tokens: wink-nlp reads the text
 * (tokens, sentences, numbers) and a fixed scorer tuned to hardware briefs adds up how much
 * the request asks for. The router uses the result to pick a model per difficulty
 * (difficulty_model_routes, edited from admin.embedo.ai → AI Operations).
 *
 * Same text → same result. Each feature is capped so one signal (e.g. a very long brief)
 * cannot make a prompt "hard" on its own.
 */

export const PROMPT_DIFFICULTIES = ['easy', 'medium', 'hard'] as const;
export type PromptDifficulty = (typeof PROMPT_DIFFICULTIES)[number];

/** Score boundaries (0-100): below MEDIUM = easy, below HARD = medium, else hard. */
export const DIFFICULTY_THRESHOLDS = { medium: 15, hard: 50 } as const;

/** Task cases whose model is chosen by difficulty: Architect synthesis, Prototype resolver, chat. */
export const DIFFICULTY_TASK_CASES = ['A', 'R', 'E'] as const;
export type DifficultyTaskCase = (typeof DIFFICULTY_TASK_CASES)[number];
export const isDifficultyTaskCase = (taskCase: string): taskCase is DifficultyTaskCase =>
  (DIFFICULTY_TASK_CASES as readonly string[]).includes(taskCase);

/** Longer text adds nothing the first part does not already show, and keeps the call ~ms. */
const MAX_CHARS = 8000;

export interface PromptClassification {
  difficulty: PromptDifficulty;
  /** 0-100 */
  score: number;
  /** Human-readable reasons, e.g. "6 parts or modules named", for the admin portal and logs. */
  signals: string[];
}

const nlp = winkNLP(model);
const its = nlp.its;

// Interfaces and buses. Field and high-speed buses take more design effort than I2C/GPIO.
const INTERFACES: Array<{ label: string; re: RegExp; heavy?: boolean }> = [
  { label: 'I2C', re: /\bi(?:2|²)c\b|\bqwiic\b|\bstemma\b/i },
  { label: 'SPI', re: /\bq?spi\b/i },
  { label: 'UART', re: /\buart\b|\busart\b|\bserial\b/i },
  { label: 'GPIO', re: /\bgpio\b/i },
  { label: 'PWM', re: /\bpwm\b/i },
  { label: 'ADC', re: /\badc\b|\banalog input\b/i },
  { label: 'I2S', re: /\bi2s\b/i },
  { label: 'USB', re: /\busb\b/i },
  { label: 'Wi-Fi', re: /\bwi-?fi\b|\bwlan\b/i },
  { label: 'Bluetooth', re: /\bble\b|\bbluetooth\b/i },
  { label: 'LoRa', re: /\blora(?:wan)?\b/i },
  { label: 'Cellular', re: /\blte\b|\bnb-?iot\b|\bcat-?m1?\b|\bgsm\b|\b[45]g\b/i },
  { label: 'Zigbee/Thread', re: /\bzigbee\b|\bthread\b|\bmatter\b/i },
  { label: 'CAN', re: /\bCAN(?:-?FD|open| bus)?\b|\bfdcan\b/, heavy: true },
  { label: 'RS-485', re: /\brs-?485\b|\brs-?422\b/i, heavy: true },
  { label: 'Modbus', re: /\bmodbus\b/i, heavy: true },
  { label: 'Ethernet', re: /\bethernet\b|\brmii\b|\bpoe\b/i, heavy: true },
  { label: 'EtherCAT', re: /\bethercat\b|\bprofinet\b/i, heavy: true },
  { label: 'MIPI/camera', re: /\bmipi\b|\bcsi-?2?\b|\bdsi\b/i, heavy: true },
  { label: 'PCIe', re: /\bpcie\b/i, heavy: true },
  { label: 'DDR/SDRAM', re: /\bddr\d?\b|\bsdram\b/i, heavy: true },
  { label: 'HDMI', re: /\bhdmi\b/i, heavy: true },
];

// Kinds of building block. Each kind named counts once, whatever word was used.
const BLOCKS: Array<{ label: string; re: RegExp }> = [
  { label: 'controller', re: /\b(?:mcu|microcontroller|controller|soc|fpga|arduino|esp32|stm32|rp2040|pico|nrf52|teensy|raspberry pi|nucleo|feather)\b/i },
  { label: 'sensor', re: /\bsensors?\b|\bimu\b|\baccelerometer\b|\bgyro\w*\b|\bmagnetometer\b|\bthermistor\b|\bthermocouple\b|\bbarometer\b|\bhumidity\b|\btemperature\b|\bpressure\b|\blidar\b|\bultrasonic\b/i },
  { label: 'display', re: /\bdisplay\b|\boled\b|\blcd\b|\be-?ink\b|\btft\b|\bscreen\b/i },
  { label: 'positioning', re: /\bgps\b|\bgnss\b|\brtk\b/i },
  { label: 'storage', re: /\bsd ?card\b|\bmicro-?sd\b|\bflash\b|\beeprom\b|\bfram\b|\blog(?:s|ging|ger)?\b/i },
  { label: 'motor', re: /\bmotors?\b|\bstepper\b|\bservos?\b|\bbldc\b|\besc\b/i },
  { label: 'motor driver', re: /\bmotor drivers?\b|\bh-?bridge\b|\bdrv\d+\b|\bl298\b|\btb6612\b/i },
  { label: 'actuator/load', re: /\brelays?\b|\bsolenoid\b|\bpump\b|\bvalve\b|\bfan\b|\bheater\b|\bled strip\b|\bneopixel\b|\bws2812\b/i },
  { label: 'audio', re: /\bspeaker\b|\bmicrophone\b|\bamplifier\b|\bbuzzer\b|\baudio\b/i },
  { label: 'camera', re: /\bcamera\b|\bimage sensor\b/i },
  { label: 'radio', re: /\bradio\b|\bantenna\b|\btransceiver\b|\brf\b/i },
  { label: 'user input', re: /\bbuttons?\b|\bkeypad\b|\bencoder\b|\bjoystick\b|\btouch\b/i },
  { label: 'battery', re: /\bbattery\b|\bli-?po\b|\bli-?ion\b|\b18650\b|\blifepo4\b/i },
  { label: 'power conversion', re: /\bbuck\b|\bboost\b|\bregulator\b|\bldo\b|\bcharger\b|\bpmic\b|\bdc-?dc\b|\bsolar\b/i },
  { label: 'security', re: /\bsecure element\b|\btpm\b|\bencrypt\w*\b|\bsecure boot\b/i },
];

// Requirements that need engineering judgement, not just more parts.
const CONSTRAINTS: Array<{ label: string; re: RegExp }> = [
  { label: 'low power', re: /\blow[- ]power\b|\bdeep sleep\b|\bbattery life\b|\b\d+\s?(?:µa|ua|na)\b|\byears? on\b/i },
  { label: 'real time', re: /\breal[- ]time\b|\bdeterministic\b|\blatency\b|\bjitter\b|\b\d+\s?k?hz (?:loop|control)\b|\bsynchroni[sz]ed\b/i },
  { label: 'safety', re: /\bsafety\b|\bfail[- ]?safe\b|\be-?stop\b|\bemergency stop\b|\bwatchdog\b|\bredundan\w+\b|\bsil\s?\d\b/i },
  { label: 'certification', re: /\b(?:ce|fcc|ul|iec|iso|en)\s?\d{3,5}\b|\bcertif\w+\b|\bcompliance\b|\bemc\b|\besd\b/i },
  { label: 'environment', re: /\bip6[5-9]\b|\bwaterproof\b|\brugged\b|\bvibration\b|\b-\s?40\s?°?\s?c\b|\bindustrial temp\w*\b|\bautomotive\b|\baec-?q\d+\b/i },
  { label: 'medical', re: /\bmedical\b|\biec ?60601\b|\bpatient\b/i },
  { label: 'precision', re: /\bhigh[- ]precision\b|\baccura(?:te|cy)\b|\b\d+[- ]?bit\b|\bcalibrat\w+\b|\blow[- ]noise\b/i },
  { label: 'cost/size target', re: /\bunder \$\d+|\bunder \d+ ?(?:usd|dollars|eur)\b|\bcost[- ]optimi[sz]ed\b|\bbom cost\b|\bsmall form factor\b|\bwearable\b|\bminiatur\w+\b/i },
  { label: 'over-the-air updates', re: /\bota\b|\bover[- ]the[- ]air\b|\bfirmware update\b/i },
];

// Asks for reasoning rather than a lookup (mostly chat).
const REASONING = /\b(?:why|compare|comparison|trade-?offs?|versus|vs\.?|optimi[sz]e|calculate|derive|estimate|explain|analy[sz]e|debug|troubleshoot|which is better|pros and cons)\b/gi;

// Part numbers: letters and digits mixed, e.g. BME280, STM32H743ZI, NEO-M8N, TP4056, SN65HVD230.
const PART_NUMBER = /^(?=[A-Za-z0-9-]{4,24}$)(?=.*\d)(?=.*[A-Za-z]{2})[A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)*$/;
const NOT_A_PART = /^(?:\d+(?:v|mv|ma|ua|mah|hz|khz|mhz|ghz|w|kw|mm|cm|kb|mb|gb|bit|s|ms|c)|i2c|i2s|rs485|rs422|usb\d?|ddr\d|ip\d\d|v\d+|\d+x|x\d+|[45]g|nb-iot|lte-m|cat-m1?|wi-fi|aec-q\d+|sil\d)$/i;

// Voltages: "12V", "3.3 V", "5 v", "24VDC".
const VOLTAGE = /\b(\d{1,3}(?:\.\d{1,2})?)\s?v(?:dc|ac)?\b/gi;

// "4x", "x4", "four", "20 modules": counted near a block word.
const WORD_NUMBERS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, sixteen: 16, twenty: 20 };

const clamp = (n: number, max: number): number => Math.max(0, Math.min(max, n));

function lengthPoints(words: number): number {
  if (words <= 25) return 0;
  if (words <= 80) return 5;
  if (words <= 200) return 10;
  if (words <= 500) return 15;
  return 20;
}

/** Largest "N <thing>" quantity in the text (2-64), e.g. "4 servos", "20 modules", "six sensors". */
function largestQuantity(tokens: string[]): number {
  let best = 0;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const raw = tokens[i]!.toLowerCase();
    const n = /^\d{1,2}x?$/.test(raw) ? Number.parseInt(raw, 10) : WORD_NUMBERS[raw] ?? 0;
    if (n < 2 || n > 64) continue;
    // Skip units: "12 V", "5 mA", "3 years".
    const next = tokens[i + 1]!.toLowerCase();
    if (/^(?:v|vdc|vac|ma|ua|a|w|mah|hz|khz|mhz|ms|s|mm|cm|m|bit|bits|years?|days?|hours?|minutes?|seconds?|%|°c|c|channels?)$/.test(next)) continue;
    best = Math.max(best, n);
  }
  return best;
}

export function classifyPrompt(text: string): PromptClassification {
  const input = (text ?? '').slice(0, MAX_CHARS);
  if (!input.trim()) return { difficulty: 'easy', score: 0, signals: [] };

  const doc = nlp.readDoc(input);
  const types = doc.tokens().out(its.type) as string[];
  const tokens = doc.tokens().out() as string[];
  const words = types.filter((t) => t === 'word' || t === 'number').length;
  const sentences = doc.sentences().length();
  const listItems = input.split(/\r?\n/).filter((line) => /^\s*(?:[-*•]|\d{1,2}[.)])\s+\S/.test(line)).length;

  const signals: string[] = [];
  let score = 0;

  const len = lengthPoints(words);
  score += len;
  if (len >= 10) signals.push(`${words} words`);

  const requirements = Math.max(sentences, listItems);
  const reqPoints = clamp((requirements - 2) * 1.5, 10);
  score += reqPoints;
  if (requirements >= 5) signals.push(`${requirements} separate requirements`);

  const parts = new Set(
    tokens.filter((t) => PART_NUMBER.test(t) && !NOT_A_PART.test(t)).map((t) => t.toUpperCase()),
  );
  const blocks = BLOCKS.filter((b) => b.re.test(input)).map((b) => b.label);
  // A kind of block (sensor, GPS, storage…) is more work than one more part number.
  score += clamp(parts.size * 2 + blocks.length * 3.5, 25);
  if (parts.size > 0) signals.push(`${parts.size} part number${parts.size === 1 ? '' : 's'} named`);
  if (blocks.length >= 3) signals.push(`${blocks.length} kinds of block (${blocks.slice(0, 4).join(', ')}${blocks.length > 4 ? ', …' : ''})`);

  const interfaces = INTERFACES.filter((i) => i.re.test(input));
  const heavy = interfaces.filter((i) => i.heavy);
  score += clamp(interfaces.length * 2.5 + heavy.length * 3, 15);
  if (interfaces.length >= 3) signals.push(`${interfaces.length} interfaces`);
  if (heavy.length > 0) signals.push(`field or high-speed bus: ${heavy.map((i) => i.label).join(', ')}`);

  const volts = new Set([...input.matchAll(VOLTAGE)].map((m) => Number.parseFloat(m[1]!)));
  const powerBlocks = ['battery', 'power conversion'].filter((b) => blocks.includes(b)).length;
  score += clamp(Math.max(0, volts.size - 1) * 3 + powerBlocks * 2, 10);
  if (volts.size >= 2) signals.push(`${volts.size} voltage levels`);

  const constraints = CONSTRAINTS.filter((c) => c.re.test(input)).map((c) => c.label);
  score += clamp(constraints.length * 4, 15);
  if (constraints.length > 0) signals.push(`constraints: ${constraints.join(', ')}`);

  const quantity = largestQuantity(tokens);
  score += clamp(quantity >= 3 ? quantity / 2 : 0, 10);
  if (quantity >= 3) signals.push(`quantity ${quantity}`);

  const reasoning = new Set((input.match(REASONING) ?? []).map((m) => m.toLowerCase()));
  score += clamp(reasoning.size * 3, 9);
  if (reasoning.size > 0) signals.push(`asks for reasoning (${[...reasoning].slice(0, 3).join(', ')})`);

  const rounded = Math.round(clamp(score, 100));
  const difficulty: PromptDifficulty =
    rounded >= DIFFICULTY_THRESHOLDS.hard ? 'hard' : rounded >= DIFFICULTY_THRESHOLDS.medium ? 'medium' : 'easy';
  return { difficulty, score: rounded, signals };
}
