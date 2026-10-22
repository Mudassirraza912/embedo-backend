import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../common/errors/AppError.js';
import { adminPortalAccessService, MAX_ENTRIES } from './admin-portal-access.service.js';
import type { PortalAccessCreateBody, PortalAccessUpdateBody } from './admin-portal-access.validation.js';

export class AdminPortalAccessController {
  /** The list, plus the caller's own address as this API sees it, so an admin can add themselves. */
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const entries = await adminPortalAccessService.list();
      res.status(200).json({
        entries,
        yourIp: req.ip ?? null,
        maxEntries: MAX_ENTRIES,
        portal: 'https://admin.embedo.ai',
        note: 'Changes reach admin.embedo.ai within about a minute. An empty list blocks everyone.',
      });
    } catch (err) {
      next(err);
    }
  };

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(201).json({ entry: await adminPortalAccessService.create(req.user?.id ?? null, req.body as PortalAccessCreateBody) });
    } catch (err) {
      next(err);
    }
  };

  update = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params as { id: string };
      if (Object.keys(req.body ?? {}).length === 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Provide at least one field to change');
      }
      res.status(200).json({ entry: await adminPortalAccessService.update(req.user?.id ?? null, id, req.body as PortalAccessUpdateBody) });
    } catch (err) {
      next(err);
    }
  };

  remove = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params as { id: string };
      await adminPortalAccessService.remove(req.user?.id ?? null, id);
      res.status(200).json({ removed: true, id });
    } catch (err) {
      next(err);
    }
  };
}

export const adminPortalAccessController = new AdminPortalAccessController();
