import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../errors/AppError.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';

export const errorHandlerMiddleware: ErrorRequestHandler = (
  err: Error,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {
  const requestId = req.id || 'unknown';

  if (err instanceof AppError) {
    logger.warn(
      {
        requestId,
        code: err.code,
        message: err.message,
        details: err.details,
        path: req.path,
        method: req.method,
      },
      `AppError: ${err.message}`
    );

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        requestId,
        details: err.details || {},
      },
    });
    return;
  }

  // Handle Prisma Database Errors
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    logger.warn(
      {
        requestId,
        prismaCode: err.code,
        meta: err.meta,
        path: req.path,
        method: req.method,
      },
      `Prisma Known Request Error: ${err.code}`
    );

    if (err.code === 'P2002') {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : 'field';
      res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: `A record with this ${target} already exists.`,
          requestId,
          details: { target: err.meta?.target },
        },
      });
      return;
    }

    if (err.code === 'P2025') {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: 'The requested record was not found.',
          requestId,
          details: {},
        },
      });
      return;
    }

    if (err.code === 'P2003') {
      res.status(400).json({
        error: {
          code: 'FOREIGN_KEY_VIOLATION',
          message: 'Referenced related record does not exist or cannot be modified.',
          requestId,
          details: { field: err.meta?.field_name },
        },
      });
      return;
    }

    res.status(400).json({
      error: {
        code: 'DATABASE_ERROR',
        message: 'A database constraint error occurred.',
        requestId,
        details: env.NODE_ENV === 'development' ? { prismaCode: err.code, meta: err.meta } : {},
      },
    });
    return;
  }

  if (err instanceof Prisma.PrismaClientValidationError) {
    logger.warn({ requestId, err: err.message }, 'Prisma Validation Error');
    res.status(400).json({
      error: {
        code: 'INVALID_INPUT',
        message: 'Invalid data format provided for database operation.',
        requestId,
        details: {},
      },
    });
    return;
  }

  // Unhandled internal server errors
  logger.error(
    {
      requestId,
      err: err.stack || err.message,
      path: req.path,
      method: req.method,
    },
    `Unhandled Server Error: ${err.message}`
  );

  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message:
        env.NODE_ENV === 'production'
          ? 'An unexpected error occurred. Please try again later.'
          : err.message,
      requestId,
      details: env.NODE_ENV === 'development' ? { stack: err.stack } : {},
    },
  });
};
