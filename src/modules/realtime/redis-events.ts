import { Redis } from 'ioredis';
import { env } from '../../config/env.js';
import { logger } from '../../config/logger.js';
import { Server } from 'socket.io';

/**
 * Worker -> API event bridge.
 * The BullMQ worker runs in a separate process with no Socket.IO server, so it publishes
 * session events to Redis; every API process subscribes and forwards them into the
 * session room via Socket.IO (which fans out cluster-wide through the Redis adapter).
 */

const CHANNEL_PREFIX = 'embedo:events:session:';

let publisher: Redis | null = null;
let subscriber: Redis | null = null;

const createClient = (label: string): Redis => {
  const client = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    lazyConnect: true,
  });
  client.on('error', (err: unknown) => logger.error({ err, label }, 'Redis event client error'));
  client.connect().catch((err: unknown) => logger.error({ err, label }, 'Redis event client failed to connect'));
  return client;
};

const getRedisPublisher = (): Redis => {
  if (!publisher) publisher = createClient('publisher');
  return publisher;
};

export const publishSessionEvent = async (
  sessionId: string,
  eventName: string,
  payload: Record<string, unknown>
): Promise<void> => {
  try {
    const message = JSON.stringify({ eventName, payload });
    await getRedisPublisher().publish(`${CHANNEL_PREFIX}${sessionId}`, message);
  } catch (err: unknown) {
    logger.error({ err, sessionId, eventName }, 'Failed to publish session event to Redis');
  }
};

export const initSessionEventSubscriber = (io: Server): void => {
  if (subscriber) return;

  subscriber = createClient('subscriber');

  subscriber.psubscribe(`${CHANNEL_PREFIX}*`, (err: Error | null | undefined) => {
    if (err) {
      logger.error({ err }, 'Failed to psubscribe to Redis session event channels');
    } else {
      logger.info(`Subscribed to Redis session event channels (${CHANNEL_PREFIX}*)`);
    }
  });

  subscriber.on('pmessage', (_pattern: string, channel: string, message: string) => {
    try {
      const sessionId = channel.slice(CHANNEL_PREFIX.length);
      const parsed = JSON.parse(message) as { eventName: string; payload: Record<string, unknown> };
      io.of('/ws/sessions').to(`session:${sessionId}`).emit(parsed.eventName, parsed.payload);
    } catch (err: unknown) {
      logger.error({ err, channel }, 'Failed to forward Redis session event to Socket.IO');
    }
  });
};

export const closeRealtimeConnections = async (): Promise<void> => {
  await Promise.all([
    publisher?.quit().catch(() => undefined),
    subscriber?.quit().catch(() => undefined),
  ]);
  publisher = null;
  subscriber = null;
};
