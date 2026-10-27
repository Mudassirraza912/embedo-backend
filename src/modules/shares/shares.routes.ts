import { Router } from 'express';
import { requireAuth } from '../../common/middlewares/auth.middleware.js';
import { validate } from '../../common/middlewares/validate.middleware.js';
import { sharesController } from './shares.controller.js';
import { sessionIdParamSchema } from '../sessions/sessions.validation.js';
import {
  createShareLinkSchema,
  shareTargetPreferenceSchema,
  shareLinkIdParamSchema,
  shareTokenParamSchema,
} from './shares.validation.js';

const router = Router();

router.get(
  '/sessions/:id/share-preference',
  requireAuth,
  validate({ params: sessionIdParamSchema }),
  sharesController.getTargetPreference
);
router.patch(
  '/sessions/:id/share-preference',
  requireAuth,
  validate({ params: sessionIdParamSchema, body: shareTargetPreferenceSchema }),
  sharesController.updateTargetPreference
);
router.post(
  '/sessions/:id/share-links',
  requireAuth,
  validate({ params: sessionIdParamSchema, body: createShareLinkSchema }),
  sharesController.createLink
);
router.delete(
  '/share-links/:linkId',
  requireAuth,
  validate({ params: shareLinkIdParamSchema }),
  sharesController.revokeLink
);
router.get('/share-links/:token', validate({ params: shareTokenParamSchema }), sharesController.getViewer);

export const sharesRoutes = router;
