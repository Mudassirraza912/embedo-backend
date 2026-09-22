import { Request, Response, NextFunction } from 'express';
import { usersService } from './users.service.js';

export class UsersController {
  getProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const profile = await usersService.getProfile(req.user!.id);
      res.status(200).json({ user: profile });
    } catch (err) {
      next(err);
    }
  };

  updateProfile = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await usersService.updateProfile(req.user!.id, req.body);
      res.status(200).json({ user });
    } catch (err) {
      next(err);
    }
  };

  updateConsent = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const user = await usersService.updateConsent(req.user!.id, req.body.dataConsent);
      res.status(200).json({ user });
    } catch (err) {
      next(err);
    }
  };

  deleteAccount = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await usersService.deleteAccount(req.user!.id, req.body?.password);
      res.clearCookie('refreshToken', { path: '/api/v1/auth' });
      res.status(200).json(result);
    } catch (err) {
      next(err);
    }
  };
}

export const usersController = new UsersController();
