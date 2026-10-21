import crypto from 'crypto';
import { prisma } from '../../db/prisma.js';
import { redis } from '../../db/redis.js';
import { logger } from '../../config/logger.js';

export interface StatusIncidentUpdate {
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  timestamp: string;
  message: string;
}

export interface StatusIncident {
  incident_id: string;
  title: string;
  severity: 'informational' | 'degraded_performance' | 'partial_outage' | 'major_outage' | 'maintenance';
  status: 'investigating' | 'identified' | 'monitoring' | 'resolved';
  affected_services: string[];
  started_at: string;
  resolved_at: string | null;
  description: string;
  resolution_message: string | null;
  updates: StatusIncidentUpdate[];
}

export interface ServiceDefinition {
  service_id: string;
  name: string;
  description: string;
  icon: string;
}

export const BASE_SERVICES: ServiceDefinition[] = [
  {
    service_id: 'embedo-app',
    name: 'Embedo App',
    description: 'The main Embedo product application.',
    icon: 'app',
  },
  {
    service_id: 'architect',
    name: 'Architect',
    description: 'Architect Mode and architecture-generation workflows.',
    icon: 'architect',
  },
  {
    service_id: 'prototype',
    name: 'Prototype',
    description: 'Prototype Mode.',
    icon: 'prototype',
  },
  {
    service_id: 'ai-generation',
    name: 'AI Generation',
    description: 'Intent processing, reasoning, and generation workflows behind Embedo outputs.',
    icon: 'ai',
  },
  {
    service_id: 'projects-storage',
    name: 'Projects & Storage',
    description: 'Project save, project retrieval, and project-state services.',
    icon: 'projects',
  },
  {
    service_id: 'authentication',
    name: 'Authentication',
    description: 'Login, email OTP, authentication, and account access.',
    icon: 'auth',
  },
];

const SEVERITY_WEIGHT: Record<string, number> = {
  major_outage: 1.0,
  partial_outage: 0.5,
  degraded_performance: 0.25,
  degraded: 0.25,
  maintenance: 0.1,
  informational: 0.0,
};

const SEVERITY_TO_DAY_STATUS: Record<string, string> = {
  major_outage: 'major_outage',
  partial_outage: 'partial_outage',
  degraded_performance: 'degraded',
  maintenance: 'maintenance',
  informational: 'operational',
};

const REDIS_INCIDENTS_KEY = 'embedo:status:incidents';
const REDIS_EMAIL_SUBS_KEY = 'embedo:status:subscriptions:email';
const REDIS_WEBHOOK_SUBS_KEY = 'embedo:status:subscriptions:webhook';

// Seed historical resolved incident record if not present in redis
const HISTORICAL_INCIDENTS: StatusIncident[] = [
  {
    incident_id: 'INC-20261015-01',
    title: 'Architect & AI Generation Service Disruption (Upstream API Credits)',
    severity: 'partial_outage',
    status: 'resolved',
    affected_services: ['architect', 'ai-generation'],
    started_at: '2026-10-15T08:15:00Z',
    resolved_at: '2026-10-15T16:00:00Z',
    description:
      'We experienced elevated error rates in Architect mode and AI generation pipelines due to upstream AI provider API credit exhaustion. Secondary provider routing was engaged while balances were refreshed.',
    resolution_message:
      'Upstream provider credits refreshed and failover routes verified. All Architect generation and AI reasoning pipelines are operating normally.',
    updates: [
      {
        status: 'investigating',
        timestamp: '2026-10-15T08:15:00Z',
        message: 'Investigating generation latency and 429 quota exhaustion responses in the AI pipeline queue.',
      },
      {
        status: 'identified',
        timestamp: '2026-10-15T09:00:00Z',
        message: 'Root cause confirmed as upstream provider prepaid credit exhaustion. Team initiated provider top-ups and engaged secondary model routes.',
      },
      {
        status: 'monitoring',
        timestamp: '2026-10-15T14:30:00Z',
        message: 'Failover routes active and handling requests stably. Monitoring system performance.',
      },
      {
        status: 'resolved',
        timestamp: '2026-10-15T16:00:00Z',
        message: 'This incident has been resolved. All Architect and AI generation pipelines have returned to normal operational performance.',
      },
    ],
  },
  {
    incident_id: 'INC-20260925-01',
    title: 'Architect generation delays',
    severity: 'degraded_performance',
    status: 'resolved',
    affected_services: ['architect'],
    started_at: '2026-09-25T10:14:00Z',
    resolved_at: '2026-09-25T11:42:00Z',
    description: 'Increased processing latency in the Architect service.',
    resolution_message: 'Architect processing times returned to normal. No project data was affected.',
    updates: [
      { status: 'investigating', timestamp: '2026-09-25T10:14:00Z', message: 'Investigating reports of slower Architect generation times.' },
      { status: 'identified', timestamp: '2026-09-25T10:27:00Z', message: 'Latencies identified and optimizations applied.' },
      { status: 'monitoring', timestamp: '2026-09-25T11:03:00Z', message: 'Monitoring performance.' },
      { status: 'resolved', timestamp: '2026-09-25T11:42:00Z', message: 'Incident resolved. Operating normally.' },
    ],
  },
];

