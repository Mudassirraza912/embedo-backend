import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import jwt from 'jsonwebtoken';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { redis } from '../../db/redis.js';
import { userSuspensionKey } from '../../common/middlewares/auth.middleware.js';
import { publishSessionEvent, initSessionEventSubscriber } from './redis-events.js';

export interface StageUpdatePayload {
  step: number;
  label: string;
  progress: number;
}

export interface PipelineStepPayload {
  stepId: string;
  label: string;
  detail?: string;
  status: 'running' | 'completed' | 'warning' | 'failed';
  icon?: 'search' | 'cpu' | 'check' | 'power' | 'wiring' | 'diagram';
  elapsedMs?: number;
}

export interface AiCallCompletedPayload {
  taskCase: string;
  schemaPass: boolean;
  latencyMs?: number;
}

let io: Server | null = null;

const firstString = (...values: unknown[]): string | undefined => {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
};

export const initSocketIO = (httpServer: HttpServer): Server => {
  const allowedOrigins = env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

  io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
    path: '/socket.io',
  });

  // Redis adapter so rooms/broadcasts work across PM2 cluster workers.
  // ioredis connects asynchronously: attach error listeners so a Redis blip never becomes an
  // unhandled 'error' event (which would crash the process).
  const pubClient = new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: null });
  const subClient = pubClient.duplicate();
  for (const [label, client] of [
    ['adapter-pub', pubClient],
    ['adapter-sub', subClient],
  ] as const) {
    client.on('error', (err: unknown) => logger.error({ err, label }, 'Socket.IO Redis adapter client error'));
    client.connect().catch((err: unknown) => logger.error({ err, label }, 'Socket.IO Redis adapter failed to connect'));
  }
  io.adapter(createAdapter(pubClient, subClient));
  logger.info('Socket.IO Redis adapter configured');

  const sessionNamespace = io.of('/ws/sessions');

  // Strict handshake authentication & tenancy authorization
  sessionNamespace.use(async (socket: Socket, next) => {
    try {
      const sessionId = firstString(socket.handshake.query.sessionId, socket.handshake.auth?.sessionId);
      if (!sessionId) return next(new Error('SESSION_ID_REQUIRED'));

      const rawAuth = firstString(socket.handshake.auth?.token, socket.handshake.headers?.authorization);
      let userId: string | undefined;

      if (rawAuth) {
        const token = rawAuth.startsWith('Bearer ') ? rawAuth.slice(7) : rawAuth;
        try {
          const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as { userId?: string };
          if (typeof decoded.userId !== 'string') return next(new Error('INVALID_ACCESS_TOKEN'));
          userId = decoded.userId;
        } catch {
          return next(new Error('INVALID_ACCESS_TOKEN'));
        }

        const suspended = await redis.get(userSuspensionKey(userId)).catch(() => null);
        if (suspended) return next(new Error('ACCOUNT_SUSPENDED'));
      }

      const anonSessionToken = firstString(
        socket.handshake.auth?.anonSessionToken,
        socket.handshake.headers?.['x-anon-session-token'],
        socket.handshake.query.anonSessionToken
      );

      const session = await prisma.designSession.findUnique({
        where: { id: sessionId },
        select: { id: true, userId: true, anonSessionToken: true },
      });
      if (!session) return next(new Error('SESSION_NOT_FOUND'));

      if (session.userId) {
        if (!userId || session.userId !== userId) return next(new Error('FORBIDDEN_SESSION_ACCESS'));
      } else if (session.anonSessionToken) {
        if (!anonSessionToken || session.anonSessionToken !== anonSessionToken) {
          return next(new Error('FORBIDDEN_SESSION_ACCESS'));
        }
      } else {
        return next(new Error('FORBIDDEN_SESSION_ACCESS'));
      }

      socket.data = { sessionId, userId, anonSessionToken };
      return next();
    } catch (err: unknown) {
      logger.error({ err }, 'Socket handshake failed');
      return next(new Error('UNAUTHORIZED'));
    }
  });

  sessionNamespace.on('connection', (socket: Socket) => {
    const sessionId = socket.data.sessionId as string;
    const roomName = `session:${sessionId}`;

    // The Redis adapter makes socket.join() an async round-trip; a client that hasn't finished
    // joining its room can miss pipeline events emitted immediately after connect, so hold the
    // 'connected' ack (and any downstream listeners keyed off it) until the join is confirmed.
    void (async () => {
      try {
        await socket.join(roomName);
        logger.info({ socketId: socket.id, roomName, sessionId }, 'Socket joined session room');
        socket.emit('connected', { sessionId });
      } catch (err: unknown) {
        logger.error({ err, socketId: socket.id, sessionId }, 'Socket failed to join session room');
        socket.disconnect(true);
      }
    })();

    socket.on('disconnect', (reason) => {
      logger.info({ socketId: socket.id, sessionId, reason }, 'Socket disconnected from session room');
    });
  });

  // Bridge worker-published events into this process's Socket.IO server
  initSessionEventSubscriber(io);

  logger.info('Socket.IO initialized on namespace /ws/sessions with Redis bridge');
  return io;
};

export const getIO = (): Server => {
  if (!io) throw new Error('Socket.IO has not been initialized. Call initSocketIO first.');
  return io;
};

/**
 * Single delivery path:
 *  - API process (io present): emit directly; the Redis adapter fans out to other API workers.
 *  - Worker process (io absent): publish to Redis; API subscribers forward into the room.
 * Doing both would deliver every event twice.
 */
const dispatch = (sessionId: string, eventName: string, payload: Record<string, unknown>): void => {
  if (io) {
    io.of('/ws/sessions').to(`session:${sessionId}`).emit(eventName, payload);
  } else {
    void publishSessionEvent(sessionId, eventName, payload);
  }
};

export const emitSessionEvent = {
  stageUpdate: (sessionId: string, payload: StageUpdatePayload) => dispatch(sessionId, 'stage_update', { ...payload }),
  pipelineStep: (sessionId: string, payload: PipelineStepPayload) => dispatch(sessionId, 'pipeline_step', { ...payload }),
  aiCallStarted: (sessionId: string, taskCase: string) => dispatch(sessionId, 'ai_call_started', { taskCase }),
  aiCallCompleted: (sessionId: string, payload: AiCallCompletedPayload) =>
    dispatch(sessionId, 'ai_call_completed', { ...payload }),
  clarificationNeeded: (sessionId: string, questions: string[]) =>
    dispatch(sessionId, 'clarification_needed', { questions }),
  rejected: (sessionId: string, reason: string) => dispatch(sessionId, 'rejected', { reason }),
  error: (sessionId: string, message: string, retryable: boolean = false) =>
    dispatch(sessionId, 'error', { message, retryable }),
  done: (sessionId: string, architecture: Record<string, unknown>) => dispatch(sessionId, 'done', { architecture }),
};
