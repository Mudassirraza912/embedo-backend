import { describe, it, expect, jest, afterEach } from '@jest/globals';
import { datasheetIngestionService } from '../../src/modules/components/datasheet-ingestion.service.js';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';

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
});

describe('AI Hardware Domain Gatekeeper (isolated)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('approves authentic electronic hardware text', async () => {
    jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValue(routerResult(JSON.stringify({ isValid: true, detectedDomain: 'Microcontroller Datasheet', rejectionReason: null })));

    const check = await datasheetIngestionService.validateHardwareDomain(
      'ESP32-WROOM-32 Technical Datasheet. Operating voltage: 3.0V - 3.6V. Pin definitions: GPIO0, GPIO2, VDD33.',
      'https://example.com/esp32.pdf'
    );
    expect(check.isValid).toBe(true);
    expect(check.detectedDomain).toBe('Microcontroller Datasheet');
  });

  it('rejects non-hardware content such as recipes', async () => {
    jest
      .spyOn(aiRouterService, 'executeTask')
      .mockResolvedValue(routerResult(JSON.stringify({ isValid: false, detectedDomain: 'Culinary / Food Recipe', rejectionReason: 'Not a datasheet' })));

    const check = await datasheetIngestionService.validateHardwareDomain("Grandma's chocolate chip cookies recipe", 'https://example.com/cookies.pdf');
    expect(check.isValid).toBe(false);
    expect(check.rejectionReason).toBe('Not a datasheet');
  });

  it('fails closed when the classifier returns an unreadable response', async () => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(routerResult('not json at all'));
    jest.spyOn(aiRouterService, 'markSchemaResult').mockResolvedValue(undefined);

    await expect(
      datasheetIngestionService.validateHardwareDomain('some text', 'https://example.com/x.pdf')
    ).rejects.toMatchObject({ statusCode: 502 });
  });
});
