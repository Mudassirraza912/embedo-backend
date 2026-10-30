import { describe, it, expect, jest, afterEach } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { moderationService } from '../../src/modules/governance/moderation.service.js';

describe('Support & Feedback — Support Requests (task_seven, first slice)', () => {
  const app = createApp();
  const CASE_ID = '22222222-2222-2222-2222-222222222222';
  const OTHER_CASE_ID = '33333333-3333-3333-3333-333333333333';

  function allowModeration() {
    jest.spyOn(moderationService, 'isSuspended').mockResolvedValue(false);
    jest.spyOn(moderationService, 'screenText').mockResolvedValue({ allowed: true });
    jest.spyOn(moderationService, 'assertAllowed').mockImplementation(() => undefined);
  }

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects a guest submission with no contact email', async () => {
    allowModeration();
    const res = await request(app).post('/api/v1/support/cases').send({
      subcategory: 'bug',
      subject: 'Diagram will not load',
      description: 'The module diagram tab stays blank after generation finishes.',
    });
    expect(res.status).toBe(400);
  });

  it('creates a durable guest case and its first timeline event, in one transaction', async () => {
    allowModeration();
    const createCase = jest.spyOn(prisma.supportCase, 'create').mockResolvedValue({
      id: CASE_ID,
      clientRequestId: null,
      subcategory: 'bug',
      subject: 'Diagram will not load',
      description: 'The module diagram tab stays blank after generation finishes.',
      status: 'new',
      priority: 'normal',
      userId: null,
      guestContactEmail: 'guest@example.com',
      anonSessionToken: 'anon-token-1',
      mode: 'prototype',
      sessionId: null,
      assignedAgentEmail: null,
      createdAt: new Date('2026-10-30T00:00:00Z'),
      updatedAt: new Date('2026-10-30T00:00:00Z'),
      firstResponseAt: null,
      resolvedAt: null,
    } as never);
    const createEvent = jest.spyOn(prisma.supportCaseEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(prisma, '$transaction').mockImplementation((async (fn: (tx: unknown) => unknown) => fn(prisma)) as never);

    const res = await request(app)
      .post('/api/v1/support/cases')
      .set('x-anon-session-token', 'anon-token-1')
      .send({
        subcategory: 'bug',
        subject: 'Diagram will not load',
        description: 'The module diagram tab stays blank after generation finishes.',
        guestContactEmail: 'guest@example.com',
        mode: 'prototype',
      });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ caseId: CASE_ID, status: 'new', subcategory: 'bug', isDuplicate: false });
    expect(createCase).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ caseId: CASE_ID, kind: 'customer_message', visibleToCustomer: true }) }),
    );
  });

  it('a retried submit with the same clientRequestId returns the original case, not a duplicate', async () => {
    allowModeration();
    const findUnique = jest.spyOn(prisma.supportCase, 'findUnique').mockResolvedValue({
      id: CASE_ID,
      status: 'open',
      subcategory: 'account',
      createdAt: new Date(),
    } as never);
    const createCase = jest.spyOn(prisma.supportCase, 'create');

    const res = await request(app).post('/api/v1/support/cases').send({
      subcategory: 'account',
      subject: 'Cannot access my account',
      description: 'I am locked out after resetting my password yesterday.',
      guestContactEmail: 'guest2@example.com',
      clientRequestId: 'retry-key-00000001',
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ caseId: CASE_ID, isDuplicate: true });
    expect(findUnique).toHaveBeenCalledWith({ where: { clientRequestId: 'retry-key-00000001' } });
    expect(createCase).not.toHaveBeenCalled();
  });

  it('404s when the referenced project is not found or not owned by the caller', async () => {
    allowModeration();
    jest.spyOn(prisma.designSession, 'findFirst').mockResolvedValue(null);
    const res = await request(app)
      .post('/api/v1/support/cases')
      .set('x-anon-session-token', 'anon-token-2')
      .send({
        subcategory: 'bug',
        subject: 'Wrong part sourced',
        description: 'The resolver picked a 5V-only sensor for a 3.3V bench.',
        guestContactEmail: 'guest3@example.com',
        sessionId: '44444444-4444-4444-4444-444444444444',
      });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('"my support requests" is scoped to the caller\'s own identity', async () => {
    const findMany = jest.spyOn(prisma.supportCase, 'findMany').mockResolvedValue([]);
    await request(app).get('/api/v1/support/cases').set('x-anon-session-token', 'anon-token-3');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { anonSessionToken: 'anon-token-3' } }));
  });

  it('returns an empty list, not an error, for a caller with no identity at all', async () => {
    const findMany = jest.spyOn(prisma.supportCase, 'findMany');
    const res = await request(app).get('/api/v1/support/cases');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ cases: [] });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('a case detail only ever includes customer-visible timeline entries', async () => {
    jest.spyOn(prisma.supportCase, 'findFirst').mockResolvedValue({ id: CASE_ID, anonSessionToken: 'anon-token-4' } as never);
    const findEvents = jest.spyOn(prisma.supportCaseEvent, 'findMany').mockResolvedValue([]);
    jest.spyOn(prisma.supportCaseAttachment, 'findMany').mockResolvedValue([]);
    const res = await request(app).get(`/api/v1/support/cases/${CASE_ID}`).set('x-anon-session-token', 'anon-token-4');
    expect(res.status).toBe(200);
    expect(res.body.data.attachments).toEqual([]);
    expect(findEvents).toHaveBeenCalledWith(expect.objectContaining({ where: { caseId: CASE_ID, visibleToCustomer: true } }));
  });

  it("404s for a case id that is not the caller's own", async () => {
    jest.spyOn(prisma.supportCase, 'findFirst').mockResolvedValue(null);
    const res = await request(app).get(`/api/v1/support/cases/${OTHER_CASE_ID}`).set('x-anon-session-token', 'someone-elses-token');
    expect(res.status).toBe(404);
  });

  describe('evidence attachments (task_seven remainder)', () => {
    const TINY_PNG_BASE64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    it('rejects an attachment on a case the caller does not own', async () => {
      jest.spyOn(prisma.supportCase, 'findFirst').mockResolvedValue(null);
      const res = await request(app)
        .post(`/api/v1/support/cases/${CASE_ID}/attachments`)
        .set('x-anon-session-token', 'someone-elses-token')
        .send({ filename: 'screenshot.png', contentType: 'image/png', dataBase64: TINY_PNG_BASE64 });
      expect(res.status).toBe(404);
    });

    it('rejects a disallowed content type before touching the database', async () => {
      const create = jest.spyOn(prisma.supportCaseAttachment, 'create');
      const res = await request(app)
        .post(`/api/v1/support/cases/${CASE_ID}/attachments`)
        .set('x-anon-session-token', 'anon-token-5')
        .send({ filename: 'script.js', contentType: 'application/javascript', dataBase64: TINY_PNG_BASE64 });
      expect(res.status).toBe(400);
      expect(create).not.toHaveBeenCalled();
    });

    it('stores an attachment for a case the caller owns, up to the per-case cap', async () => {
      jest.spyOn(prisma.supportCase, 'findFirst').mockResolvedValue({ id: CASE_ID } as never);
      jest.spyOn(prisma.supportCaseAttachment, 'count').mockResolvedValue(0);
      const create = jest.spyOn(prisma.supportCaseAttachment, 'create').mockResolvedValue({
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        filename: 'screenshot.png',
        contentType: 'image/png',
        sizeBytes: 67,
        createdAt: new Date('2026-10-31T00:00:00Z'),
      } as never);
      const res = await request(app)
        .post(`/api/v1/support/cases/${CASE_ID}/attachments`)
        .set('x-anon-session-token', 'anon-token-5')
        .send({ filename: 'screenshot.png', contentType: 'image/png', dataBase64: TINY_PNG_BASE64 });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ filename: 'screenshot.png', contentType: 'image/png' });
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ caseId: CASE_ID, contentType: 'image/png' }) }),
      );
    });

    it('409s once a case already has the maximum number of attachments', async () => {
      jest.spyOn(prisma.supportCase, 'findFirst').mockResolvedValue({ id: CASE_ID } as never);
      jest.spyOn(prisma.supportCaseAttachment, 'count').mockResolvedValue(3);
      const create = jest.spyOn(prisma.supportCaseAttachment, 'create');
      const res = await request(app)
        .post(`/api/v1/support/cases/${CASE_ID}/attachments`)
        .set('x-anon-session-token', 'anon-token-5')
        .send({ filename: 'screenshot2.png', contentType: 'image/png', dataBase64: TINY_PNG_BASE64 });
      expect(res.status).toBe(409);
      expect(create).not.toHaveBeenCalled();
    });

    it('downloads an attachment only for the owning identity, never another caller', async () => {
      jest.spyOn(prisma.supportCase, 'findFirst').mockResolvedValueOnce({ id: CASE_ID } as never).mockResolvedValueOnce(null);
      jest.spyOn(prisma.supportCaseAttachment, 'findFirst').mockResolvedValue({
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        filename: 'screenshot.png',
        contentType: 'image/png',
        data: Buffer.from('fake'),
      } as never);

      const ok = await request(app)
        .get(`/api/v1/support/cases/${CASE_ID}/attachments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`)
        .set('x-anon-session-token', 'anon-token-5');
      expect(ok.status).toBe(200);
      expect(ok.headers['content-type']).toContain('image/png');

      const denied = await request(app)
        .get(`/api/v1/support/cases/${CASE_ID}/attachments/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa`)
        .set('x-anon-session-token', 'someone-elses-token');
      expect(denied.status).toBe(404);
    });
  });
});
