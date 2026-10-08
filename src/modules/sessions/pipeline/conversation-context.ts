import { isGibberishOrSpam } from './sufficiency-gate.js';

export interface ConversationContextTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: unknown;
}

export interface RecoveredConversationContext {
  intentText: string;
  history: ConversationContextTurn[];
}

/**
 * Recover a usable project brief after an opening turn was rejected. Rejected exchanges are
 * identified from the assistant metadata, while valid hardware requests and their answers remain
 * available to intent extraction on every clarification retry.
 */
export function recoverConversationContext(
  turns: ConversationContextTurn[],
  originalIntentText: string
): RecoveredConversationContext {
  const rejectedIndexes = new Set<number>();

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    if (turn?.role !== 'assistant') continue;

    const metadata = (turn.metadata ?? {}) as { isGibberish?: unknown; isOffTopic?: unknown };
    if (metadata.isGibberish !== true && metadata.isOffTopic !== true) continue;

    rejectedIndexes.add(index);
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      if (turns[previous]?.role === 'user') {
        rejectedIndexes.add(previous);
        break;
      }
    }
  }

  if (isGibberishOrSpam(originalIntentText)) {
    const openingUserIndex = turns.findIndex((turn) => turn.role === 'user' && turn.content === originalIntentText);
    if (openingUserIndex >= 0) rejectedIndexes.add(openingUserIndex);
  }

  const history = turns.filter((_, index) => !rejectedIndexes.has(index));
  const firstUsableBrief = history.find((turn) => turn.role === 'user' && turn.content.trim());

  return {
    intentText: firstUsableBrief?.content.trim() || originalIntentText,
    history,
  };
}