export async function getIncidents(): Promise<StatusIncident[]> {
  try {
    const raw = await redis.get(REDIS_INCIDENTS_KEY);
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (err) {
    logger.warn({ err }, 'Could not read incidents from redis, using in-memory store');
  }
  return HISTORICAL_INCIDENTS;
}

export async function saveIncidents(incidents: StatusIncident[]): Promise<void> {
  try {
    await redis.set(REDIS_INCIDENTS_KEY, JSON.stringify(incidents));
  } catch (err) {
    logger.warn({ err }, 'Could not save incidents to redis');
  }
}

export function calculate90DayUptimePercentage(
  serviceId: string,
  incidents: StatusIncident[],
  now: Date = new Date()
): number {
  const windowDays = 90;
  const totalMinutes = windowDays * 24 * 60; // 129,600 minutes
  const windowStart = now.getTime() - windowDays * 86400000;
  const windowEnd = now.getTime();

  let downtimeMinutes = 0;

  for (const inc of incidents) {
    if (!inc.affected_services.includes(serviceId)) continue;

    const incStart = new Date(inc.started_at).getTime();
    const incEnd = inc.resolved_at ? new Date(inc.resolved_at).getTime() : windowEnd;

    // Check intersection with the 90-day window
    const overlapStart = Math.max(incStart, windowStart);
    const overlapEnd = Math.min(incEnd, windowEnd);

    if (overlapEnd > overlapStart) {
      const minutes = (overlapEnd - overlapStart) / 60000;
      const weight = SEVERITY_WEIGHT[inc.severity] ?? 0.5;
      downtimeMinutes += minutes * weight;
    }
  }

  const uptime = Math.max(0, Math.min(100, ((totalMinutes - downtimeMinutes) / totalMinutes) * 100));
  return Number(uptime.toFixed(2));
}

export function build90DayHistoryBars(
  serviceId: string,
  incidents: StatusIncident[],
  now: Date = new Date()
): Array<{ date: string; status: string; incident_title: string | null }> {
  const bars: Array<{ date: string; status: string; incident_title: string | null }> = [];
  const DAY_MS = 86400000;

  for (let idx = 0; idx < 90; idx++) {
    const daysAgo = 89 - idx;
    const dayStart = new Date(now.getTime() - daysAgo * DAY_MS);
    const dayKey = dayStart.toISOString().slice(0, 10);
    const dayStartMs = new Date(`${dayKey}T00:00:00Z`).getTime();
    const dayEndMs = dayStartMs + DAY_MS - 1;

    // Check if any incident affecting this service touches this calendar day
    const matchingInc = incidents.find((inc) => {
      if (!inc.affected_services.includes(serviceId)) return false;
      const incStart = new Date(inc.started_at).getTime();
      const incEnd = inc.resolved_at ? new Date(inc.resolved_at).getTime() : now.getTime();
      return incStart <= dayEndMs && incEnd >= dayStartMs;
    });

    if (matchingInc) {
      const dayStatus = SEVERITY_TO_DAY_STATUS[matchingInc.severity] || 'degraded';
      bars.push({
        date: dayKey,
        status: dayStatus,
        incident_title: matchingInc.title,
      });
    } else {
      bars.push({
        date: dayKey,
        status: 'operational',
        incident_title: null,
      });
    }
  }

  return bars;
}

export async function computeLiveServiceTelemetry() {
  const now = new Date();
  const incidents = await getIncidents();

  // 1. Live infrastructure probing
  let dbStatus: 'up' | 'down' = 'up';
  let redisStatus: 'up' | 'down' = 'up';
  let activeModelsCount = 0;
  let aiHealthStatus: 'up' | 'degraded' | 'credit_exhausted' = 'up';
  let sessionsCheck: 'up' | 'down' = 'up';
  let usersCheck: 'up' | 'down' = 'up';

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (err) {
    logger.error({ err }, 'Database status check failed');
    dbStatus = 'down';
  }

  try {
    const pong = await redis.ping();
    if (pong !== 'PONG') redisStatus = 'down';
  } catch (err) {
    logger.error({ err }, 'Redis status check failed');
    redisStatus = 'down';
  }

  try {
    activeModelsCount = await prisma.modelRoute.count({ where: { isActive: true } });
  } catch {
    activeModelsCount = 0;
  }

  // Detect upstream AI provider credit exhaustion and elevated error rates (ESD-2 / ESD-4)
  try {
    const fifteenMinutesAgo = new Date(Date.now() - 15 * 60 * 1000);
    const recentAiCalls = await prisma.aiCall.findMany({
      where: { createdAt: { gte: fifteenMinutesAgo } },
      select: { errorMessage: true, schemaPass: true },
      take: 20,
      orderBy: { createdAt: 'desc' },
    });

    if (recentAiCalls.length > 0) {
      const quotaErrors = recentAiCalls.filter(
        (c) => c.errorMessage && /insufficient_quota|credit_balance_exhausted|quota|billing|exceeded your current quota/i.test(c.errorMessage)
      );
      const failedCalls = recentAiCalls.filter((c) => c.schemaPass === false || Boolean(c.errorMessage));

      if (quotaErrors.length >= 2 || (quotaErrors.length > 0 && quotaErrors.length === recentAiCalls.length)) {
        aiHealthStatus = 'credit_exhausted';
      } else if (failedCalls.length / recentAiCalls.length >= 0.5) {
        aiHealthStatus = 'degraded';
      }
    }
  } catch {
    // Non-blocking telemetry inspection
  }

  try {
    await prisma.designSession.findFirst({ select: { id: true } });
  } catch {
    sessionsCheck = 'down';
  }

  try {
    await prisma.user.findFirst({ select: { id: true } });
  } catch {
    usersCheck = 'down';
  }

  // 2. Active incidents (ESD-4 / ESD-5)
  const activeIncidents = incidents.filter((i) => i.status !== 'resolved');

  // 3. Compute each service's dynamic status
  const services = BASE_SERVICES.map((def) => {
    let status: 'operational' | 'degraded' | 'partial_outage' | 'major_outage' = 'operational';

    // Check underlying subsystem health
    if (def.service_id === 'embedo-app') {
      if (dbStatus === 'down' || redisStatus === 'down') status = 'degraded';
    } else if (def.service_id === 'architect') {
      if (dbStatus === 'down' || activeModelsCount === 0 || aiHealthStatus === 'credit_exhausted') {
        status = aiHealthStatus === 'credit_exhausted' ? 'partial_outage' : 'degraded';
      } else if (aiHealthStatus === 'degraded') {
        status = 'degraded';
      }
    } else if (def.service_id === 'prototype') {
      if (dbStatus === 'down') status = 'degraded';
    } else if (def.service_id === 'ai-generation') {
      if (activeModelsCount === 0 || aiHealthStatus === 'credit_exhausted') {
        status = aiHealthStatus === 'credit_exhausted' ? 'partial_outage' : 'degraded';
      } else if (aiHealthStatus === 'degraded') {
        status = 'degraded';
      }
    } else if (def.service_id === 'projects-storage') {
      if (sessionsCheck === 'down' || dbStatus === 'down') status = 'degraded';
    } else if (def.service_id === 'authentication') {
      if (usersCheck === 'down' || dbStatus === 'down') status = 'degraded';
    }

    // Overlay active incidents
    const activeForService = activeIncidents.filter((inc) => inc.affected_services.includes(def.service_id));
    for (const inc of activeForService) {
      if (inc.severity === 'major_outage') {
        status = 'major_outage';
      } else if (inc.severity === 'partial_outage' && status !== 'major_outage') {
        status = 'partial_outage';
      } else if (
        inc.severity === 'degraded_performance' &&
        status !== 'major_outage' &&
        status !== 'partial_outage'
      ) {
        status = 'degraded';
      }
    }

    // Mathematically computed 90-day uptime percentage (ESD-3)
    const uptimePercentage = calculate90DayUptimePercentage(def.service_id, incidents, now);

    // Dynamic 90-day history bars
    const historyBars = build90DayHistoryBars(def.service_id, incidents, now);

    return {
      service_id: def.service_id,
      name: def.name,
      description: def.description,
      icon: def.icon,
      status,
      uptime_percentage: uptimePercentage,
      uptime_90_days: historyBars,
      last_checked: now.toISOString(),
    };
  });

  // 4. Compute overall global status (ESD-2)
  const rank: Record<string, number> = {
    operational: 0,
    maintenance: 1,
    degraded: 2,
    partial_outage: 3,
    major_outage: 4,
  };
  const globalStatus = services.reduce(
    (worst, s) => (rank[s.status] > rank[worst] ? s.status : worst),
    'operational'
  );

  return {
    status: globalStatus,
    updated_at: now.toISOString(),
    services,
    incidents,
    active_incidents: activeIncidents,
  };
}

export async function addSubscriber(
  type: 'email' | 'webhook',
  target: string,
  topics?: string[]
): Promise<{ id: string; unsubscribeToken: string }> {
  const normalizedTarget = target.trim().toLowerCase();
  const unsubscribeToken = crypto.randomBytes(24).toString('hex');
  const verifyToken = crypto.randomBytes(24).toString('hex');

  // 1. Durable PostgreSQL storage via Prisma (ESD-8)
  let subscriberId = '';
  let token = unsubscribeToken;
  try {
    const subscriber = await prisma.statusSubscriber.upsert({
      where: {
        channel_target: {
          channel: type,
          target: normalizedTarget,
        },
      },
      create: {
        channel: type,
        target: normalizedTarget,
        isVerified: type === 'webhook', // Webhooks are active immediately
        active: true,
        verifyToken,
        unsubscribeToken,
        topics: topics || undefined,
      },
      update: {
        active: true,
        unsubscribedAt: null,
        topics: topics || undefined,
      },
    });
    subscriberId = subscriber.id;
    if (subscriber.unsubscribeToken) {
      token = subscriber.unsubscribeToken;
    }
  } catch (err) {
    logger.error({ err }, `Could not persist ${type} subscriber in database`);
  }

  // 2. Fast transient Redis cache/queue for live dispatch
  const key = type === 'email' ? REDIS_EMAIL_SUBS_KEY : REDIS_WEBHOOK_SUBS_KEY;
  try {
    await redis.sadd(key, normalizedTarget);
  } catch (err) {
    logger.warn({ err }, `Could not sync ${type} subscriber to redis`);
  }

  return { id: subscriberId, unsubscribeToken: token };
}

export async function removeSubscriber(type: 'email' | 'webhook', target: string): Promise<void> {
  const normalizedTarget = target.trim().toLowerCase();

  // 1. Soft-deactivate in durable PostgreSQL table (ESD-8)
  try {
    await prisma.statusSubscriber.updateMany({
      where: { channel: type, target: normalizedTarget },
      data: {
        active: false,
        unsubscribedAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn({ err }, `Could not deactivate ${type} subscriber in database`);
  }

  // 2. Remove from transient Redis delivery set
  const key = type === 'email' ? REDIS_EMAIL_SUBS_KEY : REDIS_WEBHOOK_SUBS_KEY;
  try {
    await redis.srem(key, normalizedTarget);
  } catch (err) {
    logger.warn({ err }, `Could not remove ${type} subscriber from redis`);
  }
}

export async function unsubscribeByToken(token: string): Promise<boolean> {
  if (!token) return false;
  try {
    const subscriber = await prisma.statusSubscriber.findFirst({
      where: { unsubscribeToken: token },
    });
    if (!subscriber) return false;

    await prisma.statusSubscriber.update({
      where: { id: subscriber.id },
      data: {
        active: false,
        unsubscribedAt: new Date(),
      },
    });

    const key = subscriber.channel === 'email' ? REDIS_EMAIL_SUBS_KEY : REDIS_WEBHOOK_SUBS_KEY;
    await redis.srem(key, subscriber.target);
    return true;
  } catch (err) {
    logger.warn({ err }, 'Could not unsubscribe via token');
    return false;
  }
}
