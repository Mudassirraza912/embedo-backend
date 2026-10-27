import { Request, Response, NextFunction } from 'express';
import { sharesService } from './shares.service.js';
import { CreateShareLinkInput, ShareTargetPreferenceInput } from './shares.validation.js';

export class SharesController {
  getTargetPreference = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const preference = await sharesService.getTargetPreference(req.params.id as string, req.user!.id);
      res.status(200).json({ data: preference });
    } catch (err) {
      next(err);
    }
  };

  updateTargetPreference = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const preference = await sharesService.updateTargetPreference(
        req.params.id as string,
        req.user!.id,
        (req.body as ShareTargetPreferenceInput).targetType
      );
      res.status(200).json({ data: preference });
    } catch (err) {
      next(err);
    }
  };

  createLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await sharesService.createLink(
        req.params.id as string,
        req.user!.id,
        req.body as CreateShareLinkInput,
        req.anonSessionToken
      );
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };

  getViewer = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const viewer = await sharesService.getViewer(req.params.token as string, req.user?.email);
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.status(200).json({ data: viewer });
    } catch (err) {
      next(err);
    }
  };

  revokeLink = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await sharesService.revokeLink(req.params.linkId as string, req.user!.id);
      res.status(200).json({ success: true });
    } catch (err) {
      next(err);
    }
  };
}

export const sharesController = new SharesController();
