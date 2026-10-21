import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { AppError } from '../../common/errors/AppError.js';
import { canonicalJson } from '../hardware/hardware-admin.service.js';
import {
  ACCESS_STATES,
  CONFIDENCES,
  DOMAIN_IDS,
  DOMAINS,
  EventState,
  GAP_SEVERITIES,
  GAP_STATUSES,
  GAP_TYPES,
  isDomainId,
  LIFECYCLE_STATUSES,
  ORIGINS,
  oneOf,
  QA_STATUSES,
  REASONING_TRUST_STATES,
  RECORD_TYPES,
  RELATIONSHIP_TYPES,
  RELEASE_STATUSES,
  SOURCE_TYPES,
  SUPPORT_TYPES,
  TRUST_STATES,
} from './ekab.constants.js';
import { NormRecord, NormRelease, ReleasePackage, validateRelease, ValidationIssue } from './ekab-validator.js';
import { ekabEmbeddingService } from './ekab-embedding.service.js';

/**
 * EKAB ingestion (contract §14, §18). The API only receives: it stores the package exactly as
 * sent (RECEIVED) and the worker does the rest, one release at a time:
 *   validate → SCHEMA_VALID → load records/evidence/conditions/relationships/gaps/handoffs in one
 *   transaction → STAGED (or QUARANTINED when some records failed) → round-trip check → embed.
 * Promotion is a separate, explicit admin action with its own gate (Appendix C). Nothing is ever
 * deleted or overwritten: a newer record supersedes an older one, which stays queryable.
 */

export type Actor = { userId: string | null; label: string };

