import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../db/prisma.js';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/AppError.js';
import { DOMAINS, DomainId, isDomainId } from '../ekab.constants.js';
import { batchByCode } from '../ekab-batches.js';
import { matchSourceDomain } from '../ekab-source-domain.service.js';
import { Actor, ekabReleaseService } from '../ekab-release.service.js';
import { ReleasePackage, validateRelease } from '../ekab-validator.js';
import { extractCandidates, ParameterValues } from './ekab-extractor.js';
import { SourceBlockedError, SourceFetcher } from './ekab-fetcher.js';
import { CandidateEdit, ScrapeJobInput } from './ekab-scrape.validation.js';

/**
 * Track B source scraper (deterministic, no AI). An admin starts a job for one coverage batch with
 * a few source URLs; the worker fetches them (allowlist, robots.txt, no logins/paywalls) and
 * stores verbatim candidate passages. A reviewer accepts, edits or rejects each candidate; the
 * accepted ones become one canonical Track B release that goes through the normal EKAB validator,
 * staging, QA approval and promotion. The scraper never approves its own output.
 */

const MAX_CANDIDATES_PER_DOCUMENT = 400;
const CHUNK = 500;

type Json = Record<string, unknown>;
const shortId = (uuid: string) => uuid.replace(/-/g, '').slice(0, 7).toUpperCase();
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const sourceIdFor = (url: string, host: string) => `SRC-${host.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').toUpperCase().slice(0, 60)}-${sha(url.replace(/#.*$/, '')).slice(0, 10).toUpperCase()}`;
const documentIdFromUrl = (url: string) => {
  const rfc = /\brfc[-_]?(\d{1,5})\b/i.exec(url);
  return rfc ? `RFC ${Number(rfc[1])}` : null;
};
const fmt = (n: number | null) => (n === null ? null : String(n));

