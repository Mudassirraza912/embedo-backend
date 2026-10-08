import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/AppError.js';
import { canonicalJson, HardwareUpload, hardwareAdminService, prepareBundle, SaveResult } from './hardware-admin.service.js';

/**
 * Review queue for scraped / machine-sourced hardware (truth file §16). A scraper or vendor agent
 * calls submitProposal(); nothing reaches the library until an admin approves the proposal from
 * the admin panel. Approval runs the same validation, storage and embedding as a direct admin
 * upload. Engineering-sensitive changes are never auto-applied.
 */

export type ProposalSource = 'vendor_agent' | 'user' | 'import' | 'admin';
export type ChangeClass = 'new_entity' | 'non_structural' | 'engineering_sensitive';

/** Blocks whose change alters what can be wired, or how (pins, contacts, rails, buses, artwork). */
const ENGINEERING_BLOCKS = new Set(['pins', 'connectors', 'electrical', 'interfaces', 'dependencies', 'svg']);

type Actor = { userId: string | null; label: string };

async function audit(actor: Actor, action: string, metadata: Record<string, unknown>): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: { actorUserId: actor.userId, action, entityType: 'HardwareChangeProposal', entityId: null, metadata: metadata as Prisma.InputJsonValue },
    });
  } catch (err) {
    logger.warn({ err, action }, 'Failed to write proposal audit log');
  }
}

