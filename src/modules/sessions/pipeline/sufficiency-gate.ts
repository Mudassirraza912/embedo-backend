import { StructuredIntent } from './types.js';

export interface SufficiencyResult {
  sufficient: boolean;
  missingFields: string[];
  clarificationQuestions: string[];
  suggestedDefaults?: Record<string, string>;
  isGibberish?: boolean;
  isOffTopic?: boolean;
}

/** Sent instead of a generated architecture while GENERATION_ENABLED=false (see env.ts). */
export const GENERATION_HOLD_MESSAGE =
  'Your request looks good — architecture synthesis Work is in Progress and will available shortly';

export interface GibberishCheckOptions {
  /**
   * A reply inside an existing conversation rather than an opening brief. Short answers are normal
   * there ("5V", "AC", "no", "2") — often a direct answer to a clarification question — so the
   * minimum-length rule is dropped, and part numbers ("nRF52 + TPS62") skip the vowel-ratio rule.
   */
  conversational?: boolean;
}

/**
 * Heuristic detector for spam, repetitive keyboard mashing, and non-sensical strings
 * (e.g., "asdasdasdasdasd", "qwertyuiop", "aaaaaa", "111111").
 */
export function isGibberishOrSpam(text: string, options: GibberishCheckOptions = {}): boolean {
  if (!text || text.trim().length === 0) return true;
  const clean = text.trim().toLowerCase();
  const conversational = options.conversational === true;

  // 1. Minimum character length for an opening brief; a reply only needs a letter or digit
  if (conversational ? !/[a-z0-9]/.test(clean) : clean.length < 3) return true;

  // 2. Character repetition (e.g. "aaaaa", "asdasdasd")
  if (/(.)\1{4,}/.test(clean)) return true;
  if (/^([a-z0-9]{2,4})\1{3,}$/.test(clean)) return true; // e.g. "asdasdasdasd", "abcdabcdabcd"

  // 3. Known keyboard mash patterns
  const keyboardMashes = ['asdf', 'asdasd', 'qwer', 'zxcv', 'hjkl', '123456', 'testtest'];
  if (keyboardMashes.some((pattern) => clean.includes(pattern) && clean.length <= pattern.length * 4)) {
    return true;
  }

  // 4. Vowel ratio check for Latin strings longer than 6 characters
  const alphaChars = clean.replace(/[^a-z]/g, '');
  if (alphaChars.length >= 6 && !(conversational && /\d/.test(clean))) {
    const vowels = alphaChars.replace(/[^aeiou]/g, '');
    const vowelRatio = vowels.length / alphaChars.length;
    // Unnatural vowel ratios (e.g. zero vowels "sdfghjkl" or all vowels "aaaaeeeee")
    if (vowelRatio < 0.1 || vowelRatio > 0.9) {
      return true;
    }
  }

  return false;
}

/**
 * Sufficiency Gate: Deterministic + heuristic check to ensure hardware requirements
 * have sufficient fidelity before initiating deep Sol-tier architecture synthesis.
 */
