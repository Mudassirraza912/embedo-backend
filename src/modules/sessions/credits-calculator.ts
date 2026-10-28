import { prisma } from '../../db/prisma.js';
import { guestQuotaService } from '../limits/guest-quota.service.js';
import { limitsService } from '../limits/limits.service.js';

export interface SessionCreditsStatus {
  used: number;
  limit: number;
  remaining: number;
  resetAt: string | null;
  unit: 'credits';
}

export interface GenerationCreditUsage {
  consumed: number;
  remaining: number;
  limit: number;
  isFree: boolean;
  freeReason?: string;
  operationType: string;
  operationId: string;
}

/**
 * Counts user messages that represent billable operations (excludes failures and refunded actions).
 */
export function countBillableUserMessages(messages: Array<{ role: string; metadata?: unknown }>): number {
  return messages.filter((m) => {
    if (m.role !== 'user') return false;
    const meta = m.metadata as Record<string, unknown> | null;
    if (meta?.failure === true || meta?.refunded === true) return false;
    return true;
  }).length;
}

/**
 * Calculates server-authoritative credit status for a specific design session.
 * For guests, uses IP-based quota tracking when available, falling back to session messages.
 * For authenticated users, uses plan limits with real-time billable message accounting.
 */
export async function calculateCreditsForSession(
  session: { id?: string; userId?: string | null; chatMessages?: Array<{ role: string; metadata?: unknown }> },
  ipAddress?: string
): Promise<SessionCreditsStatus> {
  const isGuest = !session.userId;

  if (isGuest) {
    if (ipAddress) {
      try {
        const guestStatus = await guestQuotaService.status(ipAddress);
        return guestStatus;
      } catch {
        // Fall back to message-based counting if redis/IP check fails
      }
    }

    const { limits } = await limitsService.forGuest();
    let messages = session.chatMessages;
    if (!messages && session.id) {
      messages = await prisma.chatMessage.findMany({
        where: { sessionId: session.id },
        select: { role: true, metadata: true },
      });
    }

    const used = countBillableUserMessages(messages || []);
    return {
      used,
      limit: limits.messagesPerSession,
      remaining: Math.max(0, limits.messagesPerSession - used),
      resetAt: null,
      unit: 'credits',
    };
  }

  // Authenticated user
  const { limits } = await limitsService.forUser(session.userId!);
  let messages = session.chatMessages;
  if (!messages && session.id) {
    messages = await prisma.chatMessage.findMany({
      where: { sessionId: session.id },
      select: { role: true, metadata: true },
    });
  }

  const used = countBillableUserMessages(messages || []);
  return {
    used,
    limit: limits.messagesPerSession,
    remaining: Math.max(0, limits.messagesPerSession - used),
    resetAt: null,
    unit: 'credits',
  };
}

