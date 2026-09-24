import { Request, Response, NextFunction } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { datasheetIngestionService, IngestionProgress } from '../components/datasheet-ingestion.service.js';
import { datasheetIngestQueue, getDatasheetIngestQueueEvents } from '../../jobs/datasheet-ingest.queue.js';
import { prisma } from '../../db/prisma.js';
import { redis } from '../../db/redis.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { AppError } from '../../common/errors/AppError.js';
import { userSuspensionKey } from '../../common/middlewares/auth.middleware.js';
import { IngestBatchInput, ListComponentsQuery, UpdatePlanBody, UpdateUserLimitsBody } from './admin.validation.js';
import { limitsService, PLAN_NAMES, DEFAULT_LIMITS, LIMIT_BOUNDS, computeEffective, type PlanName } from '../limits/limits.service.js';
import { IN_FLIGHT_STATUSES } from '../sessions/session-status.js';
import { Prisma } from '@prisma/client';

const manifestItemSchema = z.object({
  part_number: z.string().optional(),
  vendor: z.string().optional(),
  source_url: z.string().url().optional(),
});
type ManifestItem = z.infer<typeof manifestItemSchema>;

/** Manifest is optional config; resolved from a few known locations so both dev (src/) and Docker (dist/ + data/) work. */
const loadManifest = (): ManifestItem[] => {
  const candidates = [
    path.resolve(process.cwd(), 'src/data/datasheet_manifest.json'),
    path.resolve(process.cwd(), 'data/datasheet_manifest.json'),
  ];
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
      const parsed = z.array(manifestItemSchema).safeParse(raw);
      if (!parsed.success) {
        logger.warn({ file, issues: parsed.error.issues.slice(0, 3) }, 'Datasheet manifest failed validation; ignoring');
        return [];
      }
      return parsed.data;
    } catch (err) {
      logger.warn({ err, file }, 'Could not load datasheet manifest JSON');
    }
  }
  logger.warn('No datasheet manifest found (src/data or data/); batch ingestion will queue nothing');
  return [];
};

const manifestData: ManifestItem[] = loadManifest();

const SSE_KEEPALIVE_MS = 15_000;
const SSE_MAX_DURATION_MS = 20 * 60_000;

export class AdminController {
  /**
   * Streams the progress of a datasheet ingestion as Server-Sent Events.
   * The work runs exactly once, in the worker; this handler only relays queue events for that job.
   */
  ingestStream = async (req: Request, res: Response, _next: NextFunction): Promise<void> => {
    const { url } = req.query as { url: string };

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    let closed = false;
    const sendEvent = (event: string, data: unknown) => {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const keepAlive = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n');
    }, SSE_KEEPALIVE_MS);

    const events = getDatasheetIngestQueueEvents();
    let jobId: string | undefined;

