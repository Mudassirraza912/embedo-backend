import { Request, Response, NextFunction } from 'express';
import { sharesService } from './shares.service.js';
import { CreateShareLinkInput } from './shares.validation.js';

export class SharesController {
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
      const viewer = await sharesService.getViewer(req.params.token as string);
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
