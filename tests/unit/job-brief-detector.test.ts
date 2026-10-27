import { describe, it, expect } from '@jest/globals';
import { classifyJobBrief } from '../../src/modules/sessions/pipeline/job-brief-detector.js';

describe('EAR-11: Upwork & RFP Job Brief Classification', () => {
  const upworkJobText = `
Job Title: Experienced Embedded Engineer for STM32 + LoRaWAN Environmental Tracker
Hourly Range: $45.00 - $70.00
Est. Budget: $2,500
Proposals: 5 to 10
Client Country: United States

Job Description:
We are looking for an experienced embedded firmware and hardware engineer to design an ultra-low power sensor node.
Must support STM32 MCU, SX1262 LoRaWAN radio, SHT40 temperature sensor, and battery power.
Deliverables:
- Schematic & PCB layout files
- Functional Block Diagram
- Power budget calculations
Skills and Expertise: Embedded Systems, STM32, LoRaWAN, PCB Design.
`;

  it('detects an Upwork job brief with marketplace boilerplate and defaults to analyze mode', () => {
    const classification = classifyJobBrief(upworkJobText);
    expect(classification.isJobDescription).toBe(true);
    expect(classification.intentType).toBe('analyze');
    expect(classification.marketplace).toBe('upwork');
    expect(classification.detectedMarkers.length).toBeGreaterThanOrEqual(3);
  });

  it('classifies as generate when the user explicitly commands generation alongside the job', () => {
    const textWithCommand = `${upworkJobText}\n\nPlease generate architecture from this brief.`;
    const classification = classifyJobBrief(textWithCommand);
    expect(classification.isJobDescription).toBe(true);
    expect(classification.intentType).toBe('generate');
  });

  it('classifies as client_questions when the user asks what to ask the client', () => {
    const textWithQuestions = `${upworkJobText}\n\nWhat client questions should I ask before starting?`;
    const classification = classifyJobBrief(textWithQuestions);
    expect(classification.isJobDescription).toBe(true);
    expect(classification.intentType).toBe('client_questions');
  });

  it('ignores ordinary hardware prompts that are not job postings', () => {
    const regularPrompt = 'Design a solar powered weather station with ESP32, BME280, and e-paper display.';
    const classification = classifyJobBrief(regularPrompt);
    expect(classification.isJobDescription).toBe(false);
  });
});

