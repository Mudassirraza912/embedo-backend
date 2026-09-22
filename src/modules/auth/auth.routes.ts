import { Router } from 'express';
import { authController } from './auth.controller.js';
import { validate } from '../../common/middlewares/validate.middleware.js';
import {
  registerSchema,
  loginSchema,
  refreshTokenSchema,
  googleAuthSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from './auth.validation.js';
import { rateLimitAuth, rateLimitPasswordReset } from '../../common/middlewares/rate-limit.middleware.js';

const router = Router();

router.post('/register', rateLimitAuth, validate({ body: registerSchema }), authController.register);
router.post('/login', rateLimitAuth, validate({ body: loginSchema }), authController.login);
router.post('/google', rateLimitAuth, validate({ body: googleAuthSchema }), authController.google);
router.post('/refresh', rateLimitAuth, validate({ body: refreshTokenSchema }), authController.refresh);
router.post('/logout', authController.logout);
router.post('/forgot-password', rateLimitPasswordReset, validate({ body: forgotPasswordSchema }), authController.forgotPassword);
router.post('/reset-password', rateLimitAuth, validate({ body: resetPasswordSchema }), authController.resetPassword);
router.get('/config', authController.getConfig);

export const authRoutes = router;

