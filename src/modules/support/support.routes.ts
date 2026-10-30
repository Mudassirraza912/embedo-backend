import { Router } from 'express';
import { supportController } from './support.controller.js';
import { validate } from '../../common/middlewares/validate.middleware.js';
import { rateLimitSupportCreate } from '../../common/middlewares/rate-limit.middleware.js';
import { moderateInput } from '../governance/moderation.middleware.js';
import { addSupportAttachmentSchema, createSupportCaseSchema, supportAttachmentParamSchema, supportCaseIdParamSchema } from './support.validation.js';

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

// Optional evidence attachment (task_seven remainder). Reuses the create-case rate limiter (same
// per-IP budget) and no new moderation step -- there is no free text here, just a validated file.
router.post(
  '/cases/:id/attachments',
  rateLimitSupportCreate,
  validate({ params: supportCaseIdParamSchema, body: addSupportAttachmentSchema }),
  supportController.addAttachment
);
router.get(
  '/cases/:id/attachments/:attachmentId',
  validate({ params: supportAttachmentParamSchema }),
  supportController.downloadAttachment
);

export const supportRoutes = router;