export function checkSufficiency(intent: StructuredIntent, rawInputText?: string): SufficiencyResult {
  const missingFields: string[] = [];
  const clarificationQuestions: string[] = [];
  const suggestedDefaults: Record<string, string> = {};

  // 0. Upfront Spam / Gibberish Check on Raw Input or Device Type
  if (rawInputText && isGibberishOrSpam(rawInputText)) {
    return {
      sufficient: false,
      missingFields: ['deviceType', 'purpose', 'subsystems'],
      clarificationQuestions: [
        'The hardware description provided is unclear or incomplete. Please describe an embedded product or concept (e.g. "Battery-powered BLE asset tracker with GPS and accelerometer" or "Smart greenhouse environmental monitor with Wi-Fi and OLED display").',
      ],
      isGibberish: true,
    };
  }

  // 0b. Off-topic: classified by the model during intent parsing (same call, no added cost).
  // Deliberately NOT a keyword check — a static word list rejected real hardware whenever a
  // chit-chat word appeared in it ("solar powered weather station", "YouTube subscriber counter").
  if (intent.isOffTopic) {
    return {
      sufficient: false,
      missingFields: ['deviceType', 'purpose', 'subsystems'],
      // The caller generates a contextual AI response for this case; a fixed rejection string
      // here used to be shown even when the conversation context made the request relevant.
      clarificationQuestions: [],
      isOffTopic: true,
    };
  }

  // 1. Device Type & Purpose Check
  if (
    !intent.deviceType ||
    intent.deviceType.trim().length < 3 ||
    intent.deviceType.toLowerCase() === 'device' ||
    isGibberishOrSpam(intent.deviceType)
  ) {
    missingFields.push('deviceType');
    clarificationQuestions.push('What embedded device or product should this design describe?');
  }

  // 2. Subsystem Check: Must have at least one functional subsystem
  const hasSubsystem = Object.values(intent.subsystems || {}).some(
    (arr) => Array.isArray(arr) && arr.length > 0
  );
  if (!hasSubsystem && (!intent.purpose || intent.purpose.trim().length < 10 || isGibberishOrSpam(intent.purpose))) {
    missingFields.push('subsystems');
    clarificationQuestions.push('Which functions or interfaces are essential for this product?');
  }

  // 3. Power Source Check
  // Portable battery-powered devices require explicit battery runtime/chemistry choices per PRD §6.11.
  // For stationary, equipment, computing, and interface-rich designs that omit explicit power,
  // infer an appropriate engineering-standard power architecture so synthesis can proceed directly without stalling.
  const powerSubsystems = intent.subsystems?.power || [];
  const powerConstraint = intent.constraints?.powerSource;
  const hasExplicitPower = (powerConstraint && powerConstraint.trim().length > 0) || powerSubsystems.length > 0;

  if (!hasExplicitPower) {
    const haystack = `${intent.purpose || ''} ${intent.deviceType || ''} ${rawInputText || ''}`.toLowerCase();
    const isPortable =
      haystack.includes('portable') ||
      haystack.includes('wearable') ||
      haystack.includes('battery') ||
      haystack.includes('handheld') ||
      haystack.includes('tracker');

    // Only block if the device is portable (where battery chemistry/runtime must be decided),
    // OR if the brief has no concrete functional subsystems yet.
    if (isPortable || !hasSubsystem) {
      missingFields.push('powerSource');
      if (isPortable) {
        suggestedDefaults['powerSource'] = '3.7V LiPo Battery with USB-C Charging (BQ25186 / TP4056)';
        clarificationQuestions.push('How will this device be powered, and what runtime should it support?');
      } else {
        suggestedDefaults['powerSource'] = 'USB-C 5V Bus / 3.3V LDO';
        clarificationQuestions.push('How will this device be powered?');
      }
    } else {
      // Inferred power architecture based on general functional domain
      let defaultPower = 'USB-C 5V Bus with 3.3V LDO / Buck Regulator';

      if (haystack.includes('mains') || haystack.includes('ac') || haystack.includes('110v') || haystack.includes('220v') || haystack.includes('240v') || haystack.includes('grid')) {
        defaultPower = '85V-265V AC Mains Input with Isolated Flyback Converter';
      } else if (haystack.includes('auto') || haystack.includes('vehicle') || haystack.includes('car') || haystack.includes('truck') || haystack.includes('ecu') || haystack.includes('obd')) {
        defaultPower = '12V-24V Automotive Battery Input with Load Dump Protection & Synchronous Buck';
      } else if (haystack.includes('poe') || haystack.includes('power over ethernet')) {
        defaultPower = 'IEEE 802.3af/at PoE Isolated 48V to 5V Supply';
      } else if (haystack.includes('solar') || haystack.includes('harvesting')) {
        defaultPower = 'Solar MPPT Harvesting with Supercapacitor / LiFePO4 Storage';
      } else if (
        haystack.includes('industrial') ||
        haystack.includes('plc') ||
        haystack.includes('din') ||
        haystack.includes('rs485') ||
        haystack.includes('can') ||
        haystack.includes('motor') ||
        haystack.includes('valve') ||
        haystack.includes('solenoid') ||
        haystack.includes('equipment') ||
        haystack.includes('machine') ||
        haystack.includes('gateway') ||
        haystack.includes('linux') ||
        haystack.includes('24v')
      ) {
        defaultPower = '12V-24V DC Industrial Supply with Wide-Input Buck Regulator';
      }

      suggestedDefaults['powerSource'] = defaultPower;
      if (!intent.constraints) intent.constraints = {};
      intent.constraints.powerSource = defaultPower;
      if (!intent.subsystems) intent.subsystems = {};
      if (!intent.subsystems.power || intent.subsystems.power.length === 0) {
        intent.subsystems.power = [defaultPower];
      }
    }
  }

  // If there are zero clarifying questions or only soft warnings, consider it sufficient
  const sufficient = clarificationQuestions.length === 0;

  return {
    sufficient,
    missingFields,
    clarificationQuestions,
    suggestedDefaults: Object.keys(suggestedDefaults).length > 0 ? suggestedDefaults : undefined,
  };
}

