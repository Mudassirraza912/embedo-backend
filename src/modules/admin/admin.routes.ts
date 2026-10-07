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

// User Governance & Moderation Suspension Management
router.get('/users', adminController.listUsers);
router.patch('/users/:id/limits', validate({ params: userIdParamSchema, body: updateUserLimitsBodySchema }), adminController.updateUserLimits);
router.post('/users/:id/unsuspend', validate({ params: userIdParamSchema }), adminController.unsuspendUser);

export const adminRoutes = router;
