import { Router } from 'express';
import { adminController } from './admin.controller.js';
import { requireAuth, requireRole } from '../../common/middlewares/auth.middleware.js';
import { validate } from '../../common/middlewares/validate.middleware.js';
import {
  ingestUrlQuerySchema,
  ingestUrlBodySchema,
  ingestJsonBodySchema,
  ingestBatchSchema,
  listComponentsQuerySchema,
  userIdParamSchema,
  partNumberParamSchema,
  revisionsQuerySchema,
  planParamSchema,
  updatePlanBodySchema,
  updateUserLimitsBodySchema,
} from './admin.validation.js';

import { hardwareAdminController } from '../hardware/hardware-admin.controller.js';
import {
  hardwareEntityParamSchema,
  hardwareGovernanceSchema,
  hardwareListQuerySchema,
  hardwareUploadSchema,
  proposalApproveSchema,
  proposalListQuerySchema,
  proposalParamSchema,
  proposalRejectSchema,
  proposalSubmitSchema,
} from '../hardware/hardware.validation.js';

import { ekabAdminController } from '../ekab/ekab-admin.controller.js';
import {
  approveQaSchema,
  promoteSchema,
  recordListQuerySchema,
  rejectSchema,
  releaseListQuerySchema,
  releaseParamSchema,
  releaseUploadSchema,
  sourceDomainCreateSchema,
  sourceDomainParamSchema,
  sourceDomainUpdateSchema,
} from '../ekab/ekab.validation.js';
import {
  buildReleaseSchema,
  candidateBulkSchema,
  candidateListQuerySchema,
  candidateParamSchema,
  candidateReviewSchema,
  scrapeJobListQuerySchema,
  scrapeJobParamSchema,
  scrapeJobSchema,
} from '../ekab/scrape/ekab-scrape.validation.js';

const router = Router();

// Every admin route requires an authenticated admin.
router.use(requireAuth, requireRole('admin'));

router.get('/components/ingest/stream', validate({ query: ingestUrlQuerySchema }), adminController.ingestStream);
router.post('/components/ingest', validate({ body: ingestUrlBodySchema }), adminController.ingestDirect);
router.post('/components/ingest/json', validate({ body: ingestJsonBodySchema }), adminController.ingestJson);
router.post('/components/ingest/batch', validate({ body: ingestBatchSchema }), adminController.ingestBatch);
router.get(
  '/components/:partNumber/revisions',
  validate({ params: partNumberParamSchema, query: revisionsQuerySchema }),
  adminController.listRevisions
);
router.get('/components', validate({ query: listComponentsQuerySchema }), adminController.listComponents);

// Usage limits per plan, spend overview, and per-user overrides
router.get('/plans', adminController.listPlans);
router.put('/plans/:plan', validate({ params: planParamSchema, body: updatePlanBodySchema }), adminController.updatePlan);
router.get('/usage/summary', adminController.usageSummary);

// Prototype hardware library: boards are uploaded here, stored in the database and embedded.
router.get('/hardware', validate({ query: hardwareListQuerySchema }), hardwareAdminController.list);
router.post('/hardware', validate({ body: hardwareUploadSchema }), hardwareAdminController.create);
router.post('/hardware/validate', validate({ body: hardwareUploadSchema }), hardwareAdminController.validate);
router.post('/hardware/embeddings/backfill', hardwareAdminController.embedMissing);
// Review queue: scraped hardware waits here until an admin accepts it into the library.
router.get('/hardware/proposals', validate({ query: proposalListQuerySchema }), hardwareAdminController.listProposals);
router.post('/hardware/proposals', validate({ body: proposalSubmitSchema }), hardwareAdminController.submitProposal);
router.get('/hardware/proposals/:proposalId', validate({ params: proposalParamSchema }), hardwareAdminController.getProposal);
router.put('/hardware/proposals/:proposalId', validate({ params: proposalParamSchema, body: hardwareUploadSchema }), hardwareAdminController.editProposal);
router.post(
  '/hardware/proposals/:proposalId/approve',
  validate({ params: proposalParamSchema, body: proposalApproveSchema }),
  hardwareAdminController.approveProposal
);
router.post(
  '/hardware/proposals/:proposalId/reject',
  validate({ params: proposalParamSchema, body: proposalRejectSchema }),
  hardwareAdminController.rejectProposal
);
router.get('/hardware/:id', validate({ params: hardwareEntityParamSchema }), hardwareAdminController.get);
router.put('/hardware/:id', validate({ params: hardwareEntityParamSchema, body: hardwareUploadSchema }), hardwareAdminController.replace);
router.patch(
  '/hardware/:id/governance',
  validate({ params: hardwareEntityParamSchema, body: hardwareGovernanceSchema }),
  hardwareAdminController.updateGovernance
);
router.post('/hardware/:id/embed', validate({ params: hardwareEntityParamSchema }), hardwareAdminController.embed);

