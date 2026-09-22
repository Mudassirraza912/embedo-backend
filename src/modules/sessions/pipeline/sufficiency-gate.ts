import { StructuredIntent } from './types.js';

export interface SufficiencyResult {
  sufficient: boolean;
  missingFields: string[];
  clarificationQuestions: string[];
  suggestedDefaults?: Record<string, string>;
  isGibberish?: boolean;
  isOffTopic?: boolean;
}

/**
 * Shared with sessions.service.ts (the zero-cost heuristic short-circuit at session creation)
 * so both the pre-Luna and post-Luna off-topic paths produce the identical, on-brand message.
 */
/** Sent instead of a generated architecture while GENERATION_ENABLED=false (see env.ts). */
export const GENERATION_HOLD_MESSAGE =
  'Your request looks good — architecture synthesis Work is in Progress and will available shortly';

export const OFF_TOPIC_CLARIFICATION =
  "Embedo.ai is focused specifically on embedded hardware architecture, so I'm not able to help with that. Describe an embedded product or concept you'd like to design — e.g. \"Battery-powered BLE asset tracker with GPS and accelerometer\" or \"Smart greenhouse environmental monitor with Wi-Fi and OLED display\" — and I'll get started.";

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
 * Zero-cost heuristic for common non-hardware chit-chat (date/time, weather, greetings, mic
 * testing, generic "how do I..." requests). Distinct from isGibberishOrSpam: this text is
 * grammatically valid, just outside the product's scope. Embedo only synthesizes embedded
 * hardware architectures, so these are caught here — before a Luna call is even made — with a
 * dedicated, on-brand "this isn't what I do" message, instead of spending a call only to land on
 * the same generic power-source/subsystem clarification questions a genuine but underspecified
 * hardware request would get.
 */
export function isOffTopicChat(text: string): boolean {
  if (!text) return false;
  const clean = text.trim().toLowerCase();
  if (clean.length === 0) return false;

  const patterns = [
    /\bwhat(?:'s|\s+is)?\s+(?:today'?s\s+)?(?:the\s+)?(?:date|day)\b/,
    /\bwhat\s+day\s+(?:is\s+it\s+)?today\b/,
    /\bwhat\s+time\s+is\s+it\b/,
    /\bcurrent\s+time\b/,
    /\bweather\b/,
    /\byoutube\s+channel\b/,
    /\bhow\s+(?:can|do)\s+i\s+make\s+money\b/,
    /\bwrite\s+(?:me\s+)?(?:a|an)\s+(?:poem|song|essay|story|joke)\b/,
    /\btell\s+me\s+a\s+joke\b/,
    /\bwho\s+(?:are|r)\s+you\b/,
    /\bwhat(?:'s| is)\s+your\s+name\b/,
    /\brecipe\s+for\b/,
  ];
  if (patterns.some((p) => p.test(clean))) return true;

  // Standalone greetings / mic-testing / filler with nothing else attached — kept as a
  // whole-string match (not a substring test) so it never flags a real hardware description
  // that happens to contain "test" (e.g. "battery load test fixture", "EMI test chamber").
  const standaloneChitChat =
    /^(?:hi|hello|hey|yo|sup|test|testing|mic\s*test(?:ing)?|test\s*test|testing\s*testing|hello\s*world|how\s*are\s*you)[.!?]*$/;
  if (standaloneChitChat.test(clean)) return true;

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

  // 0b. Off-topic check — catches non-hardware chit-chat that slipped past the zero-cost
  // heuristic (sessions.service.ts) because it's more elaborate than a short pattern match, but
  // that Luna itself has now classified (from the SAME intent-parse call, no added cost) as not
  // being an embedded hardware request at all.
  if ((rawInputText && isOffTopicChat(rawInputText)) || intent.isOffTopic) {
    return {
      sufficient: false,
      missingFields: ['deviceType', 'purpose', 'subsystems'],
      clarificationQuestions: [OFF_TOPIC_CLARIFICATION],
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

