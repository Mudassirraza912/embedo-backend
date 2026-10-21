import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../common/errors/AppError.js';
import { enqueueEkab } from '../../jobs/ekab.queue.js';
import { DOMAINS, DOMAIN_IDS } from './ekab.constants.js';
import { ekabReleaseService } from './ekab-release.service.js';
import { ekabEmbeddingService } from './ekab-embedding.service.js';
import { ekabSourceDomainService } from './ekab-source-domain.service.js';
import { validateRelease } from './ekab-validator.js';
import { ReleaseUploadInput, SourceDomainInput } from './ekab.validation.js';
import { COVERAGE_BATCHES } from './ekab-batches.js';
import { ekabScrapeService } from './scrape/ekab-scrape.service.js';
import { ScrapeJobInput } from './scrape/ekab-scrape.validation.js';

/** Admin endpoints for EKAB / Track B domain knowledge (mounted under /admin/knowledge, admin-only). */
const actorOf = (req: Request) => ({ userId: req.user?.id ?? null, label: req.user?.email ?? req.user?.id ?? 'admin' });
const releasePk = (req: Request) => req.params['releasePk'] as string;

export class EkabAdminController {
  overview = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabReleaseService.overview() });
    } catch (err) {
      next(err);
    }
  };

  /** Domains with their coverage batches (from the Track B coverage spec). */
  domains = (_req: Request, res: Response): void => {
    res.status(200).json({
      success: true,
      data: DOMAIN_IDS.map((id) => ({ domainId: id, ...DOMAINS[id], batches: COVERAGE_BATCHES.filter((b) => b.domainId === id) })),
    });
  };

  /** Dry run for the upload form: the validator's verdict without storing anything. */
  validate = (req: Request, res: Response, next: NextFunction): void => {
    try {
      const result = validateRelease(req.body as ReleaseUploadInput);
      res.status(200).json({
        success: true,
        data: {
          releaseId: result.release?.releaseId ?? null,
          wouldBe: result.rejected ? 'REJECTED' : result.quarantined.size > 0 ? 'QUARANTINED' : 'STAGED',
          counts: { ...result.counts, quarantined: result.quarantined.size },
          issues: result.issues,
          // Cross-release references are only resolved when the release is really staged.
          note: 'References to records in earlier releases are checked when the release is staged.',
        },
      });
    } catch (err) {
      next(err);
    }
  };

  /** Stores the package (RECEIVED) and queues staging in the worker. */
  upload = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { release, duplicate } = await ekabReleaseService.receive(req.body as ReleaseUploadInput, actorOf(req));
      if (!duplicate) await enqueueEkab({ kind: 'stage', releasePk: release.id });
      res.status(duplicate ? 200 : 202).json({ success: true, data: { release, duplicate } });
    } catch (err) {
      next(err);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabReleaseService.list(req.query as never) });
    } catch (err) {
      next(err);
    }
  };

  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabReleaseService.get(releasePk(req)) });
    } catch (err) {
      next(err);
    }
  };

  records = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabReleaseService.listRecords(releasePk(req), req.query as never) });
    } catch (err) {
      next(err);
    }
  };

  /** Re-queues staging of a RECEIVED release, or the round-trip + embeddings of a loaded one. */
  reprocess = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const release = await ekabReleaseService.get(releasePk(req));
      if (release.ingestionState === 'RECEIVED') await enqueueEkab({ kind: 'stage', releasePk: release.id });
      else if (['STAGED', 'QUARANTINED', 'PROMOTED'].includes(release.ingestionState)) await enqueueEkab({ kind: 'recheck', releasePk: release.id });
      else throw new AppError(409, 'CONFLICT', `A ${release.ingestionState} release has nothing to reprocess.`);
      res.status(202).json({ success: true, data: { queued: true, ingestionState: release.ingestionState } });
    } catch (err) {
      next(err);
    }
  };

  approveQa = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabReleaseService.approveQa(releasePk(req), req.body as never, actorOf(req)) });
    } catch (err) {
      next(err);
    }
  };

  promote = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabReleaseService.promote(releasePk(req), req.body as never, actorOf(req)) });
    } catch (err) {
      next(err);
    }
  };

  reject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { notes } = req.body as { notes: string };
      res.status(200).json({ success: true, data: await ekabReleaseService.reject(releasePk(req), notes, actorOf(req)) });
    } catch (err) {
      next(err);
    }
  };

  /** Embeds every usable record still missing a vector (e.g. saved while embeddings were down). */
  embedMissing = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabEmbeddingService.embedPending({ limit: 2000 }) });
    } catch (err) {
      next(err);
    }
  };

  // --- scrape source allowlist ---------------------------------------------------------------------
  listSourceDomains = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabSourceDomainService.list() });
    } catch (err) {
      next(err);
    }
  };

  createSourceDomain = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(201).json({ success: true, data: await ekabSourceDomainService.create(req.body as SourceDomainInput, actorOf(req)) });
    } catch (err) {
      next(err);
    }
  };

  updateSourceDomain = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patch = req.body as Record<string, unknown>;
      if (Object.keys(patch).length === 0) throw new AppError(400, 'BAD_REQUEST', 'Nothing to update');
      res.status(200).json({ success: true, data: await ekabSourceDomainService.update(req.params['id'] as string, patch) });
    } catch (err) {
      next(err);
    }
  };

  removeSourceDomain = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabSourceDomainService.remove(req.params['id'] as string) });
    } catch (err) {
      next(err);
    }
  };

  addRecommendedSourceDomains = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabSourceDomainService.addRecommended(actorOf(req)) });
    } catch (err) {
      next(err);
    }
  };

  // --- source scraper (deterministic, no AI) -------------------------------------------------------
  createScrapeJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const job = await ekabScrapeService.createJob(req.body as ScrapeJobInput, actorOf(req));
      await enqueueEkab({ kind: 'scrape', jobId: job.id });
      res.status(202).json({ success: true, data: job });
    } catch (err) {
      next(err);
    }
  };

  listScrapeJobs = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabScrapeService.listJobs(req.query as never) });
    } catch (err) {
      next(err);
    }
  };

  getScrapeJob = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabScrapeService.getJob(req.params['jobId'] as string) });
    } catch (err) {
      next(err);
    }
  };

  listCandidates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabScrapeService.listCandidates(req.params['jobId'] as string, req.query as never) });
    } catch (err) {
      next(err);
    }
  };

  reviewCandidate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabScrapeService.review(req.params['candidateId'] as string, req.body as never, actorOf(req)) });
    } catch (err) {
      next(err);
    }
  };

  reviewCandidates = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await ekabScrapeService.reviewMany(req.params['jobId'] as string, req.body as never, actorOf(req)) });
    } catch (err) {
      next(err);
    }
  };

  /** Turns the accepted candidates into a release (QA_PENDING) and queues its staging. */
  buildRelease = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await ekabScrapeService.build(req.params['jobId'] as string, req.body as never, actorOf(req));
      await enqueueEkab({ kind: 'stage', releasePk: result.release.id });
      res.status(202).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };
}

export const ekabAdminController = new EkabAdminController();
