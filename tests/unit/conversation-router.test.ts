import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { routeMessage } from '../../src/modules/sessions/conversation-router.service.js';

const routerResult = (content: string) => ({
  content,
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 0,
  latencyMs: 10,
  costUsd: 0.0001,
  schemaPass: true,
  provider: 'openai',
  model: 'gpt-4o-mini',
  aiCallId: 'call-1',
});

describe('routeMessage (gibberish detection + dynamic reply)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('distinguishes gibberish (unreadable) from off-topic-but-coherent, and carries the model\'s own reply through', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(
      routerResult(
        JSON.stringify({
          mode: 'off_topic',
          projectTitle: '',
          isGibberish: true,
          reply: "I couldn't quite read that — try describing an embedded product you'd like to build.",
        })
      )
    );

    const result = await routeMessage('asdkjhasjkldhakjslhdfjsa');
    expect(result.mode).toBe('off_topic');
    expect(result.isGibberish).toBe(true);
    expect(result.reply).toBe("I couldn't quite read that — try describing an embedded product you'd like to build.");
  });

  it('off-topic-but-coherent (e.g. "how is the weather") is NOT flagged as gibberish', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(
      routerResult(
        JSON.stringify({
          mode: 'off_topic',
          projectTitle: '',
          isGibberish: false,
          reply: 'Embedo focuses on embedded hardware design — describe a device and I can help.',
        })
      )
    );

    const result = await routeMessage('how is the weather today?');
    expect(result.mode).toBe('off_topic');
    expect(result.isGibberish).toBe(false);
    expect(result.reply).toContain('embedded hardware');
  });

  it('falls back to the fixed message only when the model omits a reply for off_topic', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(
      routerResult(JSON.stringify({ mode: 'off_topic', projectTitle: '', isGibberish: false, reply: '' }))
    );

    const result = await routeMessage('asdf');
    expect(result.mode).toBe('off_topic');
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.reply).toContain('embedded hardware');
  });

  it('generate mode carries an empty reply and false isGibberish through untouched', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(
      routerResult(JSON.stringify({ mode: 'generate', projectTitle: 'ESP32 Weather Station', isGibberish: false, reply: '' }))
    );

    const result = await routeMessage('ESP32 weather station with BME280');
    expect(result.mode).toBe('generate');
    expect(result.projectTitle).toBe('ESP32 Weather Station');
    expect(result.isGibberish).toBe(false);
    expect(result.reply).toBe('');
  });

  it('retries once on unparseable JSON, still populating the new fields on success', async () => {
    const spy = jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValueOnce(routerResult('not json'))
      .mockResolvedValueOnce(routerResult(JSON.stringify({ mode: 'discuss', projectTitle: 'RC Car', isGibberish: false, reply: '' })));

    const result = await routeMessage('explain how a remote controlled car works');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe('discuss');
    expect(result.projectTitle).toBe('RC Car');
  });

  it('defaults to discuss (safe) with no gibberish flag and empty reply when unparseable twice', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(routerResult('still not json'));

    const result = await routeMessage('???');
    expect(result).toEqual({ mode: 'discuss', projectTitle: '', isGibberish: false, reply: '' });
  });

  it('defaults to generate with no gibberish flag and empty reply on a hard provider failure', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockRejectedValue(new Error('provider down'));

    const result = await routeMessage('anything');
    expect(result).toEqual({ mode: 'generate', projectTitle: '', isGibberish: false, reply: '' });
  });

  it('tolerates null isGibberish/reply from the model (schema coerces to false/"")', async () => {
    jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValue(routerResult(JSON.stringify({ mode: 'discuss', projectTitle: 'X', isGibberish: null, reply: null })));

    const result = await routeMessage('ok');
    expect(result.isGibberish).toBe(false);
    expect(result.reply).toBe('');
  });
});
