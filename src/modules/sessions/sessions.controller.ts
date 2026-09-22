import { Request, Response, NextFunction } from 'express';
import { sessionsService } from './sessions.service.js';
import {
  CreateSessionInput,
  DiscussInput,
  ExportInput,
  FeedbackInput,
  OutcomeInput,
} from './sessions.validation.js';

export class SessionsController {
  createSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const input = req.body as CreateSessionInput;
      const result = await sessionsService.createSession(
        input,
        req.user?.id,
        req.anonSessionToken,
        req.ip
      );

      res.status(201).json({
        success: true,
        data: {
          sessionId: result.session.id,
          status: result.session.status,
          intentText: result.session.intentText,
          createdAt: result.session.createdAt,
          ...(result.issuedAnonToken ? { anonSessionToken: result.issuedAnonToken } : {}),
        },
      });
    } catch (err) {
      next(err);
    }
  };

  listSessions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const sessions = await sessionsService.listSessions(
        req.user?.id,
        req.anonSessionToken
      );

      const data = sessions.map((s) => ({
        id: s.id,
        sessionId: s.id,
        projectName: s.intentText ? s.intentText.split(/\s+/).slice(0, 4).join(' ') : 'Untitled Project',
        intent: s.intentText,
        mode: s.applicationContext === 'rapid_prototyping' ? 'prototype' : 'architect',
        status: s.status,
        architecture: s.architecture,
        messages: s.chatMessages,
        createdAt: s.createdAt.getTime(),
        savedAt: s.updatedAt.getTime(),
      }));

      res.status(200).json({
        success: true,
        data,
      });
    } catch (err) {
      next(err);
    }
  };

  getSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const session = await sessionsService.getSession(
        id as string,
        req.user?.id,
        req.anonSessionToken
      );

      // Safe response DTO stripping internal credentials
      const sanitizedSession = {
        id: session.id,
        userId: session.userId,
        intentText: session.intentText,
        intentStructured: session.intentStructured,
        domain: session.domain,
        applicationContext: session.applicationContext,
        status: session.status,
        architecture: session.architecture,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        chatMessages: session.chatMessages,
        userFeedback: session.userFeedback,
        designOutcome: session.designOutcome,
      };

      res.status(200).json({
        success: true,
        data: sanitizedSession,
      });
    } catch (err) {
      next(err);
    }
  };

  deleteSession = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      await sessionsService.deleteSession(
        id as string,
        req.user?.id,
        req.anonSessionToken
      );

      res.status(200).json({
        success: true,
        message: 'Design session deleted successfully',
      });
    } catch (err) {
      next(err);
    }
  };

  discuss = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const input = req.body as DiscussInput;
      const result = await sessionsService.discuss(
        id as string,
        input,
        req.user?.id,
        req.anonSessionToken
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };

  getArchitecture = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const result = await sessionsService.getArchitecture(
        id as string,
        req.user?.id,
        req.anonSessionToken
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };

  getVersions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const result = await sessionsService.getVersions(
        id as string,
        req.user?.id,
        req.anonSessionToken
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };

  getVersion = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id, version } = req.params;
      const result = await sessionsService.getVersion(
        id as string,
        version as string,
        req.user?.id,
        req.anonSessionToken
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };

  rollbackVersion = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id, version } = req.params;
      const result = await sessionsService.rollbackVersion(
        id as string,
        version as string,
        req.user?.id,
        req.anonSessionToken
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };

  submitFeedback = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const input = req.body as FeedbackInput;
      const feedback = await sessionsService.submitFeedback(
        id as string,
        input,
        req.user?.id,
        req.anonSessionToken
      );

      res.status(201).json({
        success: true,
        data: feedback,
      });
    } catch (err) {
      next(err);
    }
  };

  recordOutcome = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const input = req.body as OutcomeInput;
      const outcome = await sessionsService.recordOutcome(
        id as string,
        input,
        req.user?.id,
        req.anonSessionToken
      );

      res.status(200).json({
        success: true,
        data: outcome,
      });
    } catch (err) {
      next(err);
    }
  };

  exportDesign = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const input = req.body as ExportInput;
      const result = await sessionsService.exportDesign(
        id as string,
        input,
        req.user?.id,
        req.anonSessionToken
      );

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  };
  forceGenerate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const result = await sessionsService.forceGenerate(id as string, req.user?.id, req.anonSessionToken);
      res.status(202).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };

  retry = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const result = await sessionsService.retry(id as string, req.user?.id, req.anonSessionToken);
      res.status(202).json({ success: true, data: result });
    } catch (err) {
      next(err);
    }
  };

  downloadExport = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const format = (req.query as { format: 'kicad' | 'altium' | 'svg' | 'json' }).format;
      const file = await sessionsService.buildExportFile(id as string, format, req.user?.id, req.anonSessionToken);
      res.setHeader('Content-Type', file.contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(file.body);
    } catch (err) {
      next(err);
    }
  };
}

export const sessionsController = new SessionsController();
