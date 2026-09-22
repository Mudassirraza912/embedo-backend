import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      id: string;
    }
  }
}

// Only accept client-supplied request ids that are safe to log and echo: short, printable, no separators.
const SAFE_REQUEST_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export const requestIdMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const incomingId = req.headers['x-request-id'];
  const requestId =
    typeof incomingId === 'string' && SAFE_REQUEST_ID.test(incomingId) ? incomingId : uuidv4();

  req.id = requestId;
  res.setHeader('x-request-id', requestId);
  next();
};
