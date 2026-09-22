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

const tier3Schema = z.object({
  flagged: z.boolean(),
  category: z.string().max(100).default('none'),
  reason: z.string().max(500).default(''),
});

const TIER3_SYSTEM_PROMPT = `You are a strict safety classifier for an embedded-hardware design assistant.
Classify whether the user's request asks for hardware whose primary purpose is clearly harmful or illegal:
- weapons, munitions, explosive or incendiary triggers/detonators
- devices for covert, unauthorized surveillance, wiretapping or interception of others
- RF jamming, GPS/cellular/Wi-Fi disruption, deauthentication attack hardware
- skimmers, cloners, lock/alarm bypass devices, or tools intended for theft or unauthorized access
- hardware to cause physical harm or evade law enforcement

Legitimate engineering language is NOT harmful: "kill switch", "tamper detection", "lock controller", "RFID reader", "intrusion alarm", "motor driver", "security camera", "signal generator", "RF module", "jam detection". Only flag clear, intentional misuse.

Respond ONLY with JSON: {"flagged": boolean, "category": string, "reason": string}`;

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
    try {
      const result = await aiRouterService.executeTask({
        taskCase: 'M',
        systemPrompt: TIER3_SYSTEM_PROMPT,
        userPrompt: text.slice(0, 4000),
        sessionId,
        temperature: 0,
        maxTokens: 200,
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

    // Tier 2
    let tier2: { flagged: boolean; category?: string } | null = null;
    try {
      tier2 = await this.checkTier2(text);
    } catch {
      if (this.failMode() === 'closed') {
        return {
          allowed: false,
          flaggedTier: 'provider_api',
          category: 'moderation_unavailable',
          reason: 'Content screening is temporarily unavailable. Please try again shortly.',
        };
      }
      logger.warn({ actor }, 'Tier 2 moderation unavailable — allowing (MODERATION_FAIL_MODE=open)');
    }
    if (tier2?.flagged) {
      const reason = `Content flagged for policy violations: ${tier2.category}`;
      await this.handleViolation({ ...actor, tier: 'provider_api', category: tier2.category || 'general_policy', flaggedText: text, reason });
      return { allowed: false, flaggedTier: 'provider_api', category: tier2.category, reason };
    }

    // Tier 3
    let tier3: { flagged: boolean; category?: string; reason?: string } | null = null;
    try {
      tier3 = await this.checkTier3(text, actor.sessionId);
    } catch {
      if (this.failMode() === 'closed') {
        return {
          allowed: false,
          flaggedTier: 'domain_classifier',
          category: 'moderation_unavailable',
          reason: 'Content screening is temporarily unavailable. Please try again shortly.',
        };
      }
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

function safeJson(text: string): unknown {
  try {
    return JSON.parse(stripJsonFences(text));
  } catch {
    return undefined;
  }
}

export const moderationService = new ModerationService();