// Domain knowledge (EKAB, Track B releases): upload -> worker stages -> admin approves QA -> promote.
router.get('/knowledge/overview', ekabAdminController.overview);
router.get('/knowledge/domains', ekabAdminController.domains);
router.get('/knowledge/releases', validate({ query: releaseListQuerySchema }), ekabAdminController.list);
router.post('/knowledge/releases', validate({ body: releaseUploadSchema }), ekabAdminController.upload);
router.post('/knowledge/releases/validate', validate({ body: releaseUploadSchema }), ekabAdminController.validate);
router.post('/knowledge/embeddings/backfill', ekabAdminController.embedMissing);
router.get('/knowledge/releases/:releasePk', validate({ params: releaseParamSchema }), ekabAdminController.get);
router.get('/knowledge/releases/:releasePk/records', validate({ params: releaseParamSchema, query: recordListQuerySchema }), ekabAdminController.records);
router.post('/knowledge/releases/:releasePk/reprocess', validate({ params: releaseParamSchema }), ekabAdminController.reprocess);
router.post('/knowledge/releases/:releasePk/approve-qa', validate({ params: releaseParamSchema, body: approveQaSchema }), ekabAdminController.approveQa);
router.post('/knowledge/releases/:releasePk/promote', validate({ params: releaseParamSchema, body: promoteSchema }), ekabAdminController.promote);
router.post('/knowledge/releases/:releasePk/reject', validate({ params: releaseParamSchema, body: rejectSchema }), ekabAdminController.reject);
// Websites the source scraper may read (RESTRICTED ones are never fetched).
router.get('/knowledge/source-domains', ekabAdminController.listSourceDomains);
router.post('/knowledge/source-domains', validate({ body: sourceDomainCreateSchema }), ekabAdminController.createSourceDomain);
router.post('/knowledge/source-domains/recommended', ekabAdminController.addRecommendedSourceDomains);
router.patch(
  '/knowledge/source-domains/:id',
  validate({ params: sourceDomainParamSchema, body: sourceDomainUpdateSchema }),
  ekabAdminController.updateSourceDomain
);
router.delete('/knowledge/source-domains/:id', validate({ params: sourceDomainParamSchema }), ekabAdminController.removeSourceDomain);
// Source scraper: fetch allowlisted sources (no AI) -> review candidates -> build a QA_PENDING release.
router.get('/knowledge/scrape-jobs', validate({ query: scrapeJobListQuerySchema }), ekabAdminController.listScrapeJobs);
router.post('/knowledge/scrape-jobs', validate({ body: scrapeJobSchema }), ekabAdminController.createScrapeJob);
router.get('/knowledge/scrape-jobs/:jobId', validate({ params: scrapeJobParamSchema }), ekabAdminController.getScrapeJob);
router.get(
  '/knowledge/scrape-jobs/:jobId/candidates',
  validate({ params: scrapeJobParamSchema, query: candidateListQuerySchema }),
  ekabAdminController.listCandidates
);
router.post(
  '/knowledge/scrape-jobs/:jobId/candidates/bulk',
  validate({ params: scrapeJobParamSchema, body: candidateBulkSchema }),
  ekabAdminController.reviewCandidates
);
router.post('/knowledge/scrape-jobs/:jobId/build', validate({ params: scrapeJobParamSchema, body: buildReleaseSchema }), ekabAdminController.buildRelease);
router.patch('/knowledge/candidates/:candidateId', validate({ params: candidateParamSchema, body: candidateReviewSchema }), ekabAdminController.reviewCandidate);

// User Governance & Moderation Suspension Management
router.get('/users', adminController.listUsers);
router.patch('/users/:id/limits', validate({ params: userIdParamSchema, body: updateUserLimitsBodySchema }), adminController.updateUserLimits);
router.post('/users/:id/unsuspend', validate({ params: userIdParamSchema }), adminController.unsuspendUser);

export const adminRoutes = router;
