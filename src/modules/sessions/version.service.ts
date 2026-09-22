import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { SessionStatus } from './session-status.js';

/**
 * Version tags are a pure function of the version number: v1.0, v1.1, v1.2 ...
 * (tag = `v1.${number - 1}`). Uniqueness is guaranteed by @@unique([sessionId, versionNumber]).
 */
export const versionTagFor = (versionNumber: number): string => `v1.${versionNumber - 1}`;

export interface PersistVersionParams {
  sessionId: string;
  designGraph: unknown;
  architecture: unknown;
  changeSummary: string;
  appliedChanges: string[];
  /** When provided, the session status is updated in the same transaction. */
  sessionStatus?: SessionStatus;
  /** Optional assistant chat message written atomically with the snapshot. */
  buildChatMessage?: (versionTag: string) => { content: string; metadata?: Record<string, unknown> };
}

export interface PersistVersionResult {
  versionId: string;
  versionNumber: number;
  versionTag: string;
}

/**
 * Atomically writes a new version snapshot for a session.
 *
 * The session row is locked (SELECT ... FOR UPDATE) for the duration of the transaction, so
 * concurrent writers (pipeline runs, rollbacks) are serialized per session and the
 * count-then-insert version numbering can never collide.
 */
export async function persistNewVersion(params: PersistVersionParams): Promise<PersistVersionResult> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT id FROM design_sessions WHERE id = ${params.sessionId}::uuid FOR UPDATE`;

      const previousCount = await tx.sessionVersion.count({ where: { sessionId: params.sessionId } });
      const versionNumber = previousCount + 1;
      const versionTag = versionTagFor(versionNumber);

      const architectureWithTag =
        params.architecture && typeof params.architecture === 'object'
          ? { ...(params.architecture as Record<string, unknown>), versionTag }
          : params.architecture;

      await tx.designSession.update({
        where: { id: params.sessionId },
        data: {
          ...(params.sessionStatus ? { status: params.sessionStatus } : {}),
          designGraph: params.designGraph as Prisma.InputJsonValue,
          architecture: architectureWithTag as Prisma.InputJsonValue,
        },
      });

      const version = await tx.sessionVersion.create({
        data: {
          sessionId: params.sessionId,
          versionNumber,
          versionTag,
          changeSummary: params.changeSummary,
          appliedChanges: params.appliedChanges,
          designGraph: params.designGraph as Prisma.InputJsonValue,
          architecture: architectureWithTag as Prisma.InputJsonValue,
        },
      });

      if (params.buildChatMessage) {
        const msg = params.buildChatMessage(versionTag);
        await tx.chatMessage.create({
          data: {
            sessionId: params.sessionId,
            role: 'assistant',
            content: msg.content,
            metadata: (msg.metadata ?? {}) as Prisma.InputJsonValue,
          },
        });
      }

      return { versionId: version.id, versionNumber, versionTag };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 }
  );
}