    const onProgress = (args: { jobId: string; data: unknown }) => {
      if (args.jobId !== jobId) return;
      sendEvent('progress', args.data as IngestionProgress);
    };
    const onCompleted = (args: { jobId: string; returnvalue: unknown }) => {
      if (args.jobId !== jobId) return;
      sendEvent('done', { success: true, result: args.returnvalue });
      finish();
    };
    const onFailed = (args: { jobId: string; failedReason: string }) => {
      if (args.jobId !== jobId) return;
      sendEvent('error', { success: false, message: args.failedReason || 'Datasheet ingestion failed', code: 'INGESTION_ERROR' });
      finish();
    };

    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepAlive);
      clearTimeout(hardStop);
      events.off('progress', onProgress);
      events.off('completed', onCompleted);
      events.off('failed', onFailed);
      res.end();
    };

    const hardStop = setTimeout(() => {
      sendEvent('error', { success: false, message: 'Ingestion stream timed out', code: 'INGESTION_TIMEOUT' });
      finish();
    }, SSE_MAX_DURATION_MS);

    req.on('close', finish);

    events.on('progress', onProgress);
    events.on('completed', onCompleted);
    events.on('failed', onFailed);

    try {
      const job = await datasheetIngestQueue.add('admin-stream-ingest', { datasheetUrl: url, actorUserId: req.user?.id });
      jobId = job.id;
      sendEvent('start', { url, jobId, timestamp: new Date().toISOString() });
    } catch (err) {
      logger.error({ err, url }, 'Failed to enqueue streaming datasheet ingestion');
      sendEvent('error', { success: false, message: 'Could not enqueue ingestion job', code: 'INGESTION_ERROR' });
      finish();
    }
  };

  /**
   * Synchronous ingestion (admin tooling / scripts). Bounded by the same limits as the worker path.
   */
  ingestDirect = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { url } = req.body as { url: string };
    try {
      const result = await datasheetIngestionService.ingestFromUrl(url, { actorUserId: req.user?.id });
      res.status(200).json({ success: true, result });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Queues manifest items for ingestion (only manifest-listed URLs are accepted).
   */
  ingestBatch = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { vendor, urls, onlyPending } = req.body as IngestBatchInput;

      let targets = manifestData.filter((t) => Boolean(t.source_url));

      if (vendor && vendor !== 'all') {
        targets = targets.filter((t) => t.vendor?.toLowerCase() === vendor.toLowerCase());
      }
      if (urls && urls.length > 0) {
        const wanted = new Set(urls.map((u) => u.toLowerCase()));
        targets = targets.filter((t) => t.source_url && wanted.has(t.source_url.toLowerCase()));
      }

      if (onlyPending && targets.length > 0) {
        const partNumbers = targets.map((t) => t.part_number).filter((p): p is string => Boolean(p));
        const sourceUrls = targets.map((t) => t.source_url).filter((u): u is string => Boolean(u));
        const existing = await prisma.component.findMany({
          where: {
            OR: [
              ...(partNumbers.length ? [{ partNumber: { in: partNumbers, mode: 'insensitive' as const } }] : []),
              ...(sourceUrls.length ? [{ datasheetUrl: { in: sourceUrls, mode: 'insensitive' as const } }] : []),
            ],
          },
          select: { partNumber: true, datasheetUrl: true },
        });
        const existingParts = new Set(existing.map((c) => c.partNumber?.toLowerCase()));
        const existingUrls = new Set(existing.map((c) => c.datasheetUrl?.toLowerCase()));
        targets = targets.filter(
          (t) => !(t.part_number && existingParts.has(t.part_number.toLowerCase())) && !(t.source_url && existingUrls.has(t.source_url.toLowerCase()))
        );
      }

      const queuedJobs: Array<{ jobId: string | undefined; partNumber?: string; vendor?: string; url: string }> = [];
      for (const item of targets) {
        if (!item.source_url) continue;
        const job = await datasheetIngestQueue.add(
          `batch-ingest-${item.part_number || 'component'}`,
          { datasheetUrl: item.source_url, actorUserId: req.user?.id },
          // Deterministic id: re-running the batch never double-queues the same datasheet.
          { jobId: `ingest_${Buffer.from(item.source_url).toString('base64url').slice(0, 120)}` }
        );
        queuedJobs.push({ jobId: job.id, partNumber: item.part_number, vendor: item.vendor, url: item.source_url });
      }

      logger.info({ count: queuedJobs.length }, 'Enqueued batch datasheet ingestion jobs');
      res.status(200).json({
        success: true,
        queuedCount: queuedJobs.length,
        jobs: queuedJobs,
        message: `Queued ${queuedJobs.length} datasheet ingestion job(s).`,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Revision history for one component (checklist #16/#17): every archived revision, skipped
   * older-revision ingest and unresolved conflict, newest first. Snapshots are large, so they are
   * only returned on request.
   */
  listRevisions = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { partNumber } = req.params as { partNumber: string };
      const includeSnapshot = Boolean((req.query as { includeSnapshot?: boolean }).includeSnapshot);
      const component = await prisma.component.findUnique({ where: { partNumber }, select: { id: true, partNumber: true, specs: true } });
      if (!component) throw new AppError(404, 'NOT_FOUND', `Component ${partNumber} not found`);

      const rows = await prisma.auditLog.findMany({
        where: {
          entityId: component.id,
          action: { in: ['COMPONENT_REVISION_ARCHIVED', 'INGEST_REVISION_CONFLICT_SKIPPED', 'INGEST_REVISION_CONFLICT_UNRESOLVED'] },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
      });

      res.status(200).json({
        partNumber: component.partNumber,
        current: (component.specs as Record<string, unknown> | null)?._revision ?? null,
        history: rows.map((r) => {
          const m = (r.metadata ?? {}) as Record<string, unknown>;
          const { archivedSpecsSnapshot, ...rest } = m;
          return { id: r.id, at: r.createdAt, action: r.action, ...rest, ...(includeSnapshot ? { archivedSpecsSnapshot } : {}) };
        }),
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Paginated component listing with chunk counts and recent ingestion audit rows.
   */
  listComponents = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { limit, cursor, q } = req.query as unknown as ListComponentsQuery;

      const components = await prisma.component.findMany({
        where: q
          ? {
              OR: [
                { partNumber: { contains: q, mode: 'insensitive' } },
                { manufacturer: { contains: q, mode: 'insensitive' } },
                { category: { contains: q, mode: 'insensitive' } },
              ],
            }
          : undefined,
        orderBy: [{ lastRefreshed: 'desc' }, { id: 'asc' }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { _count: { select: { datasheetChunks: true } } },
      });

      const hasMore = components.length > limit;
      const page = hasMore ? components.slice(0, limit) : components;

      const recentAuditLogs = await prisma.auditLog.findMany({
        where: { action: { startsWith: 'INGEST_DATASHEET' } },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });

      res.status(200).json({
        manifest: manifestData,
        components: page.map((c) => ({
          id: c.id,
          partNumber: c.partNumber,
          manufacturer: c.manufacturer,
          category: c.category,
          datasheetUrl: c.datasheetUrl,
          source: c.source,
          lastRefreshed: c.lastRefreshed,
          specs: c.specs,
          totalChunks: c._count.datasheetChunks,
        })),
        nextCursor: hasMore ? page[page.length - 1]?.id ?? null : null,
        auditLogs: recentAuditLogs,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Lists all users with live moderation strikes, permanent DB suspensions,
   * and Redis temporary suspension TTLs for governance administration.
   */
  listUsers = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const users = await prisma.user.findMany({
        where: { deletedAt: null },
        select: {
          id: true,
          email: true,
          role: true,
          expertiseLevel: true,
          moderationStrikes: true,
          suspendedAt: true,
          createdAt: true,
          planOverride: true,
          limitOverrides: true,
          _count: { select: { designSessions: true } },
        },
        orderBy: [{ suspendedAt: 'desc' }, { moderationStrikes: 'desc' }, { createdAt: 'desc' }],
      });
      const ids = users.map((u) => u.id);

      // Usage is gathered in a handful of grouped queries (not per user) so the list stays cheap.
      const [plans, subs, messageCounts, inFlightCounts, spend] = await Promise.all([
        limitsService.plans(),
        prisma.subscription.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: 'active' }, _count: { _all: true } }),
        prisma.chatMessage.groupBy({ by: ['userId'], where: { userId: { in: ids }, role: 'user' }, _count: { _all: true } }),
        prisma.designSession.groupBy({ by: ['userId'], where: { userId: { in: ids }, status: { in: IN_FLIGHT_STATUSES } }, _count: { _all: true } }),
        ids.length === 0
          ? Promise.resolve([] as Array<{ user_id: string; spend: number }>)
          : prisma.$queryRaw<Array<{ user_id: string; spend: number }>>(Prisma.sql`
              SELECT s.user_id, coalesce(sum(a.cost_usd), 0)::float8 AS spend
              FROM ai_calls a JOIN design_sessions s ON s.id = a.session_id
              WHERE s.user_id = ANY(${ids}::uuid[]) GROUP BY s.user_id`),
      ]);
      const subsBy = new Map(subs.map((r) => [r.userId, r._count._all]));
      const msgBy = new Map(messageCounts.map((r) => [r.userId, r._count._all]));
      const flightBy = new Map(inFlightCounts.map((r) => [r.userId, r._count._all]));
      const spendBy = new Map(spend.map((r) => [r.user_id, r.spend]));

      const enrichedUsers = await Promise.all(
        users.map(async (u) => {
          const tempKey = userSuspensionKey(u.id);
          const tempTtl = await redis.ttl(tempKey).catch(() => -2);
          const isTempSuspended = tempTtl > 0;
          const effective = computeEffective(plans, {
            planOverride: u.planOverride,
            limitOverrides: u.limitOverrides,
            activeSubscriptions: subsBy.get(u.id) ?? 0,
          });
          return {
            id: u.id,
            email: u.email,
            role: u.role,
            expertiseLevel: u.expertiseLevel,
            moderationStrikes: u.moderationStrikes,
            suspendedAt: u.suspendedAt,
            createdAt: u.createdAt,
            totalSessions: u._count.designSessions,
            isTempSuspended,
            tempSuspensionTtlSeconds: isTempSuspended ? tempTtl : 0,
            isSuspended: Boolean(u.suspendedAt) || isTempSuspended,
            plan: effective.plan,
            planOverride: u.planOverride,
            limitOverrides: effective.overrides,
            effectiveLimits: effective.limits,
            usage: {
              userMessages: msgBy.get(u.id) ?? 0,
              inFlightSessions: flightBy.get(u.id) ?? 0,
              aiSpendUsd: Math.round((spendBy.get(u.id) ?? 0) * 10_000) / 10_000,
            },
          };
        })
      );

      res.status(200).json({ users: enrichedUsers });
    } catch (err) {
      next(err);
    }
  };

  /** The three plans with their current limits, the built-in defaults (for a "reset" button) and the allowed bounds. */
  listPlans = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const [plans, rows] = await Promise.all([limitsService.plans(), prisma.planLimit.findMany()]);
      res.status(200).json({
        plans: PLAN_NAMES.map((plan) => ({
          plan,
          limits: plans[plan],
          defaults: DEFAULT_LIMITS[plan],
          updatedAt: rows.find((r) => r.plan === plan)?.updatedAt ?? null,
        })),
        bounds: LIMIT_BOUNDS,
      });
    } catch (err) {
      next(err);
    }
  };

  /** Replaces one plan's limits. Takes effect immediately in this process and within seconds everywhere else. */
  updatePlan = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const plan = req.params.plan as PlanName;
      const before = (await limitsService.plans())[plan];
      const after = await limitsService.updatePlan(plan, req.body as UpdatePlanBody, req.user?.id);
      await prisma.auditLog.create({
        data: {
          actorUserId: req.user?.id ?? null,
          action: 'PLAN_LIMITS_UPDATED',
          entityType: 'PlanLimit',
          entityId: null,
          metadata: { plan, before, after } as unknown as Prisma.InputJsonValue,
        },
      });
      logger.info({ plan, before, after, adminId: req.user?.id }, 'Plan limits updated');
      res.status(200).json({ plan, limits: after, previous: before });
    } catch (err) {
      next(err);
    }
  };

  /** Per-user override of the plan and/or individual limits. null clears an override. */
  updateUserLimits = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params as { id: string };
      if (Object.keys(req.body ?? {}).length === 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Provide at least one field to change');
      }
      const { planOverride, messagesPerSession, maxInFlightSessions, sessionsPerHour } = req.body as UpdateUserLimitsBody;
      let result;
      try {
        result = await limitsService.updateUserOverrides(id, {
          planOverride,
          limits: { messagesPerSession, maxInFlightSessions, sessionsPerHour },
        });
      } catch (err) {
        if (err instanceof Error && err.message === 'USER_NOT_FOUND') throw new AppError(404, 'NOT_FOUND', 'User not found');
        throw err;
      }
      await prisma.auditLog.create({
        data: {
          actorUserId: req.user?.id ?? null,
          action: 'USER_LIMITS_UPDATED',
          entityType: 'User',
          entityId: id,
          metadata: { patch: req.body, result } as unknown as Prisma.InputJsonValue,
        },
      });
      res.status(200).json({ userId: id, ...result });
    } catch (err) {
      next(err);
    }
  };

  /** AI spend and session volume at a glance, for cost control. */
  usageSummary = async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const [calls] = await prisma.$queryRaw<Array<{ spend24h: number; spend7d: number; spend_total: number; calls24h: number }>>(Prisma.sql`
        SELECT
          coalesce(sum(cost_usd) FILTER (WHERE created_at > now() - interval '24 hours'), 0)::float8 AS spend24h,
          coalesce(sum(cost_usd) FILTER (WHERE created_at > now() - interval '7 days'), 0)::float8   AS spend7d,
          coalesce(sum(cost_usd), 0)::float8                                                         AS spend_total,
          (count(*) FILTER (WHERE created_at > now() - interval '24 hours'))::int                    AS calls24h
        FROM ai_calls`);
      const [sessions] = await prisma.$queryRaw<Array<{ guest24h: number; registered24h: number; in_flight: number }>>(Prisma.sql`
        SELECT
          (count(*) FILTER (WHERE user_id IS NULL AND created_at > now() - interval '24 hours'))::int     AS guest24h,
          (count(*) FILTER (WHERE user_id IS NOT NULL AND created_at > now() - interval '24 hours'))::int AS registered24h,
          (count(*) FILTER (WHERE status = ANY(${IN_FLIGHT_STATUSES}::text[])))::int                       AS in_flight
        FROM design_sessions WHERE status <> 'SYSTEM'`);
      const round = (n: number) => Math.round(n * 10_000) / 10_000;
      res.status(200).json({
        aiSpendUsd: { last24h: round(calls?.spend24h ?? 0), last7d: round(calls?.spend7d ?? 0), allTime: round(calls?.spend_total ?? 0) },
        aiCallsLast24h: calls?.calls24h ?? 0,
        sessions: { guestLast24h: sessions?.guest24h ?? 0, registeredLast24h: sessions?.registered24h ?? 0, inFlightNow: sessions?.in_flight ?? 0 },
        generationEnabled: env.GENERATION_ENABLED,
      });
    } catch (err) {
      next(err);
    }
  };

  /**
   * Unblocks/unsuspends a user by clearing temporary Redis suspension keys,
   * removing rolling strike counters, and clearing suspendedAt and moderationStrikes in DB.
   */
  unsuspendUser = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { id } = req.params;
      const user = await prisma.user.findUnique({ where: { id } });
      if (!user) {
        throw new AppError(404, 'NOT_FOUND', 'User not found');
      }

      // 1. Remove Redis suspension and strike keys
      const tempKey = userSuspensionKey(id);
      const strikeKey = `mod:strikes:user:${id}`;
      await redis.del(tempKey, strikeKey).catch(() => null);

      // 2. Reset database suspendedAt and moderationStrikes
      await prisma.user.update({
        where: { id },
        data: {
          suspendedAt: null,
          moderationStrikes: 0,
        },
      });

      // 3. Record audit log
      await prisma.auditLog.create({
        data: {
          actorUserId: req.user?.id || id,
          action: 'ADMIN_UNSUSPEND_USER',
          entityType: 'User',
          entityId: id,
          metadata: { targetUserId: id, targetEmail: user.email },
        },
      }).catch(() => {});

      logger.info({ adminId: req.user?.id, targetUserId: id, email: user.email }, 'User unsuspended and strikes reset by admin');

      res.status(200).json({
        success: true,
        message: `User ${user.email} has been unblocked and moderation strikes reset to 0.`,
      });
    } catch (err) {
      next(err);
    }
  };
}

export const adminController = new AdminController();
