import { Router } from 'express';
import { usersController } from './users.controller.js';
import { requireAuth } from '../../common/middlewares/auth.middleware.js';
import { validate } from '../../common/middlewares/validate.middleware.js';
import {
  updateProfileSchema,
  updateConsentSchema,
  deleteAccountSchema,
  shareSettingsSchema,
} from './users.validation.js';

const router = Router();

router.use(requireAuth);

router.get('/me', usersController.getProfile);
router.patch('/me', validate({ body: updateProfileSchema }), usersController.updateProfile);
router.post('/me/consent', validate({ body: updateConsentSchema }), usersController.updateConsent);
router.delete('/me', validate({ body: deleteAccountSchema }), usersController.deleteAccount);
router.get('/me/share-settings', usersController.getShareSettings);
router.patch('/me/share-settings', validate({ body: shareSettingsSchema }), usersController.updateShareSettings);

export const usersRoutes = router;
