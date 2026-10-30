import { prisma } from '../../db/prisma.js';
import { AppError } from '../../common/errors/AppError.js';
import { CreateSupportCaseInput } from './support.validation.js';

/**
 * Support & Feedback case storage (task_seven, first slice: Support Requests only -- see the
 * module doc comment on the SupportCase Prisma model for why Product Feedback and Reported
 * Engineering Outputs are deliberately not duplicated here).
 */
export const supportService = {
  /**
   * Creates a durable, queryable support case. A signed-in caller is identified by their account;
   * a guest must give a contact email (never treated as verified -- there is no verification flow
   * for it yet, which is why this never claims the case "will be followed up by email" beyond what
   * was actually collected). A client-supplied `clientRequestId` makes a retried submit safe: the
   * unique constraint on it means a retry after a dropped response returns the original case
   * instead of creating a duplicate.
   */
  async createCase(input: CreateSupportCaseInput, userId: string | undefined, anonSessionToken: string | undefined) {
    if (!userId && !input.guestContactEmail) {
      throw new AppError(400, 'VALIDATION_ERROR', 'A contact email is required to submit a support request as a guest.');
    }

    if (input.sessionId) {
      const session = await prisma.designSession.findFirst({
        where: { id: input.sessionId, deletedAt: null, ...(userId ? { userId } : { anonSessionToken }) },
        select: { id: true },
      });
      if (!session) throw new AppError(404, 'NOT_FOUND', 'The referenced project could not be found or is not yours.');
    }

    if (input.clientRequestId) {
      const existing = await prisma.supportCase.findUnique({ where: { clientRequestId: input.clientRequestId } });
      if (existing) return { case: existing, isDuplicate: true as const };
    }

    const created = await prisma.$transaction(async (tx) => {
      const supportCase = await tx.supportCase.create({
        data: {
          clientRequestId: input.clientRequestId,
          subcategory: input.subcategory,
          subject: input.subject,
          description: input.description,
          userId: userId ?? null,
          guestContactEmail: userId ? null : (input.guestContactEmail ?? null),
          anonSessionToken: userId ? null : (anonSessionToken ?? null),
          mode: input.mode ?? null,
          sessionId: input.sessionId ?? null,
        },
      });
      await tx.supportCaseEvent.create({
        data: {
          caseId: supportCase.id,
          kind: 'customer_message',
          visibleToCustomer: true,
          authorLabel: null,
          body: input.description,
        },
      });
      return supportCase;
    });

    return { case: created, isDuplicate: false as const };
  },

  /**
   * "My support requests": only what a signed-in user or the same guest token actually submitted.
   * No cross-identity listing is possible through this path.
   */
  async listMine(userId: string | undefined, anonSessionToken: string | undefined) {
    if (!userId && !anonSessionToken) return [];
    const cases = await prisma.supportCase.findMany({
      where: userId ? { userId } : { anonSessionToken },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { id: true, subcategory: true, subject: true, status: true, priority: true, createdAt: true, updatedAt: true, resolvedAt: true },
    });
    return cases;
  },

  /** Full detail incl. only the customer-visible timeline entries -- internal notes never leave this. */
  async getMine(id: string, userId: string | undefined, anonSessionToken: string | undefined) {
    const supportCase = await prisma.supportCase.findFirst({
      where: { id, ...(userId ? { userId } : { anonSessionToken }) },
    });
    if (!supportCase) throw new AppError(404, 'NOT_FOUND', 'Support request not found.');
    const events = await prisma.supportCaseEvent.findMany({
      where: { caseId: id, visibleToCustomer: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, kind: true, body: true, createdAt: true },
    });
    return { case: supportCase, events };
  },
};
