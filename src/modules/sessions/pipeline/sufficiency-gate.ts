import { StructuredIntent } from './types.js';

export interface SufficiencyResult {
  sufficient: boolean;
  missingFields: string[];
  clarificationQuestions: string[];
  suggestedDefaults?: Record<string, string>;
  isGibberish?: boolean;
}

/**
 * Heuristic detector for spam, repetitive keyboard mashing, and non-sensical strings
 * (e.g., "asdasdasdasdasd", "qwertyuiop", "aaaaaa", "111111").
 */
export function isGibberishOrSpam(text: string): boolean {
  if (!text || text.trim().length === 0) return true;
  const clean = text.trim().toLowerCase();

  // 1. Minimum character length
  if (clean.length < 3) return true;

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
  if (alphaChars.length >= 6) {
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

  // 1. Device Type & Purpose Check
  if (
    !intent.deviceType ||
    intent.deviceType.trim().length < 3 ||
    intent.deviceType.toLowerCase() === 'device' ||
    isGibberishOrSpam(intent.deviceType)
  ) {
    missingFields.push('deviceType');
    clarificationQuestions.push('What specific type of embedded device or product are you building?');
  }

  // 2. Subsystem Check: Must have at least one functional subsystem
  const hasSubsystem = Object.values(intent.subsystems || {}).some(
    (arr) => Array.isArray(arr) && arr.length > 0
  );
  if (!hasSubsystem && (!intent.purpose || intent.purpose.trim().length < 10 || isGibberishOrSpam(intent.purpose))) {
    missingFields.push('subsystems');
    clarificationQuestions.push(
      'What sensors, actuators, displays, or connectivity interfaces (e.g., BLE, Wi-Fi, LoRa, I2C, SPI) should be included?'
    );
  }

  // 3. Power Source Check — BLOCKING.
  // Power source determines the entire power tree (battery chemistry/voltage vs USB vs mains
  // produce structurally different designs), so a missing one is a clarification, not a guess.
  // See PRD §6.11: "Portable environmental monitor with temperature, humidity, CO2 sensing and BLE
  // connectivity" names sensing and connectivity but never confirms how it is powered.
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

    missingFields.push('powerSource');
    if (isPortable) {
      suggestedDefaults['powerSource'] = '3.7V LiPo Battery with USB-C Charging (BQ25186 / TP4056)';
      clarificationQuestions.push(
        'How is this device powered? It reads as portable — should I assume a rechargeable 3.7V LiPo with USB-C charging, or do you need disposable cells (e.g. CR2032/AA)? Roughly how long should it run between charges?'
      );
    } else {
      suggestedDefaults['powerSource'] = 'USB-C 5V Bus / 3.3V LDO';
      clarificationQuestions.push(
        'How is this device powered — USB-C 5V, a DC supply (e.g. 12V/24V), mains AC, or a battery? This determines the regulation and protection stage.'
      );
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

