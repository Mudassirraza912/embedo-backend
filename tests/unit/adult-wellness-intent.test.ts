import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { isAdultWellnessHardware, moderationService } from '../../src/modules/governance/moderation.service.js';
import { modelProviderService } from '../../src/modules/ai/model-provider.service.js';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { routeMessage } from '../../src/modules/sessions/conversation-router.service.js';
import { parseHardwareIntent } from '../../src/modules/sessions/pipeline/intent-parser.js';
import { checkSufficiency } from '../../src/modules/sessions/pipeline/sufficiency-gate.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';

const mockAiResponse = (content: string) => ({
  content,
  inputTokens: 100,
  outputTokens: 50,
  cachedTokens: 0,
  latencyMs: 15,
  costUsd: 0.0001,
  schemaPass: true,
  provider: 'openai',
  model: 'gpt-4o-mini',
  aiCallId: 'mock-call-1',
});

describe('EAR-9: Adult Wellness Product Intent & Governance Unblocking', () => {
  beforeEach(() => {
    jest.spyOn(prisma.moderationEvent, 'create').mockResolvedValue({} as never);
    jest.spyOn(prisma.user, 'update').mockResolvedValue({} as never);
    jest.spyOn(redis, 'incr').mockResolvedValue(1);
    jest.spyOn(redis, 'expire').mockResolvedValue(1);
    jest.spyOn(redis, 'set').mockResolvedValue('OK');
    jest.spyOn(redis, 'del').mockResolvedValue(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Domain Hardware Classification & Minor Safety Guardrails', () => {
    it('correctly classifies legitimate adult wellness and personal care hardware products', () => {
      const allowedQueries = [
        'vibrator tool for girls',
        'smart adult wellness vibrator with BLE and haptic feedback',
        'waterproof rechargeable intimate massager with USB-C',
        'pelvic floor trainer with pressure sensor and biofeedback',
        'clitoral suction stimulator with magnetic charging',
        'kegel exerciser with Bluetooth app connectivity',
        'prostate massager with RF remote',
        'silicone vibrating adult toy with Li-ion battery',
        'dual-motor intimate wellness massager',
      ];

      for (const query of allowedQueries) {
        expect(isAdultWellnessHardware(query)).toBe(true);
      }
    });

    it('strictly rejects any queries involving minors, children, or underage terms', () => {
      const prohibitedQueries = [
        'vibrator for little girl',
        'vibrator for young girl',
        'schoolgirl vibrator device',
        'underage intimate massager',
        'child sexual wellness toy',
        'infant vibrating device',
        'teenager vibrator tool',
        'pedophile sex toy',
      ];

      for (const query of prohibitedQueries) {
        expect(isAdultWellnessHardware(query)).toBe(false);
      }
    });

    it('returns false for general, non-wellness hardware or non-hardware queries', () => {
      const nonWellnessQueries = [
        'esp32 weather station with oled display',
        'how is the weather in Paris today',
        'tell me a funny bedtime story',
        'quadcopter drone with brushless motors',
        'smart door lock with fingerprint scanner',
      ];

      for (const query of nonWellnessQueries) {
        expect(isAdultWellnessHardware(query)).toBe(false);
      }
    });
  });

  describe('2. Moderation Governance Tier 2 & Tier 3 Handling', () => {
    it('unblocks adult wellness hardware when provider moderation API returns solely sexual category', async () => {
      jest.spyOn(modelProviderService, 'moderate').mockResolvedValueOnce({
        flagged: true,
        categories: ['sexual'],
      });
      jest.spyOn(aiRouterService, 'executeTask').mockResolvedValueOnce(
        mockAiResponse(JSON.stringify({ flagged: false, category: 'none', reason: '' }))
      );

      const result = await moderationService.screenText('vibrator tool for girls', { anonIdentifier: 'user-ip-1' });

      expect(result.allowed).toBe(true);
      expect(result.flaggedTier).toBeUndefined();
    });

    it('blocks adult wellness queries if provider flags sexual/minors category', async () => {
      jest.spyOn(modelProviderService, 'moderate').mockResolvedValueOnce({
        flagged: true,
        categories: ['sexual', 'sexual/minors'],
      });

      const result = await moderationService.screenText('vibrator tool for girls', { anonIdentifier: 'user-ip-2' });

      expect(result.allowed).toBe(false);
      expect(result.flaggedTier).toBe('provider_api');
      expect(result.category).toContain('sexual/minors');
    });

    it('blocks queries if provider flags violence or hate categories alongside sexual', async () => {
      jest.spyOn(modelProviderService, 'moderate').mockResolvedValueOnce({
        flagged: true,
        categories: ['sexual', 'violence'],
      });

      const result = await moderationService.screenText('violent intimate vibrator device', { anonIdentifier: 'user-ip-3' });

      expect(result.allowed).toBe(false);
      expect(result.flaggedTier).toBe('provider_api');
      expect(result.category).toContain('violence');
    });

    it('blocks Tier 1 prohibited items even if phrased with wellness terms', async () => {
      const result = await moderationService.screenText('vibrator with bomb detonator trigger', { anonIdentifier: 'user-ip-4' });

      expect(result.allowed).toBe(false);
      expect(result.flaggedTier).toBe('wordlist');
      expect(result.category).toBe('explosives');
    });
  });

  describe('3. Conversation Router Classification', () => {
    it('routes "vibrator tool for girls" to generate with clean title even if model returns off_topic', async () => {
      jest.spyOn(aiRouterService, 'executeTask').mockResolvedValueOnce(
        mockAiResponse(
          JSON.stringify({
            mode: 'off_topic',
            projectTitle: '',
            isGibberish: false,
            reply: 'Embedo only designs embedded hardware architectures.',
          })
        )
      );

      const result = await routeMessage('vibrator tool for girls');

      expect(result.mode).toBe('generate');
      expect(result.projectTitle).toBe('Adult Wellness Vibrator');
      expect(result.isGibberish).toBe(false);
      expect(result.reply).toBe('');
    });

    it('routes explicit adult wellness questions to discuss mode', async () => {
      jest.spyOn(aiRouterService, 'executeTask').mockResolvedValueOnce(
        mockAiResponse(
          JSON.stringify({
            mode: 'discuss',
            projectTitle: 'Pelvic Floor Trainer',
            isGibberish: false,
            reply: '',
          })
        )
      );

      const result = await routeMessage('how does a kegel pelvic floor sensor measure muscle pressure?');

      expect(result.mode).toBe('discuss');
      expect(result.projectTitle).toBe('Pelvic Floor Trainer');
      expect(result.reply).toBe('');
    });

    it('preserves off_topic for general chit-chat and non-hardware requests', async () => {
      jest.spyOn(aiRouterService, 'executeTask').mockResolvedValueOnce(
        mockAiResponse(
          JSON.stringify({
            mode: 'off_topic',
            projectTitle: '',
            isGibberish: false,
            reply: 'Embedo focuses on embedded hardware design.',
          })
        )
      );

      const result = await routeMessage('what is the capital of France?');

      expect(result.mode).toBe('off_topic');
      expect(result.reply).toContain('embedded hardware design');
    });
  });

  describe('4. Intent Parser & Sufficiency Gate Pipeline Verification', () => {
    it('unblocks adult wellness intent when parser initially marks isOffTopic: true', async () => {
      jest.spyOn(aiRouterService, 'executeTask').mockResolvedValueOnce(
        mockAiResponse(
          JSON.stringify({
            deviceType: '',
            purpose: '',
            subsystems: {
              sensing: null,
              actuation: null,
              connectivity: null,
              power: null,
              storage: null,
              ui: null,
              audio: null,
            },
            constraints: {
              formFactor: null,
              powerSource: null,
              batteryLifeHours: null,
              environment: null,
              costTargetUsd: null,
            },
            mustHaveInterfaces: [],
            isOffTopic: true,
          })
        )
      );

      const parsed = await parseHardwareIntent('vibrator tool for girls');

      expect(parsed.structured.isOffTopic).toBe(false);
      expect(parsed.structured.deviceType).toBe('Adult Wellness Vibrator');
      expect(parsed.structured.subsystems.actuation).toContain('motor');
      expect(parsed.structured.subsystems.power).toContain('lipo_battery');
      expect(parsed.structured.constraints.formFactor).toBe('handheld');

      // Test downstream sufficiency gate with this structured intent
      const sufficiency = checkSufficiency(parsed.structured, 'vibrator tool for girls');
      expect(sufficiency.sufficient).toBe(true);
      expect(sufficiency.isOffTopic).toBeUndefined();
      expect(sufficiency.missingFields).toHaveLength(0);
    });

    it('passes sufficiency gate for detailed smart adult wellness queries', async () => {
      jest.spyOn(aiRouterService, 'executeTask').mockResolvedValueOnce(
        mockAiResponse(
          JSON.stringify({
            deviceType: 'Smart Intimate Massager',
            purpose: 'Rechargeable personal care intimate wellness massager with BLE controls and haptics',
            subsystems: {
              sensing: ['temperature'],
              actuation: ['motor', 'haptic'],
              connectivity: ['ble'],
              power: ['lipo_battery', 'usb_c'],
              storage: null,
              ui: ['buttons', 'rgb_leds'],
              audio: null,
            },
            constraints: {
              formFactor: 'handheld',
              powerSource: '3.7V LiPo with USB-C Charging',
              batteryLifeHours: 4,
              environment: 'waterproof',
              costTargetUsd: 25,
            },
            mustHaveInterfaces: ['i2c', 'ble'],
            isOffTopic: false,
          })
        )
      );

      const parsed = await parseHardwareIntent('smart adult wellness vibrator with BLE and haptic feedback');
      expect(parsed.structured.isOffTopic).toBe(false);

      const sufficiency = checkSufficiency(parsed.structured, 'smart adult wellness vibrator with BLE and haptic feedback');
      expect(sufficiency.sufficient).toBe(true);
      expect(sufficiency.isOffTopic).toBeUndefined();
    });
  });
});