/** Which top-level record blocks (plus the artwork) differ from the stored entity. */
async function diffAgainstLibrary(upload: HardwareUpload, hardwareEntityId: string | null) {
  if (!hardwareEntityId) return { existing: false, changed: [] as string[] };
  const current = await prisma.hardwareEntity.findUnique({
    where: { hardwareEntityId },
    select: { metadataJson: true, svgAsset: { select: { svgMarkup: true } } },
  });
  if (!current) return { existing: false, changed: [] as string[] };
  const before = current.metadataJson as Record<string, unknown>;
  const after = (upload.record ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [...keys].filter((k) => canonicalJson(before[k]) !== canonicalJson(after[k])).sort();
  if ((current.svgAsset?.svgMarkup ?? '').trim() !== (upload.svg ?? '').trim()) changed.push('svg');
  return { existing: true, changed };
}

const classify = (existing: boolean, changed: string[]): ChangeClass =>
  !existing ? 'new_entity' : changed.some((block) => ENGINEERING_BLOCKS.has(block)) ? 'engineering_sensitive' : 'non_structural';

/** Validate + diff a payload; shared by submit and edit. */
async function evaluate(upload: HardwareUpload) {
  const { bundle, issues } = prepareBundle(upload);
  const proposedId =
    bundle?.hardwareEntityId ??
    (typeof ((upload.record as Record<string, unknown>)?.['identity'] as Record<string, unknown> | undefined)?.['hardware_entity_id'] === 'string'
      ? (((upload.record as Record<string, unknown>)['identity'] as Record<string, unknown>)['hardware_entity_id'] as string)
      : null);
  const { existing, changed } = await diffAgainstLibrary(upload, proposedId);
  return {
    proposedId,
    contentHash: bundle?.contentHash ?? null,
    valid: bundle !== null,
    issues,
    existing,
    changed,
    changeClass: classify(existing, changed),
  };
}

const proposalSelect = {
  proposalId: true,
  hardwareEntityId: true,
  proposedHardwareEntityId: true,
  changeClass: true,
  sourceType: true,
  sourceReference: true,
  status: true,
  validationIssues: true,
  diff: true,
  proposedBy: true,
  proposedAt: true,
  reviewedBy: true,
  reviewedAt: true,
  reviewNotes: true,
} satisfies Prisma.HardwareChangeProposalSelect;

export const hardwareProposalService = {
  /**
   * Entry point for scrapers. An identical pending proposal is returned instead of duplicated.
   * Invalid candidates are still queued (status needs_review) so the admin sees what was found.
   */
  async submitProposal(upload: HardwareUpload, source: { sourceType: ProposalSource; sourceReference?: string | null; proposedBy: string }) {
    const result = await evaluate(upload);
    if (result.contentHash) {
      const duplicate = await prisma.hardwareChangeProposal.findFirst({
        where: { contentHash: result.contentHash, status: { in: ['pending', 'needs_review'] } },
        select: proposalSelect,
      });
      if (duplicate) return { ...duplicate, duplicate: true };
    }
    if (result.existing && result.changed.length === 0) {
      throw new AppError(409, 'CONFLICT', `${result.proposedId} is already in the library with identical content`);
    }
    const data = {
      hardwareEntityId: result.existing ? result.proposedId : null,
      proposedHardwareEntityId: result.proposedId,
      candidatePayload: upload as unknown as Prisma.InputJsonValue,
      diff: result.existing ? ({ changedBlocks: result.changed } as Prisma.InputJsonValue) : Prisma.DbNull,
      changeClass: result.changeClass,
      sourceType: source.sourceType,
      sourceReference: source.sourceReference ?? null,
      status: result.valid ? 'pending' : 'needs_review',
      validationIssues: result.issues as unknown as Prisma.InputJsonValue,
      contentHash: result.contentHash,
    };
    // One open proposal per board: a re-scrape of the same board refreshes it instead of adding
    // another row to the admin's queue.
    if (result.proposedId) {
      const open = await prisma.hardwareChangeProposal.findFirst({
        where: { proposedHardwareEntityId: result.proposedId, status: { in: ['pending', 'needs_review'] } },
        orderBy: { proposedAt: 'desc' },
        select: { proposalId: true },
      });
      if (open) {
        const refreshed = await prisma.hardwareChangeProposal.update({ where: { proposalId: open.proposalId }, data, select: proposalSelect });
        return { ...refreshed, duplicate: true };
      }
    }
    const proposal = await prisma.hardwareChangeProposal.create({
      data: { ...data, proposedBy: source.proposedBy },
      select: proposalSelect,
    });
    logger.info({ proposalId: proposal.proposalId, proposedId: result.proposedId, status: proposal.status, changeClass: result.changeClass }, 'Hardware proposal queued for admin review');
    return { ...proposal, duplicate: false };
  },

  async list(query: { status?: string; page: number; pageSize: number }) {
    const where: Prisma.HardwareChangeProposalWhereInput = query.status ? { status: query.status } : {};
    const [total, items] = await Promise.all([
      prisma.hardwareChangeProposal.count({ where }),
      prisma.hardwareChangeProposal.findMany({
        where,
        select: proposalSelect,
        orderBy: { proposedAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, items };
  },

  async get(proposalId: string) {
    const proposal = await prisma.hardwareChangeProposal.findUnique({ where: { proposalId }, select: { ...proposalSelect, candidatePayload: true } });
    if (!proposal) throw new AppError(404, 'NOT_FOUND', 'Proposal not found');
    return proposal;
  },

  /** The admin corrects a scraped payload before accepting it. Re-validated and re-diffed. */
  async edit(proposalId: string, upload: HardwareUpload, actor: Actor) {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'pending' && proposal.status !== 'needs_review') throw new AppError(409, 'CONFLICT', `Proposal is already ${proposal.status}`);
    const result = await evaluate(upload);
    const updated = await prisma.hardwareChangeProposal.update({
      where: { proposalId },
      data: {
        hardwareEntityId: result.existing ? result.proposedId : null,
        proposedHardwareEntityId: result.proposedId,
        candidatePayload: upload as unknown as Prisma.InputJsonValue,
        diff: result.existing ? ({ changedBlocks: result.changed } as Prisma.InputJsonValue) : Prisma.DbNull,
        changeClass: result.changeClass,
        status: result.valid ? 'pending' : 'needs_review',
        validationIssues: result.issues as unknown as Prisma.InputJsonValue,
        contentHash: result.contentHash,
      },
      select: proposalSelect,
    });
    await audit(actor, 'HARDWARE_PROPOSAL_EDITED', { proposalId, proposedHardwareEntityId: result.proposedId });
    return updated;
  },

  /**
   * Accepts a proposal into the library: validates, stores, embeds. Scraped boards enter as
   * provisional unless the admin confirms them in the same action.
   */
  async approve(
    proposalId: string,
    decision: { reviewStatus?: string; assetReadiness?: string; notes?: string },
    actor: Actor
  ): Promise<{ proposal: unknown; saved: SaveResult }> {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'pending' && proposal.status !== 'needs_review') throw new AppError(409, 'CONFLICT', `Proposal is already ${proposal.status}`);

    const upload = proposal.candidatePayload as unknown as HardwareUpload;
    const record = JSON.parse(JSON.stringify(upload.record ?? {})) as Record<string, unknown>;
    const governance = { ...((record['status_governance'] as Record<string, unknown>) ?? {}) };
    // What was scraped is never self-certified: it lands provisional (and vendor_agent) unless the
    // admin explicitly confirms it here.
    governance['review_status'] = 'provisional';
    if (proposal.sourceType === 'vendor_agent') governance['record_origin'] = 'vendor_agent';
    governance['scope'] = 'shared_library';
    record['status_governance'] = governance;

    const exists = await prisma.hardwareEntity.findUnique({ where: { hardwareEntityId: proposal.proposedHardwareEntityId ?? '' }, select: { hardwareEntityId: true } });
    const saved = await hardwareAdminService.save({ ...upload, record }, actor, exists ? 'replace' : 'create', exists ? exists.hardwareEntityId : undefined);
    if (decision.reviewStatus || decision.assetReadiness) {
      await hardwareAdminService.updateGovernance(
        saved.hardwareEntityId,
        { ...(decision.reviewStatus ? { reviewStatus: decision.reviewStatus } : {}), ...(decision.assetReadiness ? { assetReadiness: decision.assetReadiness } : {}) },
        actor
      );
    }

    const updated = await prisma.hardwareChangeProposal.update({
      where: { proposalId },
      data: { status: 'approved', hardwareEntityId: saved.hardwareEntityId, reviewedBy: actor.label, reviewedAt: new Date(), reviewNotes: decision.notes ?? null },
      select: proposalSelect,
    });
    await audit(actor, 'HARDWARE_PROPOSAL_APPROVED', { proposalId, hardwareEntityId: saved.hardwareEntityId, outcome: saved.outcome, decision });
    return { proposal: updated, saved };
  },

  async reject(proposalId: string, notes: string, actor: Actor) {
    const proposal = await this.get(proposalId);
    if (proposal.status !== 'pending' && proposal.status !== 'needs_review') throw new AppError(409, 'CONFLICT', `Proposal is already ${proposal.status}`);
    const updated = await prisma.hardwareChangeProposal.update({
      where: { proposalId },
      data: { status: 'rejected', reviewedBy: actor.label, reviewedAt: new Date(), reviewNotes: notes },
      select: proposalSelect,
    });
    await audit(actor, 'HARDWARE_PROPOSAL_REJECTED', { proposalId, notes });
    return updated;
  },
};
