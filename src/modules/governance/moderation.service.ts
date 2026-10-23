import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { redis } from '../../db/redis.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/AppError.js';
import { userSuspensionKey } from '../../common/middlewares/auth.middleware.js';
import { HARDWARE_POLICY_RULES, BannedTermRule } from './banned-terms.js';
import { modelProviderService } from '../ai/model-provider.service.js';
import { aiRouterService } from '../ai/ai-router.service.js';
import { stripJsonFences } from '../sessions/pipeline/json-utils.js';

export type ModerationTier = 'wordlist' | 'provider_api' | 'domain_classifier';

export interface ModerationResult {
  allowed: boolean;
  flaggedTier?: ModerationTier;
  category?: string;
  reason?: string;
}

export interface ModerationActor {
  userId?: string;
  anonIdentifier?: string;
  sessionId?: string;
}

// Text fields are trimmed, never a reason to fail screening: with the Anthropic fallback a long
// "reason" ran into the token cap and every long brief got 503 "screening unavailable" (dev,
// 2026-10-15, a 2,441-character brief).
const clipped = (max: number, fallback: string) =>
  z.preprocess((v) => (typeof v === 'string' ? v.slice(0, max) : v), z.string().max(max).default(fallback));
const tier3Schema = z.object({
  flagged: z.boolean(),
  category: clipped(100, 'none'),
  reason: clipped(500, ''),
});

const TIER3_SYSTEM_PROMPT = `You are a strict safety classifier for an embedded-hardware design assistant.
Classify whether the user's request asks for hardware whose primary purpose is clearly harmful or illegal:
- weapons, munitions, explosive or incendiary triggers/detonators
- devices for covert, unauthorized surveillance, wiretapping or interception of others
- RF jamming, GPS/cellular/Wi-Fi disruption, deauthentication attack hardware
- skimmers, cloners, lock/alarm bypass devices, or tools intended for theft or unauthorized access
- hardware to cause physical harm or evade law enforcement

MANDATORY RULES:
1. Conversational commands, design iterations, follow-ups, and instructions (e.g. "add all of these", "add these", "add recommended modules", "recommend some module", "add 30 more modules", "proceed", "yes", "implement this", "make changes", "update design") are standard user interactions and MUST NEVER be flagged as harmful or illegal.
2. Standard industrial, environmental, automotive, medical, agricultural, and IoT sensors/modules (gas/air quality sensors such as MQ-2/MQ-7/MQ-135, particulate sensors, humidity/temp sensors like DHT22/BME280/SHT40, optical/magnetic rotary encoders, Hall effect limit sensors, PID controllers, motor drivers, relays, solenoids, load cells, CAN/RS-485 transceivers, battery management ICs) are normal engineering components and MUST NEVER be flagged.
3. Legitimate engineering language is NOT harmful: "kill switch", "tamper detection", "lock controller", "RFID reader", "intrusion alarm", "motor driver", "security camera", "signal generator", "RF module", "jam detection". Only flag clear, intentional, undeniable misuse.
4. Legitimate consumer personal care, massage, and adult wellness devices (e.g. vibrators, personal massagers, pelvic floor trainers, kegel exercise sensors, haptic wellness products) are legal electromechanical consumer electronics (involving vibration motors, haptic drivers, Li-ion charging, microcontrollers, BLE, waterproof enclosures) and MUST NEVER be flagged as harmful hardware misuse. However, any content involving minors or child sexual exploitation remains strictly prohibited.

Respond ONLY with JSON: {"flagged": boolean, "category": string, "reason": string}. Keep "reason" under 25 words.`;

/**
 * Detects short conversational follow-ups (e.g. "add all of these", "proceed", "yes please",
 * "recommend some module", "add 30 more modules"). These are conversational commands that refer
 * to previous context and never constitute standalone hardware misuse. Skipping Tier 3 eliminates
 * out-of-context classifier hallucinations and saves ~1.5s per turn.
 */
