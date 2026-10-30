import { Router } from 'express';
import { supportController } from './support.controller.js';
import { validate } from '../../common/middlewares/validate.middleware.js';
import { rateLimitSupportCreate } from '../../common/middlewares/rate-limit.middleware.js';
import { moderateInput } from '../governance/moderation.middleware.js';
import { createSupportCaseSchema, supportCaseIdParamSchema } from './support.validation.js';

const router = Router();

// Auth is optional (authenticate runs globally): a signed-in caller is identified by req.user,
// a guest by req.anonSessionToken + the guestContactEmail they provide.
router.post(
  '/cases',
  rateLimitSupportCreate,
  validate({ body: createSupportCaseSchema }),
  moderateInput(['subject', 'description']),
  supportController.createCase
);

router.get('/cases', supportController.listMine);
router.get('/cases/:id', validate({ params: supportCaseIdParamSchema }), supportController.getMine);

export const supportRoutes = router;