const sha256 = (text: string) => `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const json = (v: unknown): Prisma.InputJsonValue => (v ?? null) as Prisma.InputJsonValue;
const jsonOrNull = (v: unknown) => (v === undefined || v === null ? Prisma.DbNull : (v as Prisma.InputJsonValue));
/** Vocabulary columns carry DB CHECK constraints: an invalid value is stored as NULL (the raw JSON keeps it). */
const enumOrNull = <T extends readonly string[]>(values: T, v: string | null): T[number] | null => (oneOf(values, v) ? v : null);
const cut = (v: string | null, max: number) => (v === null ? null : v.slice(0, max));
const CHUNK = 500;

async function inChunks<T>(items: T[], run: (chunk: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) await run(items.slice(i, i + CHUNK));
}

/** Columns safe for lists: never the large payload/supporting-file columns. */
export const releaseSummarySelect = {
  id: true,
  releaseId: true,
  schemaVersion: true,
  domainId: true,
  domainName: true,
  batchId: true,
  releaseStatus: true,
  ingestionState: true,
  contentHash: true,
  generatedAt: true,
  producer: true,
  governance: true,
  computedCounts: true,
  roundTrip: true,
  receivedBy: true,
  receivedAt: true,
  stagedAt: true,
  decidedBy: true,
  decidedAt: true,
  decisionNotes: true,
} satisfies Prisma.EkabReleaseSelect;

const recordListSelect = {
  id: true,
  recordId: true,
  recordRevision: true,
  recordType: true,
  topic: true,
  title: true,
  normalizedStatement: true,
  origin: true,
  trustState: true,
  confidence: true,
  lifecycleStatus: true,
  supersedes: true,
  applicability: true,
  tags: true,
  quarantined: true,
  quarantineReasons: true,
  embeddedAt: true,
} satisfies Prisma.EkabRecordSelect;

async function event(tx: Prisma.TransactionClient | typeof prisma, releasePk: string, state: EventState, actor: string, details: Record<string, unknown> = {}) {
  await tx.ekabIngestionEvent.create({ data: { releasePk, state, actor, details: details as Prisma.InputJsonValue } });
}

/** record_ids already in EKAB (any non-rejected release), so references across releases resolve. */
async function knownRecordIds(excludeReleasePk: string): Promise<Set<string>> {
  const rows = await prisma.ekabRecord.findMany({
    where: { releasePk: { not: excludeReleasePk }, release: { ingestionState: { not: 'REJECTED' } } },
    select: { recordId: true },
    distinct: ['recordId'],
  });
  return new Set(rows.map((r) => r.recordId));
}

const conditionRows = (recordPk: string, r: NormRecord) =>
  (
    [
      ['applies_to', r.applicability.appliesTo],
      ['excludes', r.applicability.excludes],
      ['condition', r.applicability.conditions],
    ] as const
  ).flatMap(([kind, values]) =>
    values.map((v) => ({ recordPk, kind, text: typeof v === 'string' ? v : JSON.stringify(v), value: typeof v === 'string' ? Prisma.DbNull : (v as Prisma.InputJsonValue) }))
  );

/** Appendix C, the parts a machine can check. An empty list means the release may be promoted. */
export function promotionBlockers(
  row: { ingestionState: string; releaseStatus: string | null; governance: unknown; validationIssues: unknown; roundTrip: unknown; computedCounts?: unknown },
  options: { acceptExclusions?: boolean } = {}
): string[] {
  const blockers: string[] = [];
  if (row.ingestionState !== 'STAGED' && row.ingestionState !== 'QUARANTINED') {
    blockers.push(`The release is ${row.ingestionState}; only a STAGED or QUARANTINED release can be promoted.`);
    return blockers;
  }
  const counts = isObj(row.computedCounts) ? row.computedCounts : {};
  if (row.ingestionState === 'QUARANTINED' && !options.acceptExclusions) {
    blockers.push(`${String(counts['quarantined'] ?? 'Some')} record(s) are quarantined. Confirm that the rest may be promoted without them (PASS_WITH_EXCLUSIONS).`);
  }
  const gov = isObj(row.governance) ? row.governance : {};
  const approval = isObj(gov['ekab_approval']) ? (gov['ekab_approval']['qa_status'] as string | undefined) : undefined;
  const declaredOk = row.releaseStatus === 'APPROVED_FOR_INGESTION' && oneOf(['PASS', 'PASS_WITH_EXCLUSIONS'] as const, gov['qa_status']);
  if (!declaredOk && !oneOf(['PASS', 'PASS_WITH_EXCLUSIONS'] as const, approval)) {
    blockers.push('QA is not approved: the release does not declare APPROVED_FOR_INGESTION with qa_status PASS, and no admin has approved its QA here.');
  }
  const issues = Array.isArray(row.validationIssues) ? (row.validationIssues as ValidationIssue[]) : [];
  for (const issue of issues) if (issue.rule === 'PACKAGE') blockers.push(issue.message);
  const rt = isObj(row.roundTrip) ? row.roundTrip : null;
  if (!rt) blockers.push('The staging round-trip check has not run yet.');
  else if (rt['passed'] !== true) blockers.push('The staging round-trip check failed: stored records do not read back as submitted.');
  return blockers;
}

export const ekabReleaseService = {
  /**
   * Stores a submitted package as RECEIVED (the caller then queues staging). The same bytes again
   * return the existing release; different bytes under a live release_id are refused (§18 step 2).
   */
  async receive(pkg: ReleasePackage, actor: Actor) {
    const c = pkg.canonical;
    const releaseId = isObj(c) && typeof c['release_id'] === 'string' ? c['release_id'].trim() : '';
    if (!releaseId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'The canonical JSON cannot be read as a release (no release_id).', { issues: validateRelease(pkg).issues });
    }
    if (releaseId.length > 80) throw new AppError(400, 'VALIDATION_ERROR', 'release_id is longer than 80 characters.');
    const contentHash = sha256(canonicalJson(c));
    const live = await prisma.ekabRelease.findFirst({ where: { releaseId, ingestionState: { not: 'REJECTED' } }, select: releaseSummarySelect });
    if (live) {
      if (live.contentHash === contentHash) return { release: live, duplicate: true };
      throw new AppError(409, 'CONFLICT', `${releaseId} was already received with different content. Releases are immutable: submit the correction under a new release_id.`, {
        reason: 'release_id_taken',
        existingReleasePk: live.id,
      });
    }
    const release = await prisma.ekabRelease.create({
      data: {
        releaseId,
        ingestionState: 'RECEIVED',
        contentHash,
        validationIssues: [],
        payload: json(c),
        sourceManifest: jsonOrNull(pkg.sourceManifest),
        gapRegistry: jsonOrNull(pkg.gapRegistry),
        qaReport: jsonOrNull(pkg.qaReport),
        completionReport: jsonOrNull(pkg.completionReport),
        receivedBy: actor.label.slice(0, 120),
        events: { create: { state: 'RECEIVED', actor: actor.label.slice(0, 120), details: { contentHash } } },
      },
      select: releaseSummarySelect,
    });
    logger.info({ releaseId, releasePk: release.id }, 'EKAB release received');
    return { release, duplicate: false };
  },

  /** Worker step: validate, load, round-trip, embed. Safe to call twice (only RECEIVED is processed). */
  async stage(releasePk: string): Promise<{ state: string; skipped?: boolean }> {
    const row = await prisma.ekabRelease.findUnique({
      where: { id: releasePk },
      select: { id: true, releaseId: true, ingestionState: true, payload: true, sourceManifest: true, gapRegistry: true, qaReport: true, completionReport: true },
    });
    if (!row) return { state: 'MISSING', skipped: true };
    if (row.ingestionState !== 'RECEIVED') return { state: row.ingestionState, skipped: true };

    const pkg: ReleasePackage = {
      canonical: row.payload,
      sourceManifest: row.sourceManifest ?? undefined,
      gapRegistry: row.gapRegistry ?? undefined,
      qaReport: row.qaReport ?? undefined,
      completionReport: row.completionReport ?? undefined,
    };
    const result = validateRelease(pkg, { knownRecordIds: await knownRecordIds(releasePk) });
    const counts = { ...result.counts, quarantined: result.quarantined.size };

    if (result.rejected || !result.release) {
      const errors = result.issues.filter((i) => i.scope === 'release' && i.severity === 'error');
      const r = result.release;
      await prisma.$transaction(async (tx) => {
        await tx.ekabRelease.update({
          where: { id: releasePk },
          data: {
            ingestionState: 'REJECTED',
            validationIssues: json(result.issues),
            computedCounts: json(counts),
            decidedBy: 'validator',
            decidedAt: new Date(),
            // Whatever identity is readable, so the rejection shows up under its domain in the admin lists.
            ...(r
              ? {
                  domainId: isDomainId(r.domainId) ? r.domainId : null,
                  domainName: cut(r.domainName, 80),
                  batchId: cut(r.batchId, 120),
                  releaseStatus: enumOrNull(RELEASE_STATUSES, r.releaseStatus),
                  schemaVersion: cut(r.schemaVersion, 40),
                  producer: jsonOrNull(r.producer),
                }
              : {}),
          },
        });
        await event(tx, releasePk, 'REJECTED', 'validator', { errors: errors.length, rules: [...new Set(errors.map((e) => e.rule))] });
      });
      logger.info({ releasePk, releaseId: row.releaseId, errors: errors.length }, 'EKAB release rejected by validation');
      return { state: 'REJECTED' };
    }

    const rel = result.release;
    const state = result.quarantined.size > 0 ? 'QUARANTINED' : 'STAGED';
    await prisma.$transaction(
      async (tx) => {
        await tx.ekabRelease.update({
          where: { id: releasePk },
          data: {
            ingestionState: 'SCHEMA_VALID',
            schemaVersion: rel.schemaVersion,
            domainId: isDomainId(rel.domainId) ? rel.domainId : null,
            domainName: cut(rel.domainName, 80),
            batchId: cut(rel.batchId, 120),
            releaseStatus: enumOrNull(RELEASE_STATUSES, rel.releaseStatus),
            generatedAt: rel.generatedAt ? new Date(rel.generatedAt) : null,
            sourceSnapshotId: cut(rel.sourceSnapshotId, 120),
            producer: jsonOrNull(rel.producer),
            governance: jsonOrNull(rel.governance),
            declaredCounts: jsonOrNull(rel.declaredCounts),
            computedCounts: json(counts),
            validationIssues: json(result.issues),
          },
        });
        await event(tx, releasePk, 'SCHEMA_VALID', 'validator', { warnings: result.issues.filter((i) => i.severity === 'warning').length });
        await this.load(tx, releasePk, rel, result.quarantined);
        await tx.ekabRelease.update({ where: { id: releasePk }, data: { ingestionState: state, stagedAt: new Date() } });
        await event(tx, releasePk, state, 'validator', { records: rel.records.length, quarantined: result.quarantined.size });
      },
      { timeout: 120_000, maxWait: 10_000 }
    );

    const roundTrip = await this.roundTrip(releasePk, rel, result.quarantined);
    await prisma.ekabRelease.update({ where: { id: releasePk }, data: { roundTrip: json(roundTrip) } });
    // Embeddings only after the structured load passed (§18 step 10). Failure is not fatal.
    const embeddings = await ekabEmbeddingService.embedPending({ releasePk });
    logger.info({ releasePk, releaseId: row.releaseId, state, quarantined: result.quarantined.size, roundTrip: roundTrip.passed, embeddings }, 'EKAB release staged');
    return { state };
  },

  /** Loads the normalised release into the staging entities (one transaction, chunked inserts). */
  async load(tx: Prisma.TransactionClient, releasePk: string, rel: NormRelease, quarantined: Map<string, ValidationIssue[]>) {
    const sources = new Map<string, NormRelease['evidence'][number]>();
    for (const ev of rel.evidence) if (!sources.has(ev.sourceId)) sources.set(ev.sourceId, ev);
    await inChunks([...sources.values()], (chunk) =>
      tx.ekabEvidenceSource.createMany({
        data: chunk.map((ev) => ({
          sourceId: ev.sourceId.slice(0, 160),
          sourceType: enumOrNull(SOURCE_TYPES, ev.sourceType),
          publisher: cut(ev.publisher, 300),
          title: ev.title,
          documentId: cut(ev.documentId, 200),
          url: ev.url,
          accessState: enumOrNull(ACCESS_STATES, ev.accessState),
          firstReleaseId: rel.releaseId,
        })),
        skipDuplicates: true, // §18 step 4: a source is never re-created because a new batch cites it
      })
    );

    const evidenceByKey = new Map<string, NormRelease['evidence'][number]>();
    for (const ev of rel.evidence) {
      if (ev.evidenceId) evidenceByKey.set(ev.evidenceId, ev);
      if (!evidenceByKey.has(ev.sourceId)) evidenceByKey.set(ev.sourceId, ev);
    }

    const pks = new Map(rel.records.map((r) => [r.recordId, crypto.randomUUID()]));
    await inChunks(rel.records, (chunk) =>
      tx.ekabRecord.createMany({
        data: chunk.map((r) => ({
          id: pks.get(r.recordId)!,
          releasePk,
          releaseId: rel.releaseId,
          recordId: r.recordId,
          recordRevision: r.recordRevision,
          recordType: enumOrNull(RECORD_TYPES, r.recordType),
          domainId: isDomainId(r.domainId) ? r.domainId : null,
          topic: r.topic,
          title: r.title,
          normalizedStatement: r.statement,
          origin: enumOrNull(ORIGINS, r.origin),
          trustState: enumOrNull(TRUST_STATES, r.trustState),
          confidence: enumOrNull(CONFIDENCES, r.confidence),
          lifecycleStatus: enumOrNull(LIFECYCLE_STATUSES, r.lifecycle),
          supersedes: cut(r.supersedes, 120),
          applicability: json({ applies_to: r.applicability.appliesTo, excludes: r.applicability.excludes, conditions: r.applicability.conditions }),
          content: json(r.content),
          evidenceRefs: r.evidenceRefs,
          relationshipRefs: r.relationshipRefs,
          tags: r.tags,
          qa: jsonOrNull(r.qa),
          raw: json(r.raw),
          quarantined: quarantined.has(r.recordId),
          quarantineReasons: quarantined.has(r.recordId) ? json(quarantined.get(r.recordId)) : Prisma.DbNull,
        })),
      })
    );

    const links = rel.records.flatMap((r) =>
      r.evidenceRefs.flatMap((ref) => {
        const ev = evidenceByKey.get(ref);
        if (!ev) return [];
        return [
          {
            recordPk: pks.get(r.recordId)!,
            evidenceId: ref.slice(0, 160),
            sourceId: ev.sourceId.slice(0, 160),
            sourceRevision: cut(ev.revision, 120),
            locator: ev.locator,
            supportType: enumOrNull(SUPPORT_TYPES, ev.supportType),
            retrievedAt: cut(ev.retrievedAt, 40),
          },
        ];
      })
    );
    await inChunks(links, (chunk) => tx.ekabRecordEvidence.createMany({ data: chunk }));
    await inChunks(
      rel.records.flatMap((r) => conditionRows(pks.get(r.recordId)!, r)),
      (chunk) => tx.ekabRecordCondition.createMany({ data: chunk })
    );

    await inChunks(rel.relationships, (chunk) =>
      tx.ekabRelationship.createMany({
        data: chunk.map((x) => ({
          releasePk,
          relationshipId: x.relationshipId,
          type: enumOrNull(RELATIONSHIP_TYPES, x.type),
          fromRecordId: cut(x.fromRecordId, 120),
          toRecordId: cut(x.toRecordId, 120),
          targetConcept: x.targetConcept,
          conditions: jsonOrNull(x.conditions),
          raw: json(x.raw),
        })),
      })
    );
    await inChunks(rel.gaps, (chunk) =>
      tx.ekabGap.createMany({
        data: chunk.map((g) => ({
          releasePk,
          gapId: g.gapId,
          domainId: isDomainId(g.domainId) ? g.domainId : null,
          batchId: cut(g.batchId, 120),
          topic: g.topic,
          question: g.question,
          gapType: enumOrNull(GAP_TYPES, g.gapType),
          severity: enumOrNull(GAP_SEVERITIES, g.severity),
          status: enumOrNull(GAP_STATUSES, g.status),
          sourceRefs: g.sourceRefs,
          resolutionRecordRefs: g.resolutionRecordRefs,
          notes: g.notes,
          raw: json(g.raw),
        })),
      })
    );
    await inChunks(rel.handoffs, (chunk) =>
      tx.ekabHandoff.createMany({
        data: chunk.map((h) => ({
          releasePk,
          handoffId: h.handoffId,
          sourceDomain: cut(h.sourceDomain, 10),
          targetDomain: cut(h.targetDomain, 10),
          sourceRecordRefs: h.sourceRecordRefs,
          question: h.question,
          reason: cut(h.reason, 60),
          priority: cut(h.priority, 20),
          blocking: h.blocking,
          status: cut(h.status, 20),
          resolutionRecordRefs: h.resolutionRecordRefs,
          raw: json(h.raw),
        })),
      })
    );
  },

  /**
   * §18 step 11: read every loaded (non-quarantined) record back the way retrieval does and check
   * that its statement, trust dimensions, conditions and evidence survived the round trip.
   */
  async roundTrip(releasePk: string, rel: NormRelease, quarantined: Map<string, ValidationIssue[]>) {
    const loaded = await prisma.ekabRecord.findMany({
      where: { releasePk, quarantined: false },
      select: {
        recordId: true,
        recordRevision: true,
        normalizedStatement: true,
        origin: true,
        trustState: true,
        confidence: true,
        _count: { select: { evidence: true, conditions: true } },
      },
    });
    const byId = new Map(loaded.map((l) => [l.recordId, l]));
    const failures: string[] = [];
    let checked = 0;
    for (const r of rel.records) {
      if (quarantined.has(r.recordId)) continue;
      checked += 1;
      const l = byId.get(r.recordId);
      if (!l) {
        failures.push(`${r.recordId}: not found after loading.`);
        continue;
      }
      const conditionCount = r.applicability.appliesTo.length + r.applicability.excludes.length + r.applicability.conditions.length;
      if (l.normalizedStatement !== r.statement) failures.push(`${r.recordId}: statement changed.`);
      if (l.recordRevision !== r.recordRevision) failures.push(`${r.recordId}: revision changed.`);
      if (l.origin !== r.origin || l.trustState !== r.trustState || l.confidence !== r.confidence) failures.push(`${r.recordId}: origin / trust state / confidence changed.`);
      if (l._count.conditions !== conditionCount) failures.push(`${r.recordId}: ${l._count.conditions} of ${conditionCount} applicability entries stored.`);
      if (l._count.evidence !== r.evidenceRefs.length) failures.push(`${r.recordId}: ${l._count.evidence} of ${r.evidenceRefs.length} evidence links stored.`);
    }
    return { passed: failures.length === 0, checked, failures: failures.slice(0, 50), checkedAt: new Date().toISOString() };
  },

  /** Re-runs the round-trip check and embeddings of a loaded release (e.g. after an embedding outage). */
  async recheck(releasePk: string) {
    const row = await prisma.ekabRelease.findUnique({
      where: { id: releasePk },
      select: { ingestionState: true, payload: true, sourceManifest: true, gapRegistry: true, qaReport: true, completionReport: true },
    });
    if (!row) return { state: 'MISSING', skipped: true };
    if (!['STAGED', 'QUARANTINED', 'PROMOTED'].includes(row.ingestionState)) return { state: row.ingestionState, skipped: true };
    const result = validateRelease(
      { canonical: row.payload, sourceManifest: row.sourceManifest ?? undefined, gapRegistry: row.gapRegistry ?? undefined, qaReport: row.qaReport ?? undefined, completionReport: row.completionReport ?? undefined },
      { knownRecordIds: await knownRecordIds(releasePk) }
    );
    if (!result.release) return { state: row.ingestionState, skipped: true };
    // The stored quarantine decision stands; only records loaded as usable are compared.
    const stored = await prisma.ekabRecord.findMany({ where: { releasePk, quarantined: true }, select: { recordId: true } });
    const quarantined = new Map(stored.map((s) => [s.recordId, [] as ValidationIssue[]]));
    const roundTrip = await this.roundTrip(releasePk, result.release, quarantined);
    await prisma.ekabRelease.update({ where: { id: releasePk }, data: { roundTrip: json(roundTrip) } });
    const embeddings = await ekabEmbeddingService.embedPending({ releasePk });
    return { state: row.ingestionState, roundTrip: roundTrip.passed, embeddings };
  },

  /** EKAB-side QA approval (B0 or equivalent) for a release that did not arrive approved. */
  async approveQa(releasePk: string, decision: { qaStatus: 'PASS' | 'PASS_WITH_EXCLUSIONS'; notes?: string }, actor: Actor) {
    const row = await prisma.ekabRelease.findUnique({ where: { id: releasePk }, select: { ingestionState: true, governance: true, releaseStatus: true } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Release not found');
    if (row.ingestionState !== 'STAGED' && row.ingestionState !== 'QUARANTINED') {
      throw new AppError(409, 'CONFLICT', `Only a STAGED or QUARANTINED release can have its QA approved (this one is ${row.ingestionState}).`);
    }
    if (row.releaseStatus === 'REJECTED' || row.releaseStatus === 'REVISION_REQUIRED') {
      throw new AppError(409, 'CONFLICT', `The worker marked this release ${row.releaseStatus}; it needs a new release, not an approval.`);
    }
    const governance = {
      ...(isObj(row.governance) ? row.governance : {}),
      ekab_approval: { qa_status: decision.qaStatus, approved_by: actor.label, approved_at: new Date().toISOString(), notes: decision.notes ?? null },
    };
    return prisma.$transaction(async (tx) => {
      const updated = await tx.ekabRelease.update({ where: { id: releasePk }, data: { governance: governance as Prisma.InputJsonValue }, select: releaseSummarySelect });
      await event(tx, releasePk, 'QA_APPROVED', actor.label, { qaStatus: decision.qaStatus, notes: decision.notes ?? null });
      return updated;
    });
  },

  /**
   * Controlled promotion (§14, Appendix C). Older ACTIVE revisions of the same record_id, and the
   * records a new record explicitly supersedes, become SUPERSEDED (kept, never deleted). A promoted
   * release left with no active records becomes SUPERSEDED itself.
   */
  async promote(releasePk: string, input: { notes?: string; acceptExclusions?: boolean }, actor: Actor) {
    const row = await prisma.ekabRelease.findUnique({
      where: { id: releasePk },
      select: { id: true, releaseId: true, ingestionState: true, releaseStatus: true, governance: true, validationIssues: true, roundTrip: true, computedCounts: true },
    });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Release not found');
    const blockers = promotionBlockers(row, input);
    if (blockers.length > 0) throw new AppError(409, 'CONFLICT', 'The release cannot be promoted yet.', { reason: 'promotion_blocked', blockers });

    const incoming = await prisma.ekabRecord.findMany({
      where: { releasePk, quarantined: false, lifecycleStatus: 'ACTIVE' },
      select: { id: true, recordId: true, recordRevision: true, supersedes: true },
    });
    const existing = await prisma.ekabRecord.findMany({
      where: { recordId: { in: incoming.map((r) => r.recordId) }, lifecycleStatus: 'ACTIVE', releasePk: { not: releasePk }, release: { ingestionState: 'PROMOTED' } },
      select: { id: true, recordId: true, recordRevision: true, releaseId: true },
    });
    const incomingById = new Map(incoming.map((r) => [r.recordId, r]));
    const conflicts = existing.filter((e) => (e.recordRevision ?? 0) >= (incomingById.get(e.recordId)?.recordRevision ?? 0));
    if (conflicts.length > 0) {
      throw new AppError(409, 'CONFLICT', 'Some records already have an equal or newer active revision in EKAB.', {
        reason: 'revision_conflict',
        conflicts: conflicts.slice(0, 50).map((c) => ({ recordId: c.recordId, activeRevision: c.recordRevision, inRelease: c.releaseId, incomingRevision: incomingById.get(c.recordId)?.recordRevision })),
      });
    }

    const superseded = await prisma.$transaction(
      async (tx) => {
        let count = 0;
        for (const e of existing) {
          await tx.ekabRecord.update({ where: { id: e.id }, data: { lifecycleStatus: 'SUPERSEDED', supersededByPk: incomingById.get(e.recordId)!.id } });
          count += 1;
        }
        for (const r of incoming.filter((x) => x.supersedes)) {
          const res = await tx.ekabRecord.updateMany({
            where: { recordId: r.supersedes!, lifecycleStatus: 'ACTIVE', releasePk: { not: releasePk }, release: { ingestionState: 'PROMOTED' } },
            data: { lifecycleStatus: 'SUPERSEDED', supersededByPk: r.id },
          });
          count += res.count;
        }
        await tx.ekabRelease.update({
          where: { id: releasePk },
          data: { ingestionState: 'PROMOTED', decidedBy: actor.label.slice(0, 120), decidedAt: new Date(), decisionNotes: input.notes ?? null },
        });
        await event(tx, releasePk, 'PROMOTED', actor.label, { records: incoming.length, superseded: count, acceptExclusions: input.acceptExclusions === true, notes: input.notes ?? null });

        const emptied = await tx.ekabRelease.findMany({
          where: { id: { not: releasePk }, ingestionState: 'PROMOTED', records: { none: { lifecycleStatus: 'ACTIVE', quarantined: false } } },
          select: { id: true },
        });
        for (const e of emptied) {
          await tx.ekabRelease.update({ where: { id: e.id }, data: { ingestionState: 'SUPERSEDED' } });
          await event(tx, e.id, 'SUPERSEDED', actor.label, { by: row.releaseId });
        }
        return count;
      },
      { timeout: 120_000, maxWait: 10_000 }
    );
    logger.info({ releasePk, releaseId: row.releaseId, records: incoming.length, superseded }, 'EKAB release promoted');
    return { release: await prisma.ekabRelease.findUnique({ where: { id: releasePk }, select: releaseSummarySelect }), promotedRecords: incoming.length, superseded };
  },

  async reject(releasePk: string, notes: string, actor: Actor) {
    const row = await prisma.ekabRelease.findUnique({ where: { id: releasePk }, select: { ingestionState: true } });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Release not found');
    if (!['RECEIVED', 'SCHEMA_VALID', 'STAGED', 'QUARANTINED'].includes(row.ingestionState)) {
      throw new AppError(409, 'CONFLICT', `A ${row.ingestionState} release cannot be rejected. Promoted knowledge is replaced by promoting a newer release.`);
    }
    return prisma.$transaction(async (tx) => {
      const updated = await tx.ekabRelease.update({
        where: { id: releasePk },
        data: { ingestionState: 'REJECTED', decidedBy: actor.label.slice(0, 120), decidedAt: new Date(), decisionNotes: notes },
        select: releaseSummarySelect,
      });
      await event(tx, releasePk, 'REJECTED', actor.label, { notes });
      return updated;
    });
  },

  // --- admin reads --------------------------------------------------------------------------------

  async list(query: { domainId?: string; state?: string; page: number; pageSize: number }) {
    const where: Prisma.EkabReleaseWhereInput = { ...(query.domainId ? { domainId: query.domainId } : {}), ...(query.state ? { ingestionState: query.state } : {}) };
    const [total, items] = await Promise.all([
      prisma.ekabRelease.count({ where }),
      prisma.ekabRelease.findMany({ where, select: releaseSummarySelect, orderBy: { receivedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, items };
  },

  async get(releasePk: string) {
    const release = await prisma.ekabRelease.findUnique({
      where: { id: releasePk },
      select: {
        ...releaseSummarySelect,
        declaredCounts: true,
        validationIssues: true,
        sourceSnapshotId: true,
        qaReport: true,
        completionReport: true,
        gaps: { select: { gapId: true, topic: true, question: true, gapType: true, severity: true, status: true, sourceRefs: true, resolutionRecordRefs: true, notes: true }, orderBy: { gapId: 'asc' } },
        handoffs: {
          select: { handoffId: true, sourceDomain: true, targetDomain: true, question: true, reason: true, priority: true, blocking: true, status: true, sourceRecordRefs: true },
          orderBy: { handoffId: 'asc' },
        },
        events: { select: { state: true, actor: true, details: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!release) throw new AppError(404, 'NOT_FOUND', 'Release not found');
    return { ...release, promotionBlockers: promotionBlockers(release) };
  },

  async listRecords(releasePk: string, query: { trust?: string; quarantined?: boolean; q?: string; page: number; pageSize: number }) {
    const where: Prisma.EkabRecordWhereInput = {
      releasePk,
      ...(query.trust ? { trustState: query.trust } : {}),
      ...(query.quarantined !== undefined ? { quarantined: query.quarantined } : {}),
      ...(query.q
        ? {
            OR: [
              { recordId: { contains: query.q, mode: 'insensitive' } },
              { title: { contains: query.q, mode: 'insensitive' } },
              { topic: { contains: query.q, mode: 'insensitive' } },
              { normalizedStatement: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, items] = await Promise.all([
      prisma.ekabRecord.count({ where }),
      prisma.ekabRecord.findMany({
        where,
        select: { ...recordListSelect, evidence: { select: { evidenceId: true, sourceId: true, sourceRevision: true, locator: true, supportType: true, source: { select: { title: true, publisher: true, url: true, sourceType: true } } } } },
        orderBy: [{ quarantined: 'desc' }, { recordId: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, items };
  },

  /** Dashboard numbers per domain: usable records and releases by state. */
  async overview() {
    const [records, releases, received] = await Promise.all([
      prisma.ekabRecord.groupBy({
        by: ['domainId', 'trustState'],
        where: { quarantined: false, lifecycleStatus: 'ACTIVE', trustState: { in: [...REASONING_TRUST_STATES] }, release: { ingestionState: 'PROMOTED' } },
        _count: { _all: true },
      }),
      prisma.ekabRelease.groupBy({ by: ['domainId', 'ingestionState'], _count: { _all: true } }),
      prisma.ekabRelease.count({ where: { ingestionState: 'RECEIVED' } }),
    ]);
    const domains = DOMAIN_IDS.map((id) => ({
      domainId: id,
      name: DOMAINS[id].name,
      code: DOMAINS[id].code,
      activeRecords: {
        verified: records.find((r) => r.domainId === id && r.trustState === 'VERIFIED')?._count._all ?? 0,
        conditional: records.find((r) => r.domainId === id && r.trustState === 'CONDITIONAL')?._count._all ?? 0,
      },
      releases: Object.fromEntries(releases.filter((r) => r.domainId === id).map((r) => [r.ingestionState, r._count._all])),
    }));
    return { domains, waitingForStaging: received, qaStatuses: QA_STATUSES };
  },
};
