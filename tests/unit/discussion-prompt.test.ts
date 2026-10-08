import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { SessionsService } from '../../src/modules/sessions/sessions.service.js';

describe('discussion copilot prompt', () => {
  afterEach(() => jest.restoreAllMocks());

  it('uses recent context and the discussion model task without launching architecture generation', async () => {
    const executeTaskStream = jest.spyOn(aiRouterService, 'executeTaskStream').mockResolvedValue({
      content: 'A USB-C input can power the controller through a suitable regulator.',
      modelProvider: 'openai',
      modelName: 'test-model',
      latencyMs: 1,
      inputTokens: 1,
      outputTokens: 1,
    } as never);
    const service = new SessionsService();
    const discuss = (service as unknown as {
      generateCopilotReply: (args: {
        sessionId: string;
        intentText: string;
        status: string;
        history: Array<{ role: 'user' | 'assistant'; content: string }>;
        latestMessage: string;
        hasArchitecture: boolean;
      }) => Promise<string>;
    }).generateCopilotReply.bind(service);

    const reply = await discuss({
      sessionId: 'session-test',
      intentText: 'USB-C powered water motor controller',
      status: 'CLARIFICATION_REQUIRED',
      history: [
        { role: 'assistant', content: 'What input voltage will you use?' },
        { role: 'user', content: 'USB-C 5V' },
      ],
      latestMessage: 'Can it drive a small pump?',
      hasArchitecture: false,
    });

    expect(reply).toContain('USB-C input');
    expect(executeTaskStream).toHaveBeenCalledTimes(1);
    const call = executeTaskStream.mock.calls[0][0];
    expect(call.taskCase).toBe('E');
    expect(call.systemPrompt).toContain('do not restart intake or repeat a question they already answered');
    expect(call.systemPrompt).toContain('Ask at most one question in a reply');
    expect(call.systemPrompt).toContain('Do not emit control markers such as READY or INTENT');
    expect(call.messages.at(-1)).toEqual({ role: 'user', content: 'Can it drive a small pump?' });
  });
});
