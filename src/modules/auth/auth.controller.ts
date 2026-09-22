import { Request, Response, NextFunction } from 'express';
import { authService } from './auth.service.js';
import { env } from '../../config/env.js';

export class AuthController {
  private setRefreshCookie(res: Response, token: string) {
    res.cookie('refreshToken', token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: env.NODE_ENV === 'production' ? 'none' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: `${env.API_PREFIX}/auth`,
    });
  }

  register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await authService.register(req.body);
      this.setRefreshCookie(res, result.refreshToken);

      res.status(201).json({
        user: result.user,
        accessToken: result.accessToken,
      });
    } catch (err) {
      next(err);
    }
  };

  login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await authService.login(req.body);
      this.setRefreshCookie(res, result.refreshToken);

      res.status(200).json({
        user: result.user,
        accessToken: result.accessToken,
      });
    } catch (err) {
      next(err);
    }
  };

  google = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await authService.loginWithGoogle(req.body);
      this.setRefreshCookie(res, result.refreshToken);

      res.status(200).json({
        user: result.user,
        accessToken: result.accessToken,
      });
    } catch (err) {
      next(err);
    }
  };

  refresh = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = req.cookies?.refreshToken || req.body?.refreshToken;
      const result = await authService.refresh(token);
      this.setRefreshCookie(res, result.refreshToken);

      res.status(200).json({
        accessToken: result.accessToken,
      });
    } catch (err) {
      next(err);
    }
  };

  logout = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const token = req.cookies?.refreshToken || req.body?.refreshToken;
      await authService.logout(token);

      res.clearCookie('refreshToken', {
        httpOnly: true,
        path: `${env.API_PREFIX}/auth`,
      });

      res.status(200).json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
      next(err);
    }
  };

  forgotPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await authService.forgotPassword(req.body);
      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  };

  resetPassword = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await authService.resetPassword(req.body);
      res.status(200).json({
        success: true,
        ...result,
      });
    } catch (err) {
      next(err);
    }
  };

  getConfig = async (_req: Request, res: Response, _next: NextFunction): Promise<void> => {
    res.status(200).json({
      googleClientId: env.GOOGLE_CLIENT_ID || null,
    });
  };
}

export const authController = new AuthController();
