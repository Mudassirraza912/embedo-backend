import { Request, Response, NextFunction } from 'express';
import { supportService } from './support.service.js';
import { AddSupportAttachmentInput, CreateSupportCaseInput } from './support.validation.js';

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

  addAttachment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = req.body as AddSupportAttachmentInput;
      const attachment = await supportService.addAttachment(req.params['id'] as string, input, req.user?.id, req.anonSessionToken);
      res.status(201).json({ success: true, data: attachment });
    } catch (err) {
      next(err);
    }
  };

  downloadAttachment = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const attachment = await supportService.getAttachmentForDownload(
        req.params['id'] as string,
        req.params['attachmentId'] as string,
        req.user?.id,
        req.anonSessionToken
      );
      res.setHeader('Content-Type', attachment.contentType);
      res.setHeader('Content-Disposition', `inline; filename="${attachment.filename.replace(/["\\]/g, '_')}"`);
      res.setHeader('Cache-Control', 'private, max-age=0, no-store');
      res.status(200).send(attachment.data);
    } catch (err) {
      next(err);
    }
  };
}

export const supportController = new SupportController();
