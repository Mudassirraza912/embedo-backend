import { Router } from 'express';
import { sessionsController } from './sessions.controller.js';
import { validate } from '../../common/middlewares/validate.middleware.js';
import { moderateInput } from '../governance/moderation.middleware.js';
import { rateLimitSessionCreation, rateLimitDiscuss } from '../../common/middlewares/rate-limit.middleware.js';
import {
  createSessionSchema,
  discussSchema,
  exportSchema,
  exportDownloadQuerySchema,
  feedbackSchema,
  outcomeSchema,
  sessionIdParamSchema,
  versionParamSchema,
} from './sessions.validation.js';

const router = Router();

// Order matters: rate limit -> validate (bounds) -> moderate (only validated, bounded text reaches the moderation API)
router.get('/', sessionsController.listSessions);

router.post(
  '/',
  rateLimitSessionCreation,
  validate({ body: createSessionSchema }),
  moderateInput(['intentText']),
  sessionsController.createSession
);

router.get('/:id', validate({ params: sessionIdParamSchema }), sessionsController.getSession);
router.delete('/:id', validate({ params: sessionIdParamSchema }), sessionsController.deleteSession);

router.post(
  '/:id/discuss',
  rateLimitDiscuss,
  validate({ params: sessionIdParamSchema, body: discussSchema }),
  moderateInput(['content']),
  sessionsController.discuss
);

// Explicit override of the sufficiency gate (best-effort draft) and retry of FAILED sessions.
router.post('/:id/force-generate', rateLimitDiscuss, validate({ params: sessionIdParamSchema }), sessionsController.forceGenerate);
router.post('/:id/retry', rateLimitDiscuss, validate({ params: sessionIdParamSchema }), sessionsController.retry);

router.get('/:id/architecture', validate({ params: sessionIdParamSchema }), sessionsController.getArchitecture);

router.get('/:id/versions', validate({ params: sessionIdParamSchema }), sessionsController.getVersions);
router.get('/:id/versions/:version', validate({ params: versionParamSchema }), sessionsController.getVersion);
router.post(
  '/:id/versions/:version/rollback',
  rateLimitDiscuss,
  validate({ params: versionParamSchema }),
  sessionsController.rollbackVersion
);

router.post(
  '/:id/feedback',
  rateLimitDiscuss,
  validate({ params: sessionIdParamSchema, body: feedbackSchema }),
  sessionsController.submitFeedback
);
router.post(
  '/:id/outcome',
  rateLimitDiscuss,
  validate({ params: sessionIdParamSchema, body: outcomeSchema }),
  sessionsController.recordOutcome
);

router.post('/:id/export', validate({ params: sessionIdParamSchema, body: exportSchema }), sessionsController.exportDesign);
router.get(
  '/:id/export/download',
  validate({ params: sessionIdParamSchema, query: exportDownloadQuerySchema }),
  sessionsController.downloadExport
);

export const sessionsRoutes = router;
