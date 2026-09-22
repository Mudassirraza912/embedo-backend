import { describe, it, expect, jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';

describe('Sessions API Routes', () => {
  const app = createApp();
  const testSessionId = '11111111-1111-1111-1111-111111111111';
  const testAnonToken = 'test-anon-token-12345';

  it('should return 404 for non-existent session architecture', async () => {
    const findUniqueSpy = jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValueOnce(null);

    const fakeId = '00000000-0000-0000-0000-000000000000';
    const response = await request(app)
      .get(`/api/v1/sessions/${fakeId}/architecture`)
      .set('x-anon-session-token', testAnonToken);

    expect(response.status).toBe(404);
    expect(response.body).toHaveProperty('error');
    expect(response.body.error.code).toBe('SESSION_NOT_FOUND');

    findUniqueSpy.mockRestore();
  });

  it('should return architecture payload when session has generated architecture', async () => {
    const mockArch = {
      projectMeta: { name: 'Smart Access Control', tagline: 'ESP32-S3 terminal', controller: 'ESP32-S3' },
      summary: {
        mcu: 'ESP32-S3',
        powerInput: '9V – 24V DC Input',
        outputs: '4x SSR (Solid State Relays)',
        interfaces: 'RFID, BLE, Keypad, LCD',
        inputs: 'Tamper, User Inputs',
        estimatedBomCostUsd: 18.4,
      },
      functionalBlock: { title: 'Functional Block Diagram', nodes: [], edges: [], legend: [] },
      powerTree: { title: 'Power Tree', nodes: [], edges: [], legend: [] },
      protocolMap: { title: 'Protocol / Interface Map', nodes: [], edges: [], legend: [] },
      bom: [{ partNumber: 'ESP32-S3', manufacturer: 'Espressif', category: 'MCU', qty: 1 }],
    };

    const findUniqueSpy = jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValueOnce({
      id: testSessionId,
      userId: null,
      anonSessionToken: testAnonToken,
      intentText: 'Smart access control terminal with 4 SSR outputs',
      intentStructured: null,
      designGraph: null,
      domain: null,
      applicationContext: null,
      architecture: mockArch as any,
      parentSessionId: null,
      status: 'DONE',
      consentAtCreation: true,
      createdAt: new Date(),
      updatedAt: new Date(),
      chatMessages: [],
      userFeedback: [],
      designOutcome: null,
    } as any);

    const response = await request(app)
      .get(`/api/v1/sessions/${testSessionId}/architecture`)
      .set('x-anon-session-token', testAnonToken);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.architecture).toBeDefined();
    expect(response.body.data.architecture.projectMeta.name).toBe('Smart Access Control');
    expect(response.body.data.architecture.summary.mcu).toBe('ESP32-S3');
    expect(response.body.data.architecture.summary.estimatedBomCostUsd).toBe(18.4);

    findUniqueSpy.mockRestore();
  });

  it('should list all historical versions for a session', async () => {
    const findUniqueSpy = jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValueOnce({
      id: testSessionId,
      userId: null,
      anonSessionToken: testAnonToken,
      status: 'DONE',
    } as any);

    const findManyVersionsSpy = jest.spyOn(prisma.sessionVersion, 'findMany').mockResolvedValueOnce([
      {
        id: 'ver-2',
        versionNumber: 2,
        versionTag: 'v1.1',
        changeSummary: 'Added tamper detection and SSRs',
        appliedChanges: ['Added tamper detection'],
        createdAt: new Date(),
      },
      {
        id: 'ver-1',
        versionNumber: 1,
        versionTag: 'v1.0',
        changeSummary: 'Initial architecture generated',
        appliedChanges: ['Initial architecture generated'],
        createdAt: new Date(),
      },
    ] as any);

    const response = await request(app)
      .get(`/api/v1/sessions/${testSessionId}/versions`)
      .set('x-anon-session-token', testAnonToken);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.totalVersions).toBe(2);
    expect(response.body.data.currentVersionTag).toBe('v1.1');
    expect(response.body.data.versions).toHaveLength(2);

    findUniqueSpy.mockRestore();
    findManyVersionsSpy.mockRestore();
  });

  it('should retrieve a specific version snapshot (e.g. v1.0)', async () => {
    const findUniqueSpy = jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValueOnce({
      id: testSessionId,
      userId: null,
      anonSessionToken: testAnonToken,
      status: 'DONE',
    } as any);

    const findFirstVersionSpy = jest.spyOn(prisma.sessionVersion, 'findFirst').mockResolvedValueOnce({
      id: 'ver-1',
      sessionId: testSessionId,
      versionNumber: 1,
      versionTag: 'v1.0',
      changeSummary: 'Initial architecture generated',
      appliedChanges: ['Initial architecture generated'],
      architecture: { projectMeta: { name: 'V1 Architecture' } } as any,
      designGraph: {} as any,
      createdAt: new Date(),
    } as any);

    const response = await request(app)
      .get(`/api/v1/sessions/${testSessionId}/versions/v1.0`)
      .set('x-anon-session-token', testAnonToken);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.versionTag).toBe('v1.0');
    expect(response.body.data.changeSummary).toBe('Initial architecture generated');

    findUniqueSpy.mockRestore();
    findFirstVersionSpy.mockRestore();
  });
});
