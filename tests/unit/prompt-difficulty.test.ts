import { describe, it, expect, jest, afterEach, beforeEach } from '@jest/globals';
import { prisma } from '../../src/db/prisma.js';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { modelProviderService } from '../../src/modules/ai/model-provider.service.js';
import { classifyPrompt, DIFFICULTY_THRESHOLDS, isDifficultyTaskCase } from '../../src/modules/ai/prompt-classifier.js';

const INDUSTRIAL_BRIEF = `Industrial monitoring node built on an STM32H743 Nucleo.
- 12V DC input, buck to 5V and 3.3V rails
- CAN bus to 3 CANopen motor controllers, RS-485 Modbus to 2 gas sensors
- BME688 and SHT31-D over I2C, ICM-42688-P IMU over SPI, LIS3MDL magnetometer
- NEO-M8N GPS on UART, SIM7600 LTE modem on UART, BLE via nRF52840
- microSD logging, W25Q128 flash, 2.9in e-ink display, 4 relays for pumps, an e-stop input
- IP67 enclosure, -40C to 85C, watchdog and fail-safe outputs, OTA firmware updates
- under 50 mA average, real-time 1 kHz control loop`;

describe('classifyPrompt', () => {
  it('rates small requests easy', () => {
    for (const text of ['hi', 'Blink an LED with an Arduino Uno', 'What does a pull-up resistor do on I2C?']) {
      const r = classifyPrompt(text);
      expect(r.difficulty).toBe('easy');
      expect(r.score).toBeLessThan(DIFFICULTY_THRESHOLDS.medium);
    }
  });

  it('rates a typical multi-block bench medium', () => {
    const r = classifyPrompt(
      'Raspberry Pi Pico logging temperature, humidity and pressure from a BME280 and position from an Adafruit Ultimate GPS to a microSD card',
    );
    expect(r.difficulty).toBe('medium');
    expect(r.signals.join(' ')).toMatch(/kinds of block/);
  });

  it('rates a large industrial brief hard and says why', () => {
    const r = classifyPrompt(INDUSTRIAL_BRIEF);
    expect(r.difficulty).toBe('hard');
    expect(r.score).toBeGreaterThanOrEqual(DIFFICULTY_THRESHOLDS.hard);
    const why = r.signals.join(' | ');
    expect(why).toMatch(/field or high-speed bus: CAN, RS-485, Modbus/);
    expect(why).toMatch(/real time/);
    expect(why).not.toMatch(/cost\/size target/); // "under 50 mA" is a current budget, not a price
  });

  it('is deterministic and bounded', () => {
    expect(classifyPrompt(INDUSTRIAL_BRIEF)).toEqual(classifyPrompt(INDUSTRIAL_BRIEF));
    const huge = classifyPrompt(INDUSTRIAL_BRIEF.repeat(200));
    expect(huge.score).toBeLessThanOrEqual(100);
    expect(classifyPrompt('')).toEqual({ difficulty: 'easy', score: 0, signals: [] });
  });

  it('does not read "can" as the CAN bus', () => {
    const r = classifyPrompt('Can you tell me which sensor I can use? It can be anything.');
    expect(r.signals.join(' ')).not.toMatch(/CAN/);
  });

  it('only classifies A, R and E', () => {
    expect(['A', 'R', 'E'].every(isDifficultyTaskCase)).toBe(true);
    expect(['B', 'F', 'M', 'X'].some(isDifficultyTaskCase)).toBe(false);
  });
});

