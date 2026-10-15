import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { sessionsService } from '../../src/modules/sessions/sessions.service.js';
import { discussSchema } from '../../src/modules/sessions/sessions.validation.js';
import { fillVersionCard, persistNewVersion, proposeVersion, VERSION_TAG_PLACEHOLDER } from '../../src/modules/sessions/version.service.js';

/**
 * Manual apply mode: a revision is saved as a proposal and becomes a version only on approval,
 * and only while the design is still the one it was built on.
 */

const SESSION = '11111111-1111-4111-8111-111111111111';
const PROPOSAL = '22222222-2222-4222-8222-222222222222';

type AnyFn = (...args: unknown[]) => unknown;
const fn = <T>(value?: T) => jest.fn<AnyFn>().mockResolvedValue(value as unknown);

/** A fake transaction client recording what was written. */
function fakeTx(currentTag: string | null, pendingIds: string[] = []) {
  return {
    $executeRaw: fn(1),
    designSession: { findUnique: fn({ architecture: currentTag ? { versionTag: currentTag } : null }), update: fn({}) },
    sessionVersion: { count: fn(2), create: fn({ id: 'ver-3' }) },
    chatMessage: { create: fn({ id: 'msg-1' }), findUnique: fn({ metadata: { pendingChange: { status: 'pending' }, sessionType: 'prototype' } }), update: fn({}) },
    designProposal: { create: fn({ id: PROPOSAL }), update: fn({ messageId: 'msg-1' }), findMany: fn(pendingIds.map((id) => ({ id }))) },
  };
}
const useTx = (tx: ReturnType<typeof fakeTx>) =>
  jest.spyOn(prisma, '$transaction').mockImplementation((async (arg: unknown) => (typeof arg === 'function' ? (arg as (t: unknown) => unknown)(tx) : arg)) as never);

const card = { content: `🧩 **Prototype bench assembled (${VERSION_TAG_PLACEHOLDER})**`, metadata: { versionTag: VERSION_TAG_PLACEHOLDER, sessionType: 'prototype' } };
const storedProposal = (status = 'pending') => ({
  id: PROPOSAL,
  sessionId: SESSION,
  status,
  baseVersionTag: 'v1.1',
  versionTag: null,
  changeSummary: 'Added Adafruit LIS3DH',
  appliedChanges: ['add an accelerometer', 'Added Adafruit LIS3DH'],
  designGraph: { kind: 'prototype_composition' },
  architecture: { kind: 'architect', versionTag: 'v1.1' },
  card,
  messageId: 'msg-1',
  createdAt: new Date(),
  decidedAt: null,
});

