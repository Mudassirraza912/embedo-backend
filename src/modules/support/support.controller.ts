import { Request, Response, NextFunction } from 'express';
import { supportService } from './support.service.js';
import { CreateSupportCaseInput } from './support.validation.js';

export class SupportController {
  createCase = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = req.body as CreateSupportCaseInput;
      const { case: supportCase, isDuplicate } = await supportService.createCase(input, req.user?.id, req.anonSessionToken);
      res.status(isDuplicate ? 200 : 201).json({
        success: true,
        data: {
          caseId: supportCase.id,
          status: supportCase.status,
          subcategory: supportCase.subcategory,
          createdAt: supportCase.createdAt,
          isDuplicate,
        },
      });
    } catch (err) {
      next(err);
    }
  };

  listMine = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const cases = await supportService.listMine(req.user?.id, req.anonSessionToken);
      res.status(200).json({ success: true, data: { cases } });
    } catch (err) {
      next(err);
    }
  };

  getMine = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const result = await supportService.getMine(req.params['id'] as string, req.user?.id, req.anonSessionToken);
      res.status(200).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };
}

export const supportController = new SupportController();