describe('aiRouterService difficulty routing', () => {
  const generate = () =>
    jest.spyOn(modelProviderService, 'generate').mockResolvedValue({ text: '{}', inputTokens: 10, outputTokens: 5, latencyMs: 3 } as never);

  beforeEach(() => {
    aiRouterService.clearCache();
    jest.spyOn(prisma.modelRoute, 'findFirst').mockResolvedValue({
      modelProvider: 'openai', modelName: 'gpt-4o', temperature: 0.2, maxTokens: 4096,
    } as never);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    aiRouterService.clearCache();
  });

  it('uses the difficulty route for a classified call and records the difficulty', async () => {
    jest.spyOn(prisma.difficultyModelRoute, 'findMany').mockResolvedValue([
      { taskCase: 'A', difficulty: 'hard', modelProvider: 'anthropic', modelName: 'claude-opus-4-1', isActive: true },
      { taskCase: 'A', difficulty: 'easy', modelProvider: 'openai', modelName: 'gpt-4o-mini', isActive: true },
    ] as never);
    const gen = generate();
    const create = jest.spyOn(prisma.aiCall, 'create').mockResolvedValue({ id: 'c1' } as never);

    const result = await aiRouterService.executeTask({ taskCase: 'A', userPrompt: 'assembled prompt', difficultyText: INDUSTRIAL_BRIEF, sessionId: 's1' });

    expect(gen).toHaveBeenCalledWith('anthropic', expect.objectContaining({ model: 'claude-opus-4-1' }));
    expect(result).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-1', difficulty: 'hard' });
    expect(create.mock.calls[0]![0]).toMatchObject({ data: { promptDifficulty: 'hard', modelName: 'claude-opus-4-1' } });
  });

  it('keeps the task route when no row matches the difficulty', async () => {
    jest.spyOn(prisma.difficultyModelRoute, 'findMany').mockResolvedValue([
      { taskCase: 'A', difficulty: 'hard', modelProvider: 'anthropic', modelName: 'claude-opus-4-1', isActive: true },
    ] as never);
    const gen = generate();
    const result = await aiRouterService.executeTask({ taskCase: 'A', userPrompt: 'x', difficultyText: 'Blink an LED' });
    expect(gen).toHaveBeenCalledWith('openai', expect.objectContaining({ model: 'gpt-4o' }));
    expect(result.difficulty).toBe('easy');
  });

  it('does not classify task cases outside A/R/E or calls without the user text', async () => {
    const find = jest.spyOn(prisma.difficultyModelRoute, 'findMany').mockResolvedValue([] as never);
    generate();
    const a = await aiRouterService.executeTask({ taskCase: 'F', userPrompt: 'x', difficultyText: INDUSTRIAL_BRIEF });
    const b = await aiRouterService.executeTask({ taskCase: 'A', userPrompt: INDUSTRIAL_BRIEF });
    expect(a.difficulty).toBeUndefined();
    expect(b.difficulty).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });

  it('falls back to the task route when the table cannot be read', async () => {
    jest.spyOn(prisma.difficultyModelRoute, 'findMany').mockRejectedValue(new Error('relation does not exist'));
    const gen = generate();
    const result = await aiRouterService.executeTask({ taskCase: 'R', userPrompt: 'x', difficultyText: INDUSTRIAL_BRIEF });
    expect(gen).toHaveBeenCalledWith('openai', expect.objectContaining({ model: 'gpt-4o' }));
    expect(result.difficulty).toBe('hard');
  });

  it('retries on the task route when the difficulty model fails, and records the model that answered', async () => {
    jest.spyOn(prisma.difficultyModelRoute, 'findMany').mockResolvedValue([
      { taskCase: 'A', difficulty: 'hard', modelProvider: 'openai', modelName: 'gpt-retired', isActive: true },
    ] as never);
    const gen = jest
      .spyOn(modelProviderService, 'generate')
      .mockRejectedValueOnce(new Error('404 The model gpt-retired does not exist'))
      .mockResolvedValueOnce({ text: '{}', inputTokens: 10, outputTokens: 5, latencyMs: 3 } as never);
    const create = jest.spyOn(prisma.aiCall, 'create').mockResolvedValue({ id: 'c2' } as never);
    const result = await aiRouterService.executeTask({ taskCase: 'A', userPrompt: 'x', difficultyText: INDUSTRIAL_BRIEF, sessionId: 's1' });
    expect(gen.mock.calls.map((c) => (c[1] as { model: string }).model)).toEqual(['gpt-retired', 'gpt-4o']);
    expect(result).toMatchObject({ model: 'gpt-4o', difficulty: 'hard' });
    expect(create.mock.calls[0]![0]).toMatchObject({ data: { modelName: 'gpt-4o', promptDifficulty: 'hard' } });
  });

  it('does not retry a stream that already sent text', async () => {
    jest.spyOn(prisma.difficultyModelRoute, 'findMany').mockResolvedValue([
      { taskCase: 'E', difficulty: 'hard', modelProvider: 'anthropic', modelName: 'claude-x', isActive: true },
    ] as never);
    const stream = jest.spyOn(modelProviderService, 'generateStream').mockImplementation(async (_p, o) => {
      (o as { onDelta: (d: string, m: object) => void }).onDelta('Hel', {});
      throw new Error('connection reset');
    });
    jest.spyOn(prisma.aiCall, 'create').mockResolvedValue({ id: 'c3' } as never);
    await expect(
      aiRouterService.executeTaskStream({ taskCase: 'E', userPrompt: 'x', difficultyText: INDUSTRIAL_BRIEF, sessionId: 's1', onDelta: () => undefined }),
    ).rejects.toThrow('connection reset');
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('ignores rows naming an unsupported provider and never mutates the cached task route', async () => {
    jest.spyOn(prisma.difficultyModelRoute, 'findMany').mockResolvedValue([
      { taskCase: 'E', difficulty: 'hard', modelProvider: 'mystery', modelName: 'm1', isActive: true },
      { taskCase: 'E', difficulty: 'easy', modelProvider: 'google', modelName: 'gemini-2.0-flash', isActive: true },
    ] as never);
    const gen = generate();
    await aiRouterService.executeTask({ taskCase: 'E', userPrompt: 'x', difficultyText: 'hi' });
    await aiRouterService.executeTask({ taskCase: 'E', userPrompt: 'x', difficultyText: INDUSTRIAL_BRIEF });
    expect(gen.mock.calls.map((c) => c[0])).toEqual(['google', 'openai']);
    expect((await aiRouterService.resolveRoute('E')).model).toBe('gpt-4o');
  });
});
