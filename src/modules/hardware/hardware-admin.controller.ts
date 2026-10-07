import { Request, Response, NextFunction } from 'express';
import { AppError } from '../../common/errors/AppError.js';
import { hardwareAdminService } from './hardware-admin.service.js';
import { hardwareEmbeddingService } from './hardware-embedding.service.js';
import { HardwareGovernanceInput, HardwareListQuery, HardwareUploadInput } from './hardware.validation.js';

/** Admin panel endpoints for the Prototype hardware library (mounted under /admin, admin-only). */
const actorOf = (req: Request) => ({ userId: req.user?.id ?? null, label: req.user?.email ?? req.user?.id ?? 'admin' });

export class HardwareAdminController {
  list = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await hardwareAdminService.list(req.query as unknown as HardwareListQuery) });
    } catch (err) {
      next(err);
    }
  };

  get = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await hardwareAdminService.get(req.params['id'] as string) });
    } catch (err) {
      next(err);
    }
  };

  /** Dry run for the upload form: validation issues without saving. */
  validate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: hardwareAdminService.validate(req.body as HardwareUploadInput) });
    } catch (err) {
      next(err);
    }
  };

  create = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await hardwareAdminService.save(req.body as HardwareUploadInput, actorOf(req), 'create');
      res.status(201).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };

  replace = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await hardwareAdminService.save(req.body as HardwareUploadInput, actorOf(req), 'replace', req.params['id'] as string);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };

  updateGovernance = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const patch = req.body as HardwareGovernanceInput;
      if (Object.keys(patch).length === 0) throw new AppError(400, 'BAD_REQUEST', 'Nothing to update');
      res.status(200).json({ success: true, data: await hardwareAdminService.updateGovernance(req.params['id'] as string, patch, actorOf(req)) });
    } catch (err) {
      next(err);
    }
  };

  embed = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const id = req.params['id'] as string;
      const result = await hardwareEmbeddingService.embedEntity(id, { force: true });
      if (result.outcome === 'not_found') throw new AppError(404, 'NOT_FOUND', 'Hardware entity not found');
      res.status(result.outcome === 'embedded' ? 200 : 502).json({ success: result.outcome === 'embedded', data: { hardwareEntityId: id, ...result } });
    } catch (err) {
      next(err);
    }
  };

  /** Embeds every board that has no vector yet (e.g. saved while embeddings were unavailable). */
  embedMissing = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      res.status(200).json({ success: true, data: await hardwareEmbeddingService.embedMissing() });
    } catch (err) {
      next(err);
    }
  };
}

export const hardwareAdminController = new HardwareAdminController();
