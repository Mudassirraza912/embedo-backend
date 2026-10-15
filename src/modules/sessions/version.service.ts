import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { SessionStatus } from './session-status.js';

/**
 * Version tags are a pure function of the version number: v1.0, v1.1, v1.2 ...
 * (tag = `v1.${number - 1}`). Uniqueness is guaranteed by @@unique([sessionId, versionNumber]).
 */
export const versionTagFor = (versionNumber: number): string => `v1.${versionNumber - 1}`;

/**
 * How a revision reaches the design. `auto`: saved as the next version straight away. `manual`:
 * saved as a proposal (design_proposals) with a "Proposed change" card in the chat, and becomes a
 * version only when the user approves it. A project's first design is always applied.
 */
export const APPLY_MODES = ['auto', 'manual'] as const;
export type ApplyMode = (typeof APPLY_MODES)[number];

/** Mirrors design_proposals_status_check. */
export const PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'outdated'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** Stands in for the version tag in a proposal's version card until it is approved. */
export const VERSION_TAG_PLACEHOLDER = '{{versionTag}}';

/** The version tag stored on a design (architecture.versionTag), or null. */
export const versionTagOf = (architecture: unknown): string | null => {
  const tag = architecture && typeof architecture === 'object' ? (architecture as { versionTag?: unknown }).versionTag : null;
  return typeof tag === 'string' ? tag : null;
};

/** The design moved on since a proposal was built, so it can no longer be applied. */
export class StaleProposalError extends Error {
  constructor(public readonly currentVersionTag: string | null) {
    super(`The design is now at ${currentVersionTag ?? 'another version'}`);
  }
}

type Tx = Prisma.TransactionClient;

/** Updates the status shown on a proposal's chat card (metadata.pendingChange.status). */
async function setCardStatus(tx: Tx, messageId: string | null, status: ProposalStatus, extra: Record<string, unknown>) {
  if (!messageId) return;
  const message = await tx.chatMessage.findUnique({ where: { id: messageId }, select: { metadata: true } });
  const metadata = (message?.metadata ?? {}) as Record<string, unknown>;
  const pending = (metadata.pendingChange ?? {}) as Record<string, unknown>;
  await tx.chatMessage.update({
    where: { id: messageId },
    data: { metadata: { ...metadata, pendingChange: { ...pending, status, ...extra } } as Prisma.InputJsonValue },
  });
}

/** Sets a proposal's status and its card's, in the caller's transaction. */
export async function settleProposal(tx: Tx, proposalId: string, status: ProposalStatus, extra: { versionTag?: string } = {}) {
  const proposal = await tx.designProposal.update({
    where: { id: proposalId },
    data: { status, decidedAt: new Date(), ...(extra.versionTag ? { versionTag: extra.versionTag } : {}) },
    select: { messageId: true },
  });
  await setCardStatus(tx, proposal.messageId, status, extra);
}

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
  /** Save only while the design is still at this version (approving a proposal); else StaleProposalError. */
  expectedVersionTag?: string | null;
  /** The proposal being approved: marked approved with the new tag. */
  approvedProposalId?: string;
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

      if (params.expectedVersionTag !== undefined) {
        const current = await tx.designSession.findUnique({ where: { id: params.sessionId }, select: { architecture: true } });
        const tag = versionTagOf(current?.architecture);
        if (tag !== params.expectedVersionTag) throw new StaleProposalError(tag);
      }

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

      // A new version makes every other pending proposal outdated: it was built on a design that
      // is no longer the current one.
      if (params.approvedProposalId) await settleProposal(tx, params.approvedProposalId, 'approved', { versionTag });
      const pending = await tx.designProposal.findMany({ where: { sessionId: params.sessionId, status: 'pending' }, select: { id: true } });
      for (const p of pending) await settleProposal(tx, p.id, 'outdated');

      return { versionId: version.id, versionNumber, versionTag };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 }
  );
}

export interface ProposeVersionParams extends PersistVersionParams {
  buildChatMessage: (versionTag: string) => { content: string; metadata?: Record<string, unknown> };
  /** The version the proposal was built on. */
  baseVersionTag: string | null;
  /** The "Proposed change" chat card; `pendingChange` (proposalId, status, base) is added to its metadata. */
  proposalCard: { content: string; metadata?: Record<string, unknown>; pendingChange?: Record<string, unknown> };
}

/**
 * Saves a revision as a pending proposal instead of a version: the design is untouched, the full
 * proposed design is kept in design_proposals, and the chat gets the "Proposed change" card. The
 * version card (with VERSION_TAG_PLACEHOLDER) is kept for when it is approved.
 */
export async function proposeVersion(params: ProposeVersionParams): Promise<{ proposalId: string }> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT id FROM design_sessions WHERE id = ${params.sessionId}::uuid FOR UPDATE`;
      const proposal = await tx.designProposal.create({
        data: {
          sessionId: params.sessionId,
          baseVersionTag: params.baseVersionTag,
          changeSummary: params.changeSummary,
          appliedChanges: params.appliedChanges,
          designGraph: params.designGraph as Prisma.InputJsonValue,
          architecture: params.architecture as Prisma.InputJsonValue,
          card: params.buildChatMessage(VERSION_TAG_PLACEHOLDER) as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      const message = await tx.chatMessage.create({
        data: {
          sessionId: params.sessionId,
          role: 'assistant',
          content: params.proposalCard.content,
          metadata: {
            ...(params.proposalCard.metadata ?? {}),
            pendingChange: { ...(params.proposalCard.pendingChange ?? {}), proposalId: proposal.id, status: 'pending', baseVersionTag: params.baseVersionTag },
          } as Prisma.InputJsonValue,
        },
        select: { id: true },
      });
      await tx.designProposal.update({ where: { id: proposal.id }, data: { messageId: message.id } });
      if (params.sessionStatus) await tx.designSession.update({ where: { id: params.sessionId }, data: { status: params.sessionStatus } });
      return { proposalId: proposal.id };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 }
  );
}

/** Chat text of a "Proposed change" card. */
export function proposalCardText(baseVersionTag: string | null, changes: string[], extra: string[] = []): string {
  return [
    '📝 **Proposed change — not applied yet**',
    '',
    `Built on ${baseVersionTag ?? 'the current design'}. Approve it to save it as the next version, or reject it to keep the design as it is.`,
    '',
    changes.length > 0 ? `**What will change**\n${changes.map((c) => `- ${c}`).join('\n')}` : null,
    ...extra,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** The stored version card with the real tag in place of the placeholder. */
export function fillVersionCard(card: unknown, versionTag: string): { content: string; metadata?: Record<string, unknown> } {
  return JSON.parse(JSON.stringify(card).split(VERSION_TAG_PLACEHOLDER).join(versionTag)) as { content: string; metadata?: Record<string, unknown> };
}
