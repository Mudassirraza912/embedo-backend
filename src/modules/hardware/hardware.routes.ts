import { Router } from 'express';
import { validate } from '../../common/middlewares/validate.middleware.js';
import { hardwareController } from './hardware.controller.js';
import { hardwareEntityParamSchema } from './hardware.validation.js';

const router = Router();

// Guests may run Prototype mode, so these follow the sessions routes: global auth (optional) and
// rate limits apply; private records are checked against project ownership in the controller.
router.get('/entities/:id', validate({ params: hardwareEntityParamSchema }), hardwareController.getEntity);
router.get('/entities/:id/svg', validate({ params: hardwareEntityParamSchema }), hardwareController.getSvg);

export const hardwareRoutes = router;
