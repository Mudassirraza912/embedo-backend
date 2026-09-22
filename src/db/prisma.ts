import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from '../config/logger.js';
import { env } from '../config/env.js';

export const prisma = new PrismaClient<
  Prisma.PrismaClientOptions,
  'query' | 'error' | 'info' | 'warn'
>({
  log:
    env.NODE_ENV === 'development'
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'event', level: 'error' },
          { emit: 'event', level: 'info' },
          { emit: 'event', level: 'warn' },
        ]
      : [{ emit: 'event', level: 'error' }],
});

if (env.NODE_ENV === 'development') {
  prisma.$on('query', (e: Prisma.QueryEvent) => {
    logger.trace({ query: e.query, params: e.params, duration: `${e.duration}ms` }, 'Prisma Query');
  });
}

prisma.$on('error', (e: Prisma.LogEvent) => {
  logger.error({ error: e.message }, 'Prisma Database Error');
});
