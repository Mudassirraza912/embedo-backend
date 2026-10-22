import { Prisma } from '@prisma/client';
import { prisma } from '../../db/prisma.js';
import { AppError } from '../../common/errors/AppError.js';

/**
 * Trusted networks for the internal admin portal (admin.embedo.ai).
 *
 * The list is the single source for two enforcement points, both outside this API:
 *   - Nginx on the admin.embedo.ai vhost (a root job on the VPS rewrites its allow list every minute);
 *   - the admin API itself (embedo-Dashboard-Backend reads the table with a read-only role).
 * An empty list allows nobody. Every change is written to audit_log.
 */
export const MAX_ENTRIES = 100;
/** Broader ranges are refused: they would open the portal to whole providers. */
const MIN_PREFIX = { 4: 16, 6: 32 } as const;

export interface PortalAccessEntry {
  id: string;
  cidr: string;
  label: string;
  enabled: boolean;
  expiresAt: string | null;
  active: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = Prisma.AdminPortalAllowedIpGetPayload<object>;

const view = (r: Row): PortalAccessEntry => ({
  id: r.id,
  cidr: r.cidr,
  label: r.label,
  enabled: r.enabled,
  expiresAt: r.expiresAt?.toISOString() ?? null,
  active: r.enabled && (!r.expiresAt || r.expiresAt.getTime() > Date.now()),
  createdBy: r.createdBy,
  updatedBy: r.updatedBy,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/** Postgres does the parsing: "203.0.113.7" → "203.0.113.7/32", "203.0.113.9/24" → "203.0.113.0/24". */
export async function normaliseNetwork(input: string): Promise<string> {
  const value = input.trim();
  if (!value || value.length > 64) throw new AppError(400, 'VALIDATION_ERROR', 'Enter an IP address or range, e.g. 203.0.113.7 or 203.0.113.0/24.');
  let rows: { cidr: string; family: number; len: number }[];
  try {
    rows = await prisma.$queryRaw<{ cidr: string; family: number; len: number }[]>`
      SELECT network(${value}::inet)::text AS cidr, family(${value}::inet) AS family, masklen(${value}::inet) AS len`;
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', `"${value.slice(0, 64)}" is not an IP address or range.`);
  }
  const row = rows[0]!;
  // Nginx sees IPv4 clients as plain IPv4, so a "::ffff:a.b.c.d" entry would never match.
  if (/^::ffff:/i.test(row.cidr)) throw new AppError(400, 'VALIDATION_ERROR', 'Enter the IPv4 address itself, without "::ffff:".');
  const min = MIN_PREFIX[row.family as 4 | 6];
  if (row.len < min) {
    throw new AppError(400, 'VALIDATION_ERROR', `Range too broad: use /${min} or narrower for IPv${row.family}.`);
  }
  return row.cidr;
}

export const adminPortalAccessService = {
  async list(): Promise<PortalAccessEntry[]> {
    const rows = await prisma.adminPortalAllowedIp.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map(view);
  },

  async create(actorId: string | null, input: { cidr: string; label: string; expiresAt?: string | null }): Promise<PortalAccessEntry> {
    const cidr = await normaliseNetwork(input.cidr);
    if ((await prisma.adminPortalAllowedIp.count()) >= MAX_ENTRIES) {
      throw new AppError(409, 'CONFLICT', `The list is full (${MAX_ENTRIES} entries). Remove unused entries first.`);
    }
    try {
      const row = await prisma.$transaction(async (tx) => {
        const created = await tx.adminPortalAllowedIp.create({
          data: { cidr, label: input.label, expiresAt: input.expiresAt ? new Date(input.expiresAt) : null, createdBy: actorId, updatedBy: actorId },
        });
        await tx.auditLog.create({
          data: { actorUserId: actorId, action: 'ADMIN_PORTAL_IP_ADDED', entityType: 'AdminPortalAllowedIp', entityId: created.id, metadata: { cidr, label: input.label, expiresAt: input.expiresAt ?? null } },
        });
        return created;
      });
      return view(row);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError(409, 'CONFLICT', `${cidr} is already on the list.`);
      }
      throw err;
    }
  },

  async update(actorId: string | null, id: string, patch: { label?: string; enabled?: boolean; expiresAt?: string | null }): Promise<PortalAccessEntry> {
    return view(
      await prisma.$transaction(async (tx) => {
        const before = await tx.adminPortalAllowedIp.findUnique({ where: { id } });
        if (!before) throw new AppError(404, 'NOT_FOUND', 'Entry not found.');
        const after = await tx.adminPortalAllowedIp.update({
          where: { id },
          data: {
            ...(patch.label !== undefined ? { label: patch.label } : {}),
            ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
            ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt ? new Date(patch.expiresAt) : null } : {}),
            updatedBy: actorId,
          },
        });
        await tx.auditLog.create({
          data: {
            actorUserId: actorId,
            action: 'ADMIN_PORTAL_IP_UPDATED',
            entityType: 'AdminPortalAllowedIp',
            entityId: id,
            metadata: { cidr: before.cidr, before: { label: before.label, enabled: before.enabled, expiresAt: before.expiresAt }, after: { label: after.label, enabled: after.enabled, expiresAt: after.expiresAt } } as unknown as Prisma.InputJsonValue,
          },
        });
        return after;
      }),
    );
  },

  async remove(actorId: string | null, id: string): Promise<void> {
    await prisma.$transaction(async (tx) => {
      const before = await tx.adminPortalAllowedIp.findUnique({ where: { id } });
      if (!before) throw new AppError(404, 'NOT_FOUND', 'Entry not found.');
      await tx.adminPortalAllowedIp.delete({ where: { id } });
      await tx.auditLog.create({
        data: { actorUserId: actorId, action: 'ADMIN_PORTAL_IP_REMOVED', entityType: 'AdminPortalAllowedIp', entityId: id, metadata: { cidr: before.cidr, label: before.label } },
      });
    });
  },
};
