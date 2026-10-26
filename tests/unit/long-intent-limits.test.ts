import { describe, it, expect } from '@jest/globals';
import {
  MAX_MESSAGE_CHARS,
  createSessionSchema,
  discussSchema,
} from '../../src/modules/sessions/sessions.validation.js';

describe('Long Intent & Message Length Limits (EAR-4)', () => {
  describe('MAX_MESSAGE_CHARS policy', () => {
    it('is set to exactly 6000 characters', () => {
      expect(MAX_MESSAGE_CHARS).toBe(6000);
    });
  });

  describe('createSessionSchema (Home Intent Input)', () => {
    it('accepts intent text up to MAX_MESSAGE_CHARS (6000 chars)', () => {
      const intent = 'A'.repeat(6000);
      const parsed = createSessionSchema.safeParse({ intentText: intent });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.intentText.length).toBe(6000);
      }
    });

    it('rejects intent text exceeding MAX_MESSAGE_CHARS with descriptive validation error', () => {
      const oversizedIntent = 'B'.repeat(6001);
      const parsed = createSessionSchema.safeParse({ intentText: oversizedIntent });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        expect(issue.path).toContain('intentText');
        expect(issue.message).toBe('Intent text cannot exceed 6000 characters');
      }
    });

    it('preserves multi-paragraph, multiline specifications completely', () => {
      const multilineSpec = [
        '# Industrial IoT Sensor Hub Specification',
        '',
        '## 1. Power Supply Subsystem',
        '- Primary input: 24V DC industrial rail with TVS transient suppression.',
        '- Buck stage: 3.3V @ 1.5A for MCU and sensors using LMR14030-Q1.',
        '- Backup: Li-ion 18650 cell with MCP73831 battery management.',
        '',
        '## 2. Microcontroller & Wireless',
        '- MCU: STM32WLE5CC with LoRaWAN transceivers operating at 868 MHz.',
        '- Flash: External 128Mbit SPI NOR Flash (Winbond W25Q128JV).',
        '',
        '## 3. Sensor Interfaces',
        '- I2C Bus: SHT40 temperature/humidity sensor (0x44), BMP390 pressure (0x77).',
        '- RS-485: Isolated differential pair terminated with 120-ohm resistor.',
        '- Digital PDM: dual MEMS microphones for acoustic vibration analysis.',
      ].join('\n');

      const parsed = createSessionSchema.safeParse({ intentText: multilineSpec });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.intentText).toBe(multilineSpec);
        expect(parsed.data.intentText).toContain('Digital PDM: dual MEMS microphones');
      }
    });

    it('preserves multi-byte Unicode engineering symbols and international characters', () => {
      const unicodeSpec = 'Design a precision measurement device: ±0.05% accuracy, 3.3V rail, 20µA sleep current, 100kΩ pull-up, -40°C to +85°C rating, λ=850nm optical sensor 🚀';
      const parsed = createSessionSchema.safeParse({ intentText: unicodeSpec });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.intentText).toBe(unicodeSpec);
        expect(parsed.data.intentText).toContain('±0.05%');
        expect(parsed.data.intentText).toContain('20µA');
        expect(parsed.data.intentText).toContain('100kΩ');
        expect(parsed.data.intentText).toContain('-40°C');
        expect(parsed.data.intentText).toContain('🚀');
      }
    });
  });

  describe('discussSchema (Workspace Chat Input)', () => {
    it('accepts messages up to MAX_MESSAGE_CHARS (6000 chars)', () => {
      const longMessage = 'Detailed hardware prompt: ' + 'x'.repeat(5950);
      expect(longMessage.length).toBeLessThanOrEqual(6000);
      const parsed = discussSchema.safeParse({
        messages: [{ role: 'user', content: longMessage }],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.messages[0].content.length).toBe(longMessage.length);
      }
    });

    it('rejects workspace messages exceeding 6000 characters with descriptive validation error', () => {
      const oversizedMessage = 'x'.repeat(6001);
      const parsed = discussSchema.safeParse({
        messages: [{ role: 'user', content: oversizedMessage }],
      });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        expect(issue.message).toBe('Message content cannot exceed 6000 characters');
      }
    });

    it('allows multi-turn conversation where individual turns are lengthy engineering briefs', () => {
      const turn1 = 'Initial spec: ' + 'A'.repeat(2500);
      const turn2 = 'Assistant summary: ' + 'B'.repeat(2500);
      const turn3 = 'Refinement instructions: ' + 'C'.repeat(3000);

      const parsed = discussSchema.safeParse({
        messages: [
          { role: 'user', content: turn1 },
          { role: 'assistant', content: turn2 },
          { role: 'user', content: turn3 },
        ],
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.messages).toHaveLength(3);
        expect(parsed.data.messages[0].content).toHaveLength(turn1.length);
        expect(parsed.data.messages[2].content).toHaveLength(turn3.length);
      }
    });

    it('supports both Architect and Prototype session types for long messages', () => {
      const longSpec = 'Spec: ' + 'm'.repeat(3500);
      const architectParsed = discussSchema.safeParse({
        messages: [{ role: 'user', content: longSpec }],
        type: 'architect',
      });
      const prototypeParsed = discussSchema.safeParse({
        messages: [{ role: 'user', content: longSpec }],
        type: 'prototype',
      });
      expect(architectParsed.success).toBe(true);
      expect(prototypeParsed.success).toBe(true);
    });
  });
});