/** Source type from the document's own title / URL wording, when the admin did not set one. */
export function inferSourceType(url: string, title: string | null): string | null {
  const t = `${title ?? ''} ${url}`;
  if (/\bdata ?sheet\b|\/ds\/|\/symlink\//i.test(t)) return 'DATASHEET';
  if (/reference manual|\/rm\d|technical reference/i.test(t)) return 'REFERENCE_MANUAL';
  if (/application (note|report)|app ?note|\/an\/|\/an\d/i.test(t)) return 'APP_NOTE';
  if (/reference design/i.test(t)) return 'REFERENCE_DESIGN';
  return null;
}

/** A parameter row reads back as one statement built only from the row's own cells. */
export function parameterStatement(v: ParameterValues): string {
  const parts = [v.min !== null ? `min ${fmt(v.min)}` : null, v.typ !== null ? `typ ${fmt(v.typ)}` : null, v.max !== null ? `max ${fmt(v.max)}` : null].filter(Boolean);
  return `${v.label}: ${parts.join(', ')} ${v.unit_original}`;
}

const jobSelect = {
  id: true,
  domainId: true,
  batchCode: true,
  title: true,
  status: true,
  requested: true,
  summary: true,
  error: true,
  releaseId: true,
  createdBy: true,
  createdAt: true,
  finishedAt: true,
} satisfies Prisma.EkabScrapeJobSelect;

export const ekabScrapeService = {
  /** Checks scope and sources, stores the job as queued (the caller queues the worker run). */
  async createJob(input: ScrapeJobInput, actor: Actor) {
    const batch = batchByCode(input.batchCode);
    if (!batch || batch.domainId !== input.domainId) throw new AppError(400, 'BAD_REQUEST', `${input.batchCode} is not a coverage batch of ${input.domainId}.`);
    const domains = await prisma.ekabSourceDomain.findMany({ where: { enabled: true } });
    const unknown = input.sources.map((s) => new URL(s.url).hostname).filter((h) => !matchSourceDomain(h, domains));
    if (unknown.length > 0) {
      throw new AppError(400, 'BAD_REQUEST', `Not on the source websites list (or disabled): ${[...new Set(unknown)].join(', ')}. Add the site first, then start the scrape.`, {
        reason: 'unknown_hosts',
        hosts: [...new Set(unknown)],
      });
    }
    return prisma.ekabScrapeJob.create({
      data: {
        domainId: input.domainId,
        batchCode: input.batchCode,
        title: input.title?.trim() || `${batch.code} ${batch.title}`,
        status: 'queued',
        requested: input.sources as unknown as Prisma.InputJsonValue,
        createdBy: actor.label.slice(0, 120),
      },
      select: jobSelect,
    });
  },

  /** Worker step: fetch each source in turn and store its candidates. */
  async run(jobId: string) {
    const job = await prisma.ekabScrapeJob.findUnique({ where: { id: jobId }, select: { id: true, status: true, requested: true } });
    if (!job || job.status !== 'queued') return { skipped: true };
    await prisma.ekabScrapeJob.update({ where: { id: jobId }, data: { status: 'running' } });
    const sources = job.requested as unknown as ScrapeJobInput['sources'];
    const domains = await prisma.ekabSourceDomain.findMany();
    const fetcher = new SourceFetcher(domains);
    const summary = { documents: sources.length, fetched: 0, blocked: 0, failed: 0, candidates: 0, truncated: 0 };

    try {
      for (const source of sources) {
        const host = new URL(source.url).hostname;
        const entry = matchSourceDomain(host, domains);
        const identity = {
          jobId,
          url: source.url,
          host,
          publisher: entry?.publisher ?? null,
          sourceType: source.sourceType ?? entry?.defaultSourceType ?? null,
          accessState: entry?.accessState ?? null,
          documentId: source.documentId ?? documentIdFromUrl(source.url),
        };
        try {
          const doc = await fetcher.fetch(source.url);
          const { candidates, stats } = extractCandidates(doc.pages, { maxCandidates: MAX_CANDIDATES_PER_DOCUMENT });
          const finalEntry = matchSourceDomain(new URL(doc.finalUrl).hostname, domains) ?? entry;
          const created = await prisma.ekabScrapedDocument.create({
            data: {
              ...identity,
              finalUrl: doc.finalUrl,
              status: 'fetched',
              httpStatus: doc.status,
              contentType: doc.contentType.slice(0, 120),
              sourceId: sourceIdFor(doc.finalUrl, doc.host),
              publisher: finalEntry?.publisher ?? identity.publisher,
              title: source.title ?? doc.title ?? doc.finalUrl,
              // The admin's choice wins; otherwise the document says what it is.
              sourceType: source.sourceType ?? inferSourceType(doc.finalUrl, doc.title) ?? identity.sourceType,
              revision: (source.revision ?? doc.revision)?.slice(0, 120) ?? null,
              fingerprint: doc.fingerprint,
              pageCount: doc.pageCount,
              retrievedAt: new Date(),
            },
            select: { id: true },
          });
          for (let i = 0; i < candidates.length; i += CHUNK) {
            await prisma.ekabCandidate.createMany({
              data: candidates.slice(i, i + CHUNK).map((c) => ({
                jobId,
                documentPk: created.id,
                kind: c.kind,
                keyword: c.keyword,
                locator: c.locator,
                section: c.section,
                excerpt: c.excerpt,
                values: c.values ? (c.values as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
                suggestedRecordType: c.suggestedRecordType,
              })),
            });
          }
          summary.fetched += 1;
          summary.candidates += candidates.length;
          if (stats.truncated) summary.truncated += 1;
          logger.info({ jobId, url: source.url, candidates: candidates.length, stats }, 'EKAB scrape: document read');
        } catch (err) {
          const blocked = err instanceof SourceBlockedError && err.gapType === 'RESTRICTED_SOURCE';
          if (blocked) summary.blocked += 1;
          else summary.failed += 1;
          await prisma.ekabScrapedDocument.create({
            data: {
              ...identity,
              status: blocked ? 'blocked' : 'failed',
              blockReason: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
              httpStatus: err instanceof SourceBlockedError ? err.httpStatus : null,
              sourceId: sourceIdFor(source.url, host),
              title: source.title ?? null,
              revision: source.revision ?? null,
            },
          });
          logger.info({ jobId, url: source.url, blocked, reason: err instanceof Error ? err.message : String(err) }, 'EKAB scrape: document not read');
        }
      }
      await prisma.ekabScrapeJob.update({ where: { id: jobId }, data: { status: 'ready', summary: summary as unknown as Prisma.InputJsonValue, finishedAt: new Date() } });
      return summary;
    } catch (err) {
      await prisma.ekabScrapeJob.update({ where: { id: jobId }, data: { status: 'failed', error: err instanceof Error ? err.message : String(err), finishedAt: new Date() } });
      throw err;
    }
  },

  async listJobs(query: { domainId?: string; page: number; pageSize: number }) {
    const where: Prisma.EkabScrapeJobWhereInput = query.domainId ? { domainId: query.domainId } : {};
    const [total, items] = await Promise.all([
      prisma.ekabScrapeJob.count({ where }),
      prisma.ekabScrapeJob.findMany({ where, select: jobSelect, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, items };
  },

  async getJob(jobId: string) {
    const job = await prisma.ekabScrapeJob.findUnique({
      where: { id: jobId },
      select: {
        ...jobSelect,
        documents: {
          select: { id: true, url: true, finalUrl: true, host: true, status: true, blockReason: true, httpStatus: true, contentType: true, sourceId: true, sourceType: true, publisher: true, title: true, documentId: true, revision: true, accessState: true, pageCount: true, retrievedAt: true },
          orderBy: { url: 'asc' },
        },
      },
    });
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Scrape job not found');
    const counts = await prisma.ekabCandidate.groupBy({ by: ['status'], where: { jobId }, _count: { _all: true } });
    const candidateCounts = { pending: 0, accepted: 0, rejected: 0 } as Record<string, number>;
    for (const c of counts) candidateCounts[c.status] = c._count._all;
    return { ...job, batch: batchByCode(job.batchCode), candidateCounts, suggestedVersion: await this.suggestVersion(job.domainId) };
  },

  async listCandidates(jobId: string, query: { status?: string; kind?: string; documentPk?: string; q?: string; page: number; pageSize: number }) {
    const where: Prisma.EkabCandidateWhereInput = {
      jobId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.documentPk ? { documentPk: query.documentPk } : {}),
      ...(query.q ? { OR: [{ excerpt: { contains: query.q, mode: 'insensitive' } }, { section: { contains: query.q, mode: 'insensitive' } }] } : {}),
    };
    const [total, items] = await Promise.all([
      prisma.ekabCandidate.count({ where }),
      prisma.ekabCandidate.findMany({
        where,
        select: { id: true, documentPk: true, kind: true, keyword: true, locator: true, section: true, excerpt: true, values: true, suggestedRecordType: true, status: true, edited: true, reviewedBy: true, reviewedAt: true },
        orderBy: [{ documentPk: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return { total, page: query.page, pageSize: query.pageSize, items };
  },

  /** Accept (optionally with edits), reject, or reset one candidate. */
  async review(candidateId: string, input: { status: 'accepted' | 'rejected' | 'pending'; edited?: CandidateEdit }, actor: Actor) {
    const candidate = await prisma.ekabCandidate.findUnique({ where: { id: candidateId }, select: { id: true, edited: true, job: { select: { status: true } } } });
    if (!candidate) throw new AppError(404, 'NOT_FOUND', 'Candidate not found');
    if (candidate.job.status !== 'ready') throw new AppError(409, 'CONFLICT', `Candidates can be reviewed while the job is ready (this one is ${candidate.job.status}).`);
    const edited = { ...((candidate.edited as Json | null) ?? {}), ...(input.edited ?? {}) } as CandidateEdit;
    if (input.status === 'accepted' && edited.trust_state === 'CONDITIONAL' && (edited.conditions ?? []).length === 0 && (edited.excludes ?? []).length === 0) {
      throw new AppError(400, 'BAD_REQUEST', 'A CONDITIONAL record needs at least one condition or exclusion (contract TB-VAL-006).');
    }
    return prisma.ekabCandidate.update({
      where: { id: candidateId },
      data: {
        status: input.status,
        edited: Object.keys(edited).length > 0 ? (edited as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        reviewedBy: input.status === 'pending' ? null : actor.label.slice(0, 120),
        reviewedAt: input.status === 'pending' ? null : new Date(),
      },
      select: { id: true, status: true, edited: true, reviewedBy: true, reviewedAt: true },
    });
  },

  /** Bulk accept / reject (no edits) for many candidates of one job. */
  async reviewMany(jobId: string, input: { ids: string[]; status: 'accepted' | 'rejected' | 'pending' }, actor: Actor) {
    const job = await prisma.ekabScrapeJob.findUnique({ where: { id: jobId }, select: { status: true } });
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Scrape job not found');
    if (job.status !== 'ready') throw new AppError(409, 'CONFLICT', `Candidates can be reviewed while the job is ready (this one is ${job.status}).`);
    const res = await prisma.ekabCandidate.updateMany({
      where: { jobId, id: { in: input.ids } },
      data: { status: input.status, reviewedBy: input.status === 'pending' ? null : actor.label.slice(0, 120), reviewedAt: input.status === 'pending' ? null : new Date() },
    });
    return { updated: res.count };
  },

  /** Next free patch version for the domain's release ids (B1.COMM.vX.Y.Z), starting at 0.1.0. */
  async suggestVersion(domainId: string): Promise<string> {
    if (!isDomainId(domainId)) return '0.1.0';
    const prefix = `${domainId}.${DOMAINS[domainId].code}.v`;
    const rows = await prisma.ekabRelease.findMany({ where: { releaseId: { startsWith: prefix }, ingestionState: { not: 'REJECTED' } }, select: { releaseId: true } });
    const versions = rows
      .map((r) => /^(\d+)\.(\d+)\.(\d+)$/.exec(r.releaseId.slice(prefix.length)))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const last = versions.at(-1);
    return last ? `${last[0]}.${last[1]}.${last[2] + 1}` : '0.1.0';
  },

  /** The canonical package for a job's accepted candidates (exported for tests and dry runs). */
  async buildPackage(jobId: string, version: string): Promise<ReleasePackage> {
    const job = await prisma.ekabScrapeJob.findUnique({
      where: { id: jobId },
      select: {
        id: true,
        domainId: true,
        batchCode: true,
        documents: true,
        candidates: { where: { status: 'accepted' }, orderBy: [{ documentPk: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Scrape job not found');
    if (!isDomainId(job.domainId)) throw new AppError(400, 'BAD_REQUEST', 'Unknown domain');
    const domainId: DomainId = job.domainId;
    const code = DOMAINS[domainId].code;
    const releaseId = `${domainId}.${code}.v${version}`;
    const run = shortId(job.id);
    const docs = new Map(job.documents.map((d) => [d.id, d]));
    const reviewers = new Set<string>();
    const generatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    const evidence: Json[] = [];
    const records = job.candidates.map((c, i) => {
      const seq = String(i + 1).padStart(4, '0');
      const doc = docs.get(c.documentPk)!;
      const e = (c.edited as CandidateEdit | null) ?? {};
      const values = c.values as ParameterValues | null;
      if (c.reviewedBy) reviewers.add(c.reviewedBy);
      const conditions = e.conditions ?? [];
      const excludes = e.excludes ?? [];
      const trust = e.trust_state ?? (conditions.length > 0 || excludes.length > 0 ? 'CONDITIONAL' : 'VERIFIED');
      const evidenceId = `EV-S${run}-${seq}`;
      evidence.push({
        evidence_id: evidenceId,
        source_id: doc.sourceId,
        source_type: doc.sourceType,
        publisher: doc.publisher,
        title: doc.title,
        document_id: doc.documentId,
        revision: doc.revision,
        url: doc.finalUrl ?? doc.url,
        locator: c.locator,
        retrieved_at: (doc.retrievedAt ?? new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        support_type: 'DIRECT',
        access_state: doc.accessState,
      });
      return {
        record_id: `${domainId}-${code}-S${run}-${seq}`,
        record_revision: 1,
        record_type: e.record_type ?? c.suggestedRecordType,
        domain_id: domainId,
        topic: e.topic ?? c.section ?? job.batchCode,
        title: e.title ?? (values ? values.label : c.excerpt.slice(0, 120)),
        normalized_statement: e.normalized_statement ?? (values ? parameterStatement(values) : c.excerpt),
        origin: 'SOURCE_BASED',
        trust_state: trust,
        confidence: e.confidence ?? (['STANDARD', 'DATASHEET', 'REFERENCE_MANUAL'].includes(doc.sourceType ?? '') ? 'HIGH' : 'MEDIUM'),
        applicability: { applies_to: e.applies_to ?? [], excludes, conditions },
        content: {
          excerpt: c.excerpt,
          extraction: { method: 'deterministic', kind: c.kind, keyword: c.keyword, scrape_job: job.id, candidate_id: c.id },
          ...(values ? { values: { parameter: values.label, min: values.min, typ: values.typ, max: values.max, unit_original: values.unit_original, columns: values.columns } } : {}),
        },
        evidence_refs: [evidenceId],
        relationship_refs: [],
        tags: e.tags ?? [job.batchCode, ...(c.keyword ? [c.keyword] : [])],
        version: { release_id: releaseId, status: 'ACTIVE', supersedes: null },
        qa: { checked: true, issues: [], reviewed_by: c.reviewedBy, reviewed_at: c.reviewedAt?.toISOString() ?? null },
      };
    });

    const gaps = job.documents
      .filter((d) => d.status !== 'fetched')
      .map((d, i) => ({
        gap_id: `GAP-S${run}-${String(i + 1).padStart(3, '0')}`,
        domain_id: domainId,
        batch_id: `${job.batchCode}-S${run}`,
        topic: d.title ?? d.documentId ?? d.url,
        question: `Source could not be read: ${d.title ?? d.documentId ?? d.url}`,
        gap_type: d.status === 'blocked' ? 'RESTRICTED_SOURCE' : 'MISSING_SOURCE',
        severity: 'NORMAL',
        status: d.status === 'blocked' ? 'BLOCKED' : 'OPEN',
        source_refs: [d.sourceId ?? d.url],
        resolution_record_refs: [],
        notes: [d.blockReason, d.revision ? `Revision: ${d.revision}` : null, `URL: ${d.url}`].filter(Boolean).join(' '),
      }));

    const counts = {
      records: records.length,
      verified: records.filter((r) => r.trust_state === 'VERIFIED').length,
      conditional: records.filter((r) => r.trust_state === 'CONDITIONAL').length,
      derived: 0,
      unresolved: records.filter((r) => r.trust_state === 'UNRESOLVED').length,
      relationships: 0,
      handoffs: 0,
    };
    const allCandidates = await prisma.ekabCandidate.groupBy({ by: ['status'], where: { jobId }, _count: { _all: true } });
    const candidateCounts = Object.fromEntries(allCandidates.map((c) => [c.status, c._count._all]));
    return {
      canonical: {
        schema_version: 'track-b-ekab-1.0',
        release_id: releaseId,
        track: 'B',
        domain_id: domainId,
        domain_name: DOMAINS[domainId].name,
        batch_id: `${job.batchCode}-S${run}`,
        release_status: 'QA_PENDING',
        generated_at: generatedAt,
        producer: { provider: 'internal', model: 'embedo-source-scraper (deterministic, no AI)', run_id: job.id },
        governance: { note: 'Awaiting QA approval in EKAB.', curated_by: [...reviewers] },
        source_snapshot_id: `SRC-SNAPSHOT-S${run}`,
        counts,
        records,
        relationships: [],
        cross_domain_handoffs: [],
      },
      sourceManifest: { evidence },
      gapRegistry: { gaps },
      qaReport: {
        produced_by: 'embedo-source-scraper',
        method: 'Every record is a verbatim passage (or table row) accepted by a human reviewer; no AI was used.',
        candidates: candidateCounts,
        documents: job.documents.map((d) => ({ url: d.url, status: d.status, reason: d.blockReason })),
        coverage: 'Not assessed automatically: check the batch scope before approving QA.',
      },
      completionReport: { release_id: releaseId, batch_code: job.batchCode, scrape_job: job.id, records: records.length, gaps: gaps.length, decision: 'QA_PENDING' },
    };
  },

  /** Builds the release from accepted candidates and hands it to EKAB ingestion (RECEIVED). */
  async build(jobId: string, input: { version?: string }, actor: Actor) {
    const job = await prisma.ekabScrapeJob.findUnique({ where: { id: jobId }, select: { status: true, domainId: true } });
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Scrape job not found');
    if (job.status !== 'ready') throw new AppError(409, 'CONFLICT', `Only a ready job can be built (this one is ${job.status}).`);
    const accepted = await prisma.ekabCandidate.count({ where: { jobId, status: 'accepted' } });
    if (accepted === 0) throw new AppError(400, 'BAD_REQUEST', 'Accept at least one candidate before building a release.');
    const version = input.version ?? (await this.suggestVersion(job.domainId));
    const pkg = await this.buildPackage(jobId, version);
    // Fail fast on anything the validator would reject, before a release row exists.
    const check = validateRelease(pkg);
    if (check.rejected) throw new AppError(400, 'VALIDATION_ERROR', 'The built release does not pass validation.', { issues: check.issues.filter((i) => i.severity === 'error') });
    const { release } = await ekabReleaseService.receive(pkg, actor);
    await prisma.ekabScrapeJob.update({ where: { id: jobId }, data: { status: 'built', releaseId: release.releaseId } });
    return { release, accepted };
  },
};
