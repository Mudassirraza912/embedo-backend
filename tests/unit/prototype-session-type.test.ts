import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { aiPipelineQueue } from '../../src/jobs/ai-pipeline.queue.js';
import { sessionsService } from '../../src/modules/sessions/sessions.service.js';
import { createSessionSchema, discussSchema } from '../../src/modules/sessions/sessions.validation.js';
import { applicationContextFor, sessionTypeOf } from '../../src/modules/sessions/session-type.js';

const routerReply = (mode: 'generate' | 'discuss') => ({
  content: JSON.stringify({ mode, projectTitle: 'Pico Weather Station', isGibberish: false, isNewProject: false, reply: '', isAnswerToPendingQuestion: false }),
  inputTokens: 10,
  outputTokens: 10,
  cachedTokens: 0,
  latencyMs: 5,
  costUsd: 0,
  schemaPass: true,
  provider: 'openai',
  model: 'gpt-4o-mini',
  aiCallId: 'r1',
});

describe('session type on the chat endpoints', () => {
  afterEach(() => jest.restoreAllMocks());

  it('maps type to the stored application_context and back', () => {
    expect(applicationContextFor('prototype', undefined)).toBe('rapid_prototyping');
    expect(applicationContextFor('architect', undefined)).toBe('hardware_synthesis');
    expect(applicationContextFor('architect', 'rapid_prototyping')).toBe('hardware_synthesis');
    expect(applicationContextFor(undefined, 'industrial_iot')).toBe('industrial_iot');
    expect(sessionTypeOf('rapid_prototyping')).toBe('prototype');
    expect(sessionTypeOf(null)).toBe('architect');
  });

  it('validates type on create and discuss, and keeps applicationContext within the column size', () => {
    expect(createSessionSchema.parse({ intentText: 'Pico weather station', type: 'prototype' }).type).toBe('prototype');
    expect(createSessionSchema.safeParse({ intentText: 'Pico weather station', type: 'breadboard' }).success).toBe(false);
    expect(createSessionSchema.safeParse({ intentText: 'Pico weather station', applicationContext: 'x'.repeat(101) }).success).toBe(false);
    expect(discussSchema.parse({ messages: [{ role: 'user', content: 'add a GPS' }], type: 'prototype' }).type).toBe('prototype');
  });

  it('creates a prototype session, tells the router the mode, and queues the pipeline', async () => {
    const created = { id: 's-1', title: null, status: 'PENDING', applicationContext: 'rapid_prototyping', intentText: 'Pico weather station' };
    const create = jest.spyOn(prisma.designSession, 'create').mockResolvedValue(created as never);
    jest.spyOn(prisma.designSession, 'update').mockResolvedValue({ ...created, title: 'Pico Weather Station' } as never);
    jest.spyOn(prisma.chatMessage, 'create').mockResolvedValue({} as never);
    const route = jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(routerReply('generate'));
    const add = jest.spyOn(aiPipelineQueue, 'add').mockResolvedValue({} as never);

    const result = await sessionsService.createSession({ intentText: 'Pico weather station with a BME280', type: 'prototype' }, undefined, undefined);

    expect(create.mock.calls[0]![0].data).toMatchObject({ applicationContext: 'rapid_prototyping' });
    expect(route.mock.calls[0]![0].systemPrompt).toContain('PROJECT TYPE: Prototype');
    expect(add.mock.calls[0]![1]).toMatchObject({ sessionId: 's-1', type: 'prototype' });
    expect(result.session.applicationContext).toBe('rapid_prototyping');
  });

  it('refuses to switch the type of a project that already has a design', async () => {
    jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValue({
      id: 's-2',
      userId: null,
      anonSessionToken: 'a'.repeat(64),
      status: 'DONE',
      applicationContext: 'hardware_synthesis',
      architecture: { projectMeta: {} },
      deletedAt: null,
      chatMessages: [],
      userFeedback: [],
      designOutcome: null,
    } as never);

    await expect(
      sessionsService.discuss('s-2', { messages: [{ role: 'user', content: 'wire a BME280' }], type: 'prototype' }, undefined, 'a'.repeat(64))
    ).rejects.toMatchObject({ statusCode: 409, code: 'SESSION_TYPE_MISMATCH' });
  });
});
