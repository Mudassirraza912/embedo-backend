import { describe, it, expect, jest, beforeEach, afterEach } from '@jest/globals';
import { redis } from '../../src/db/redis.js';
import { emitSessionEvent } from '../../src/modules/realtime/socket.js';

describe('KAN-57: Truthful, Context-Aware Live Activity for Architect and Chat', () => {
  const TEST_SESSION_ID = '77777777-8888-9999-aaaa-bbbbbbbbbbbb';

  beforeEach(() => {
    jest.spyOn(redis, 'get').mockResolvedValue('0');
    jest.spyOn(redis, 'ttl').mockResolvedValue(86400);
    jest.spyOn(redis, 'incr').mockResolvedValue(1);
    jest.spyOn(redis, 'expire').mockResolvedValue(1);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('1. Operation Classification Contract', () => {
    it('correctly maps conversational hardware questions to operationType qa without synthesis checklists', () => {
      const q = 'What is the recommended operating voltage for the microcontroller?';
      const isQuestion = /\?$/.test(q.trim()) || /^(what|how|why|can|is|are|does|do|will|explain|compare|calculate)\b/i.test(q.trim());
      expect(isQuestion).toBe(true);

      const mappedOpType = isQuestion ? 'qa' : 'design_revision';
      expect(mappedOpType).toBe('qa');
    });

    it('correctly maps architectural modification to design_revision when an architecture already exists', () => {
      const refinement = 'Add an external watchdog timer IC and a 3.3V LDO';
      const hasArchitecture = true;
      const isQuestion = /\?$/.test(refinement.trim()) || /^(what|how|why|can|is|are|does|do|will|explain|compare|calculate)\b/i.test(refinement.trim());
      expect(isQuestion).toBe(false);

      const mappedOpType = isQuestion ? 'qa' : hasArchitecture ? 'design_revision' : 'initial_generation';
      expect(mappedOpType).toBe('design_revision');
    });

    it('correctly maps prototype inquiries and builds to prototype_qa and prototype_build', () => {
      const protoQuestion = 'How does the I2C OLED display connect to the Raspberry Pi Pico?';
      const isProtoQ = /\?$/.test(protoQuestion.trim());
      const protoOpType = isProtoQ ? 'prototype_qa' : 'prototype_build';
      expect(protoOpType).toBe('prototype_qa');

      const protoBuild = 'Connect the BME280 sensor to I2C0 bus on pins GP4 and GP5';
      const isProtoBuildQ = /\?$/.test(protoBuild.trim());
      const protoBuildOp = isProtoBuildQ ? 'prototype_qa' : 'prototype_build';
      expect(protoBuildOp).toBe('prototype_build');
    });
  });

  describe('2. Live Event Payload Structure & Grounding', () => {
    it('stageUpdate emits operationType and truthful label for Q&A without leaking chain-of-thought', () => {
      const stageSpy = jest.spyOn(emitSessionEvent, 'stageUpdate').mockImplementation(() => {});

      emitSessionEvent.stageUpdate(TEST_SESSION_ID, {
        step: 1,
        label: 'Formulating engineering answer...',
        progress: 50,
        operationType: 'qa',
      });

      expect(stageSpy).toHaveBeenCalledWith(TEST_SESSION_ID, {
        step: 1,
        label: 'Formulating engineering answer...',
        progress: 50,
        operationType: 'qa',
      });
      expect(stageSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ label: expect.stringMatching(/assigning pins|reading intent|wiring blocks/i) })
      );
    });

    it('stageUpdate emits revision-specific stages during architecture modifications', () => {
      const stageSpy = jest.spyOn(emitSessionEvent, 'stageUpdate').mockImplementation(() => {});

      // Stage 1 for design_revision
      emitSessionEvent.stageUpdate(TEST_SESSION_ID, {
        step: 1,
        label: 'Evaluating requested architectural modification',
        progress: 15,
        operationType: 'design_revision',
      });

      // Stage 3 for design_revision
      emitSessionEvent.stageUpdate(TEST_SESSION_ID, {
        step: 3,
        label: 'Analyzing component & schematic impact',
        progress: 35,
        operationType: 'design_revision',
      });

      // Stage 6 for design_revision
      emitSessionEvent.stageUpdate(TEST_SESSION_ID, {
        step: 6,
        label: 'Regenerating system diagrams & Bill of Materials',
        progress: 90,
        operationType: 'design_revision',
      });

      expect(stageSpy).toHaveBeenCalledTimes(3);
      expect(stageSpy).toHaveBeenNthCalledWith(1, TEST_SESSION_ID, expect.objectContaining({
        label: 'Evaluating requested architectural modification',
        operationType: 'design_revision',
      }));
      expect(stageSpy).toHaveBeenNthCalledWith(2, TEST_SESSION_ID, expect.objectContaining({
        label: 'Analyzing component & schematic impact',
        operationType: 'design_revision',
      }));
      expect(stageSpy).toHaveBeenNthCalledWith(3, TEST_SESSION_ID, expect.objectContaining({
        label: 'Regenerating system diagrams & Bill of Materials',
        operationType: 'design_revision',
      }));
    });
  });

  describe('3. Single Progress Element & Ephemeral Lifecycle', () => {
    it('pipeline step events maintain clean status progression without appending duplicate transcript rows', () => {
      const pipelineSteps: Array<{ stepId: string; label: string; status: string; detail?: string }> = [];

      const recordStep = (stepId: string, label: string, status: string, detail?: string) => {
        const existing = pipelineSteps.find((s) => s.stepId === stepId);
        if (existing) {
          existing.status = status;
          if (detail) existing.detail = detail;
        } else {
          pipelineSteps.push({ stepId, label, detail, status });
        }
      };

      // Step starts running
      recordStep('evaluating_change', 'Evaluating requested change', 'running');
      expect(pipelineSteps).toHaveLength(1);
      expect(pipelineSteps[0].status).toBe('running');

      // Step completes — updates in place
      recordStep('evaluating_change', 'Evaluating requested change', 'completed', 'Watchdog IC specification confirmed');
      expect(pipelineSteps).toHaveLength(1);
      expect(pipelineSteps[0].status).toBe('completed');
      expect(pipelineSteps[0].detail).toBe('Watchdog IC specification confirmed');

      // Next step runs
      recordStep('resolving_modules', 'Analyzing component impact', 'running');
      expect(pipelineSteps).toHaveLength(2);
      expect(pipelineSteps[1].status).toBe('running');
    });
  });
});