export function isBenignConversationalFollowUp(text: string): boolean {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length <= 12 && trimmed.length <= 80) {
    const SUSPICIOUS_PATTERN =
      /\b(bomb|weapon|gun|missile|explosiv|detonat|ied|jammer|jamming|disrupt|skimmer|cloner|wiretap|eavesdrop|spy|surveillance|hack|bypass|tamper|theft|lethal|deauth|attack)\b/i;
    if (!SUSPICIOUS_PATTERN.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Detects legitimate adult wellness, personal care, and intimate electromechanical hardware.
 * Examples: vibrators, intimate massagers, pelvic floor trainers, kegel exercise sensors,
 * clitoral stimulators, haptic adult wellness devices.
 *
 * CRITICAL SAFETY RULE: Any mention of minors, children, underage, or child exploitation
 * MUST NEVER be considered legitimate wellness hardware and will immediately return false.
 */
export function isAdultWellnessHardware(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  const clean = text.toLowerCase();

  // Non-negotiable safety guardrail: any reference to minors, children, school age, or exploitation
  const MINOR_SAFETY_PATTERN =
    /\b(little\s+girl|young\s+girl|school\s*girl|underage|minor|child|children|infant|baby|toddler|pedophil|paedophil|teenager|teen\b)/i;
  if (MINOR_SAFETY_PATTERN.test(clean)) {
    return false;
  }

  // Adult wellness / personal care / intimate electromechanical hardware keywords
  const WELLNESS_PATTERN =
    /\b(vibrat(or|ion|ing|ors)?|dildo|fleshlight|masturbat(or|ion|ors)?|intimate\s+(massag(er|e)|wellness|device|appliance|toy)|personal\s+massag(er|e)|kegel|pelvic\s+floor|clitoral(\s+suction|\s+stimulat(or|ion))?|prostate\s+massag(er|e)|adult\s+(wellness|toy|product)|sexual\s+wellness|sex\s+toy)\b/i;

  return WELLNESS_PATTERN.test(clean);
}

/**
 * Three-tier governance:
 *  1. Deterministic wordlist (free, sub-ms)
 *  2. Provider moderation API (hate/violence/sexual/self-harm)
 *  3. Domain classifier for hardware-specific misuse (Case M via the model router)
 *
 * Strikes are counted in a rolling window; exceeding the limit suspends the actor for
 * MODERATION_SUSPENSION_SECONDS (users AND anonymous actors). Permanent bans remain a manual
 * action via users.suspendedAt.
 */
export class ModerationService {
  private checkTier1(text: string): BannedTermRule | null {
    for (const rule of HARDWARE_POLICY_RULES) {
      if (rule.pattern.test(text)) return rule;
    }
    return null;
  }

  private failMode(): 'open' | 'closed' {
    return env.MODERATION_FAIL_MODE;
  }

  private async checkTier2(text: string): Promise<{ flagged: boolean; category?: string } | null> {
    try {
      const result = await modelProviderService.moderate(text);
      if (!result) return null; // provider not configured
      return { flagged: result.flagged, category: result.categories.join(', ') };
    } catch (err) {
      logger.error({ err }, 'Tier 2 moderation provider call failed');
      throw err;
    }
  }

  private async checkTier3(text: string, sessionId?: string): Promise<{ flagged: boolean; category?: string; reason?: string } | null> {
    if (!env.MODERATION_TIER3_ENABLED) return null;
    if (isBenignConversationalFollowUp(text)) {
      return { flagged: false, category: 'none', reason: '' };
    }
    try {
      const result = await aiRouterService.executeTask({
        taskCase: 'M',
        systemPrompt: TIER3_SYSTEM_PROMPT,
        userPrompt: text.slice(0, 6000),
        sessionId,
        temperature: 0,
        maxTokens: 500,
        jsonMode: true,
        validateResponse: (t) => tier3Schema.safeParse(safeJson(t)).success,
      });
      const parsed = tier3Schema.safeParse(safeJson(result.content));
      if (!parsed.success) {
        await aiRouterService.markSchemaResult(result.aiCallId, false, parsed.error.message);
        throw new Error('Tier 3 classifier returned an invalid response');
      }
      return parsed.data;
    } catch (err) {
      logger.error({ err }, 'Tier 3 moderation classifier failed');
      throw err;
    }
  }

  /** Whether an actor is currently under a temporary suspension. */
  async isSuspended(actor: ModerationActor): Promise<boolean> {
    const keys = [
      actor.userId ? userSuspensionKey(actor.userId) : null,
      actor.anonIdentifier ? this.anonSuspensionKey(actor.anonIdentifier) : null,
    ].filter((k): k is string => k !== null);
    if (keys.length === 0) return false;
    try {
      const values = await redis.mget(...keys);
      return values.some((v) => v !== null);
    } catch (err) {
      logger.warn({ err }, 'Could not check suspension state in Redis');
      return false;
    }
  }

  private anonSuspensionKey(anonIdentifier: string): string {
    return `mod:suspend:anon:${anonIdentifier}`;
  }

  /**
   * Screens text through all tiers. Errors in tiers 2/3 follow MODERATION_FAIL_MODE:
   * 'closed' rejects the request (production default), 'open' allows it and logs loudly.
   */
  async screenText(text: string, actor: ModerationActor, opts: { tier1Only?: boolean } = {}): Promise<ModerationResult> {
    if (!text || text.trim().length === 0) return { allowed: true };

    // Tier 1
    const tier1 = this.checkTier1(text);
    if (tier1) {
      await this.handleViolation({ ...actor, tier: 'wordlist', category: tier1.category, flaggedText: text, reason: tier1.reason });
      return { allowed: false, flaggedTier: 'wordlist', category: tier1.category, reason: tier1.reason };
    }
    if (opts.tier1Only) return { allowed: true };

    // Tiers 2 and 3 screen the same text independently, so they run concurrently: sequentially
    // they added ~1s to every message before the copilot could even start writing. Evaluation
    // order below is unchanged — tier 2 still takes precedence when both flag.
    const [tier2Settled, tier3Settled] = await Promise.allSettled([
      this.checkTier2(text),
      this.checkTier3(text, actor.sessionId),
    ]);

    let tier2: { flagged: boolean; category?: string } | null = null;
    if (tier2Settled.status === 'fulfilled') {
      tier2 = tier2Settled.value;
    } else if (this.failMode() === 'closed') {
      return {
        allowed: false,
        flaggedTier: 'provider_api',
        category: 'moderation_unavailable',
        reason: 'Content screening is temporarily unavailable. Please try again shortly.',
      };
    } else {
      logger.warn({ actor }, 'Tier 2 moderation unavailable — allowing (MODERATION_FAIL_MODE=open)');
    }
    if (tier2?.flagged) {
      const categories = (tier2.category || '').split(',').map((c) => c.trim().toLowerCase());
      const isSolelySexual = categories.length > 0 && categories.every((c) => c === 'sexual');
      const isMinorRelated = categories.some((c) => c.includes('minor') || c.includes('child'));

      // EAR-9: Adult wellness and personal care hardware (e.g. vibrators, intimate massagers)
      // frequently trigger third-party API 'sexual' categories. If the flagged category is solely
      // 'sexual' (without 'sexual/minors' or violence/hate) and the query is legitimate adult wellness
      // hardware, allow it through rather than issuing a content policy block or suspension strike.
      if (isSolelySexual && !isMinorRelated && isAdultWellnessHardware(text)) {
        logger.info(
          { text: text.slice(0, 100), actor: { userId: actor.userId, anonIdentifier: actor.anonIdentifier } },
          'Tier 2 moderation flagged sexual category for adult wellness hardware brief — unblocking per EAR-9 policy'
        );
        tier2 = { flagged: false, category: 'none' };
      }
    }

    if (tier2?.flagged) {
      const reason = `Content flagged for policy violations: ${tier2.category}`;
      await this.handleViolation({ ...actor, tier: 'provider_api', category: tier2.category || 'general_policy', flaggedText: text, reason });
      return { allowed: false, flaggedTier: 'provider_api', category: tier2.category, reason };
    }

    // Tier 3
    let tier3: { flagged: boolean; category?: string; reason?: string } | null = null;
    if (tier3Settled.status === 'fulfilled') {
      tier3 = tier3Settled.value;
    } else if (this.failMode() === 'closed') {
      return {
        allowed: false,
        flaggedTier: 'domain_classifier',
        category: 'moderation_unavailable',
        reason: 'Content screening is temporarily unavailable. Please try again shortly.',
      };
    } else {
      logger.warn({ actor }, 'Tier 3 moderation unavailable — allowing (MODERATION_FAIL_MODE=open)');
    }
    if (tier3?.flagged) {
      const reason = tier3.reason || 'Request classified as harmful hardware misuse.';
      await this.handleViolation({ ...actor, tier: 'domain_classifier', category: tier3.category || 'hardware_misuse', flaggedText: text, reason });
      return { allowed: false, flaggedTier: 'domain_classifier', category: tier3.category, reason };
    }

    return { allowed: true };
  }

  /**
   * Records the violation and escalates strikes in a rolling window for BOTH users and anonymous actors.
   */
  private async handleViolation(params: ModerationActor & { tier: ModerationTier; category: string; flaggedText: string; reason: string }): Promise<void> {
    logger.warn({ tier: params.tier, category: params.category, actor: { userId: params.userId, anonIdentifier: params.anonIdentifier } }, 'Prompt flagged by governance');

    let actionTaken: 'rejected' | 'suspended' = 'rejected';

    // Rolling-window strike counter in Redis; suspension key with its own TTL.
    const strikeKey = params.userId ? `mod:strikes:user:${params.userId}` : params.anonIdentifier ? `mod:strikes:anon:${params.anonIdentifier}` : null;
    if (strikeKey) {
      try {
        const strikes = await redis.incr(strikeKey);
        if (strikes === 1) await redis.expire(strikeKey, env.MODERATION_STRIKE_WINDOW_SECONDS);
        if (strikes >= env.MODERATION_STRIKE_LIMIT) {
          const suspendKey = params.userId ? userSuspensionKey(params.userId) : this.anonSuspensionKey(params.anonIdentifier as string);
          await redis.set(suspendKey, '1', 'EX', env.MODERATION_SUSPENSION_SECONDS);
          await redis.del(strikeKey);
          actionTaken = 'suspended';
          logger.error({ userId: params.userId, anonIdentifier: params.anonIdentifier, strikes }, 'Actor temporarily suspended due to repeated moderation strikes');
        }
      } catch (err) {
        logger.error({ err }, 'Failed to update moderation strike counters in Redis');
      }
    }

    try {
      await prisma.moderationEvent.create({
        data: {
          userId: params.userId || null,
          anonIdentifier: params.anonIdentifier || null,
          sessionId: params.sessionId || null,
          tier: params.tier,
          category: params.category.slice(0, 100),
          flaggedText: params.flaggedText.slice(0, 4000),
          actionTaken,
        },
      });
      if (params.userId) {
        // Lifetime audit counter (never reset); temporary suspension state lives in Redis.
        await prisma.user.update({ where: { id: params.userId }, data: { moderationStrikes: { increment: 1 } } });
      }
    } catch (err) {
      logger.error({ err }, 'Failed to record moderation violation event');
    }
  }

  assertAllowed(result: ModerationResult): void {
    if (!result.allowed) {
      const unavailable = result.category === 'moderation_unavailable';
      throw new AppError(
        unavailable ? 503 : 403,
        unavailable ? 'PROVIDER_UNAVAILABLE' : 'CONTENT_POLICY_VIOLATION',
        result.reason || 'Submitted request violates safety and hardware design content policy',
        { tier: result.flaggedTier, category: result.category }
      );
    }
  }
}

/** The classifier's JSON object, also when a model wraps it in prose. */
export function safeJson(text: string): unknown {
  try {
    return JSON.parse(stripJsonFences(text));
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

export const moderationService = new ModerationService();