describe('design proposals (manual apply mode)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('accepts applyMode on the chat endpoint, and only auto or manual', () => {
    expect(discussSchema.parse({ messages: [{ role: 'user', content: 'add a GPS' }], applyMode: 'manual' }).applyMode).toBe('manual');
    expect(discussSchema.safeParse({ messages: [{ role: 'user', content: 'add a GPS' }], applyMode: 'sometimes' }).success).toBe(false);
    // Long specs (a 20-module bill, ~2400 characters) are accepted up to 6000 characters.
    expect(discussSchema.safeParse({ messages: [{ role: 'user', content: 'x'.repeat(2400) }] }).success).toBe(true);
    expect(discussSchema.safeParse({ messages: [{ role: 'user', content: 'x'.repeat(6001) }] }).success).toBe(false);
  });

  it('proposes without touching the design: proposal row + "Proposed change" card', async () => {
    const tx = fakeTx('v1.1');
    useTx(tx);
    const { proposalId } = await proposeVersion({
      sessionId: SESSION,
      designGraph: { g: 1 },
      architecture: { a: 1 },
      changeSummary: 'x',
      appliedChanges: ['x'],
      sessionStatus: 'DONE',
      buildChatMessage: (tag) => ({ content: `card ${tag}`, metadata: { versionTag: tag } }),
      baseVersionTag: 'v1.1',
      proposalCard: { content: 'Proposed change', metadata: { sessionType: 'prototype' }, pendingChange: { changes: ['Added X'] } },
    });
    expect(proposalId).toBe(PROPOSAL);
    expect(tx.sessionVersion.create).not.toHaveBeenCalled();
    const created = (tx.designProposal.create.mock.calls[0]![0] as { data: Record<string, unknown> }).data;
    expect(created.card).toEqual({ content: `card ${VERSION_TAG_PLACEHOLDER}`, metadata: { versionTag: VERSION_TAG_PLACEHOLDER } });
    const message = (tx.chatMessage.create.mock.calls[0]![0] as { data: { metadata: Record<string, unknown> } }).data;
    expect(message.metadata.pendingChange).toEqual({ changes: ['Added X'], proposalId: PROPOSAL, status: 'pending', baseVersionTag: 'v1.1' });
    // Only the status moves; the stored design is never written by a proposal.
    for (const call of tx.designSession.update.mock.calls) expect((call[0] as { data: Record<string, unknown> }).data).toEqual({ status: 'DONE' });
  });

  it('approving saves the next version with the stored card, and outdates other pending proposals', async () => {
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({ id: SESSION } as never);
    jest.spyOn(prisma.designProposal, 'findFirst').mockResolvedValue(storedProposal() as never);
    const tx = fakeTx('v1.1', ['33333333-3333-4333-8333-333333333333']);
    useTx(tx);
    const result = await sessionsService.approveProposal(SESSION, PROPOSAL);
    expect(result.activeVersionTag).toBe('v1.2');
    const posted = (tx.chatMessage.create.mock.calls[0]![0] as { data: { content: string; metadata: Record<string, unknown> } }).data;
    expect(posted.content).toContain('(v1.2)');
    expect(posted.metadata.versionTag).toBe('v1.2');
    const statuses = tx.designProposal.update.mock.calls.map((c) => (c[0] as { where: { id: string }; data: { status: string } }));
    expect(statuses.map((s) => [s.where.id, s.data.status])).toEqual([
      [PROPOSAL, 'approved'],
      ['33333333-3333-4333-8333-333333333333', 'outdated'],
    ]);
  });

  it('refuses a proposal built on an older version and marks it outdated', async () => {
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({ id: SESSION } as never);
    jest.spyOn(prisma.designProposal, 'findFirst').mockResolvedValue(storedProposal() as never);
    const tx = fakeTx('v1.2');
    useTx(tx);
    await expect(sessionsService.approveProposal(SESSION, PROPOSAL)).rejects.toMatchObject({ statusCode: 409, details: { reason: 'outdated', currentVersionTag: 'v1.2' } });
    expect(tx.sessionVersion.create).not.toHaveBeenCalled();
    expect((tx.designProposal.update.mock.calls[0]![0] as { data: { status: string } }).data.status).toBe('outdated');
  });

  it('rejecting leaves the design as it is; a decided proposal cannot be decided again', async () => {
    jest.spyOn(sessionsService, 'getSession').mockResolvedValue({ id: SESSION } as never);
    const find = jest.spyOn(prisma.designProposal, 'findFirst').mockResolvedValue(storedProposal() as never);
    const tx = fakeTx('v1.1');
    useTx(tx);
    expect(await sessionsService.rejectProposal(SESSION, PROPOSAL)).toEqual({ proposalId: PROPOSAL, status: 'rejected' });
    expect(tx.sessionVersion.create).not.toHaveBeenCalled();
    find.mockResolvedValue(storedProposal('rejected') as never);
    await expect(sessionsService.approveProposal(SESSION, PROPOSAL)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('any new version (an automatic change, a rollback) makes pending proposals outdated', async () => {
    const tx = fakeTx('v1.1', [PROPOSAL]);
    useTx(tx);
    await persistNewVersion({ sessionId: SESSION, designGraph: {}, architecture: {}, changeSummary: 'x', appliedChanges: [] });
    expect((tx.designProposal.update.mock.calls[0]![0] as { data: { status: string } }).data.status).toBe('outdated');
    const card = (tx.chatMessage.update.mock.calls[0]![0] as { data: { metadata: { pendingChange: { status: string } } } }).data;
    expect(card.metadata.pendingChange.status).toBe('outdated');
  });

  it('fills the version tag into every place of the stored card', () => {
    expect(fillVersionCard(card, 'v1.4')).toEqual({ content: '🧩 **Prototype bench assembled (v1.4)**', metadata: { versionTag: 'v1.4', sessionType: 'prototype' } });
  });
});
