import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { resumePendingClarification, routeMessage } from '../../src/modules/sessions/conversation-router.service.js';

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
    const executeTask = jest.spyOn(aiRouterService, 'executeTask')
      .mockResolvedValueOnce(
        routerResult(JSON.stringify({ mode: 'off_topic', projectTitle: '', isGibberish: true, reply: '' }))
      )
      .mockResolvedValueOnce(routerResult('Could you describe what you meant another way?'));

    const result = await routeMessage('asdkjhasjkldhakjslhdfjsa');
    expect(result.mode).toBe('off_topic');
    expect(result.isGibberish).toBe(true);
    expect(result.reply).toBe('Could you describe what you meant another way?');
    expect(executeTask).toHaveBeenCalledTimes(2);
    const replyCall = executeTask.mock.calls[1]?.[0];
    expect(replyCall?.systemPrompt).toContain('Generate fresh wording');
    expect(replyCall?.systemPrompt).toContain('avoid stock wording and near-duplicates');
    expect(replyCall?.temperature).toBeGreaterThan(0.7);
  });

  it('never sends heuristic gibberish to generation and falls back to the AI copilot for its reply', async () => {
    const executeTask = jest.spyOn(aiRouterService, 'executeTask')
      .mockResolvedValueOnce(routerResult(JSON.stringify({ mode: 'generate', projectTitle: '', isGibberish: false, reply: '' })))
      .mockResolvedValueOnce(routerResult('I could not make sense of that message; could you try phrasing it differently?'));

    const result = await routeMessage('asdasdasdasd');

    expect(executeTask).toHaveBeenCalledTimes(2);
    expect(result.mode).toBe('off_topic');
    expect(result.isGibberish).toBe(true);
    expect(result.reply).toContain('try phrasing it differently');
  });

  it('passes prior replies to the AI so repeated unreadable turns can be worded differently', async () => {
    const executeTask = jest.spyOn(aiRouterService, 'executeTask')
      .mockResolvedValueOnce(routerResult(JSON.stringify({ mode: 'off_topic', projectTitle: '', isGibberish: true, reply: '' })))
      .mockResolvedValueOnce(routerResult('That last note was hard to follow; want to give it another try?'));
    const previousReply = 'Could you please repeat that in your own words?';

    const result = await routeMessage('asdasd', 'session-1', [{ role: 'assistant', content: previousReply }]);

    expect(result.reply).toBe('That last note was hard to follow; want to give it another try?');
    expect(executeTask.mock.calls[1]?.[0].messages).toContainEqual({ role: 'assistant', content: previousReply });
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

  it('routes an off-topic result without a reply to the contextual copilot', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(
      routerResult(JSON.stringify({ mode: 'off_topic', projectTitle: '', isGibberish: false, reply: '' }))
    );

    const result = await routeMessage('tell me a joke');
    expect(result.mode).toBe('discuss');
    expect(result.reply).toBe('');
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

  it('routes an affirmative answer to an explicit architecture-generation offer to generate', async () => {
    const spy = jest.spyOn(aiRouterService, 'executeTask');
    const result = await routeMessage(
      'yes please',
      'session-1',
      [{ role: 'assistant', content: 'Would you like to proceed with generating the full architecture (block diagram, power tree, protocol map, BOM)?' }],
      { projectTitle: 'Water Motor Controller', originalBrief: 'Water motor controller' }
    );

    expect(result.mode).toBe('generate');
    expect(result.projectTitle).toBe('Water Motor Controller');
    expect(spy).not.toHaveBeenCalled();
  });

  it('resumes the pipeline for an answer even when the router mislabels it off-topic', () => {
    const result = resumePendingClarification(
      { mode: 'off_topic', projectTitle: '', isGibberish: false, isNewProject: false, reply: 'What do you mean?' },
      true
    );

    expect(result.mode).toBe('generate');
    expect(result.reply).toBe('');
  });

  it('recognizes a short reply to an intake question even when it is labeled discuss', async () => {
    const spy = jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(
      routerResult(JSON.stringify({
        mode: 'discuss',
        projectTitle: 'Embedded Controller',
        isGibberish: false,
        isNewProject: false,
        reply: '',
        isAnswerToPendingQuestion: true,
      }))
    );

    const result = await routeMessage(
      '12 V DC',
      'session-1',
      [{ role: 'assistant', content: 'What voltage does the actuator require?' }],
      { projectTitle: 'Embedded Controller', originalBrief: 'embedded controller' }
    );

    expect(result.isAnswerToPendingQuestion).toBe(true);
    expect(resumePendingClarification(result, result.isAnswerToPendingQuestion).mode).toBe('generate');
    expect(spy.mock.calls[0]?.[0].systemPrompt).toContain('specific question in the immediately preceding assistant message');
    expect(spy.mock.calls[0]?.[0].systemPrompt).not.toContain('water motor');
  });

  it('treats a concise product concept as an implicit new design request', async () => {
    const spy = jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(
      routerResult(JSON.stringify({ mode: 'generate', projectTitle: 'Environmental Sensor Node', isGibberish: false, isNewProject: false, reply: '' }))
    );

    const result = await routeMessage('remote environmental sensor node');

    expect(result.mode).toBe('generate');
    expect(spy.mock.calls[0]?.[0].systemPrompt).toContain('concise name or description of an embedded product');
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
    expect(result).toEqual({ mode: 'discuss', projectTitle: '', isGibberish: false, isNewProject: false, reply: '', isAnswerToPendingQuestion: false });
  });

  it('defaults to generate with no gibberish flag and empty reply on a hard provider failure', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockRejectedValue(new Error('provider down'));

    const result = await routeMessage('anything');
    expect(result).toEqual({ mode: 'generate', projectTitle: '', isGibberish: false, isNewProject: false, reply: '', isAnswerToPendingQuestion: false });
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
