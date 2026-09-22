import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../common/errors/AppError.js';
import { moderationService } from './moderation.service.js';
import { isGibberishOrSpam } from '../sessions/pipeline/sufficiency-gate.js';

/**
 * Screens user-supplied text before it reaches an LLM or is persisted as a session.
 * Mount AFTER validate() so only bounded, validated text is sent to the moderation providers.
 */
export const moderateInput = (textFieldNames: string[] = ['intentText', 'intent_text', 'text', 'content']) => {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const parts: string[] = [];

      for (const field of textFieldNames) {
        const v = body[field];
        if (typeof v === 'string') parts.push(v);
      }

      const messages = body.messages;
      if (Array.isArray(messages)) {
        // Only the newest user turn is new content; earlier turns were screened when submitted.
        const last = messages[messages.length - 1] as { content?: unknown } | undefined;
        if (last && typeof last.content === 'string') parts.push(last.content);
      }

      const actor = {
        userId: req.user?.id,
        anonIdentifier: req.anonSessionToken || req.ip || req.socket.remoteAddress,
        sessionId: typeof req.params?.id === 'string' ? req.params.id : undefined,
      };

      if (await moderationService.isSuspended(actor)) {
        return next(new AppError(403, 'ACCOUNT_SUSPENDED', 'Temporarily suspended due to repeated policy violations. Please try again later.'));
      }

      const textToScreen = parts.join(' ').trim();
      if (textToScreen.length > 0) {
        // Gibberish never reaches an LLM (the sessions service short-circuits it), so only the
        // free deterministic tier is needed — no moderation API spend on keyboard mashing.
        const gibberish = isGibberishOrSpam(textToScreen);
        const result = await moderationService.screenText(textToScreen, actor, { tier1Only: gibberish });
        moderationService.assertAllowed(result);
      }

      next();
    } catch (err) {
      next(err);
    }
  };
};
