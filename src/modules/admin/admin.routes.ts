import { Router } from 'express';
import { adminController } from './admin.controller.js';
import { requireAuth, requireRole } from '../../common/middlewares/auth.middleware.js';
import { validate } from '../../common/middlewares/validate.middleware.js';
import {
  ingestUrlQuerySchema,
  ingestUrlBodySchema,
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

const router = Router();

// Every admin route requires an authenticated admin.
router.use(requireAuth, requireRole('admin'));

router.get('/components/ingest/stream', validate({ query: ingestUrlQuerySchema }), adminController.ingestStream);
router.post('/components/ingest', validate({ body: ingestUrlBodySchema }), adminController.ingestDirect);
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

// User Governance & Moderation Suspension Management
router.get('/users', adminController.listUsers);
router.patch('/users/:id/limits', validate({ params: userIdParamSchema, body: updateUserLimitsBodySchema }), adminController.updateUserLimits);
router.post('/users/:id/unsuspend', validate({ params: userIdParamSchema }), adminController.unsuspendUser);

export const adminRoutes = router;
