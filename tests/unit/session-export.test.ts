import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { prisma } from '../../src/db/prisma.js';
import { redis } from '../../src/db/redis.js';
import { hardwareLibraryService, LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { ProjectedArchitecture } from '../../src/modules/sessions/pipeline/types.js';
import { assemblePrototype } from '../../src/modules/sessions/prototype/prototype-assembler.js';
import { PrototypeArchitecture, PrototypeComposition } from '../../src/modules/sessions/prototype/prototype.types.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'owner-1';
const app = createApp();

const architectDiagram = (title: string): ProjectedArchitecture['functionalBlock'] => ({
  title,
  figure: title,
  caption: 'Saved diagram',
  width: 900,
  height: 240,
  nodes: [
    { id: 'controller', x: 80, y: 50, w: 180, h: 80, label: 'ESP32 Controller', sublabel: 'ESP32-S3', category: 'control' },
    { id: 'sensor', x: 460, y: 50, w: 180, h: 80, label: 'Temperature Sensor', sublabel: 'BME280', category: 'sensing' },
  ],
  edges: [{ from: 'controller', to: 'sensor', label: 'I2C', type: 'i2c' }],
  legend: [{ color: '#DDF3F2', label: 'Controller' }],
});

const architect: ProjectedArchitecture = {
  projectMeta: { name: 'Saved Architect Design', tagline: 'A complete saved design', controller: 'ESP32-S3' },
  summary: {
    mcu: 'ESP32-S3',
    powerInput: 'USB-C',
    outputs: 'None',
    interfaces: 'I2C',
    inputs: 'Temperature',
    estimatedBomCostUsd: 12,
  },
  functionalBlock: architectDiagram('Functional Block Diagram'),
  powerTree: architectDiagram('Power Tree'),
  protocolMap: architectDiagram('Protocol / Interface Map'),
  bom: [],
};

const entities = new Map<string, LibraryEntity>();
let prototype: PrototypeArchitecture;

const ownerToken = (userId = OWNER_ID) =>
  jwt.sign({ userId, email: `${userId}@example.com`, role: 'user' }, env.JWT_ACCESS_SECRET);

const savedSession = (architecture: unknown, userId: string | null = OWNER_ID) => ({
  id: SESSION_ID,
  userId,
  anonSessionToken: null,
  intentText: 'Saved diagram export test',
  intentStructured: null,
  designGraph: {},
  domain: null,
  applicationContext: null,
  architecture,
  parentSessionId: null,
  status: 'DONE',
  consentAtCreation: true,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  chatMessages: [],
  userFeedback: [],
  designOutcome: null,
});

const expectValidSvgFrame = (svg: string): { width: number; height: number; viewBox: string } => {
  expect(svg).toMatch(/^<\?xml|^<svg\b/);
  expect(svg.match(/<svg\b/g)?.length).toBe(svg.match(/<\/svg>/g)?.length);
  const root = /<svg\b([^>]*)>/.exec(svg)?.[1];
  expect(root).toBeDefined();
  const width = Number(/\bwidth="([^"]+)"/.exec(root!)?.[1]);
  const height = Number(/\bheight="([^"]+)"/.exec(root!)?.[1]);
  const viewBox = /\bviewBox="([^"]+)"/.exec(root!)?.[1] ?? '';
  expect(Number.isFinite(width) && width > 0).toBe(true);
  expect(Number.isFinite(height) && height > 0).toBe(true);
  expect(viewBox).toBe(`0 0 ${width} ${height}`);
  return { width, height, viewBox };
};

beforeAll(async () => {
  for (const id of [FIXTURE_IDS.pico, FIXTURE_IDS.bme280]) entities.set(id, await loadFixtureEntity(id));
  const composition: PrototypeComposition = {
    kind: 'prototype_composition',
    controller: { instanceId: 'mcu', hardwareEntityId: FIXTURE_IDS.pico },
    modules: [{ instanceId: 'sensor', hardwareEntityId: FIXTURE_IDS.bme280, role: 'temperature sensor', links: [{ interface: 'I2C' }] }],
    gaps: [],
  };
  prototype = assemblePrototype(composition, entities, {
    svgBasePath: '/api/v1/hardware/entities',
    projectName: 'Saved Prototype Design',
    understanding: 'Pico reads temperature from BME280',
    notes: '',
  });
});

describe('saved diagram SVG download', () => {
  afterEach(() => jest.restoreAllMocks());

  const authenticateOwner = (userId = OWNER_ID) => {
    jest.spyOn(prisma.user, 'findFirst').mockResolvedValue({
      id: userId,
      email: `${userId}@example.com`,
      role: 'user',
      suspendedAt: null,
    } as never);
    jest.spyOn(redis, 'get').mockResolvedValue(null);
  };

  const mockSavedSession = (architecture: unknown, userId: string | null = OWNER_ID) => {
    jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValueOnce(savedSession(architecture, userId) as never);
    jest.spyOn(prisma.designOutcome, 'upsert').mockResolvedValue({} as never);
  };

  it('returns the complete, framed saved Architect diagram as standalone SVG', async () => {
    authenticateOwner();
    mockSavedSession(architect);

    const response = await request(app)
      .get(`/api/v1/sessions/${SESSION_ID}/export/download?format=svg`)
      .set('Authorization', `Bearer ${ownerToken()}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/svg+xml');
    expect(response.headers['content-disposition']).toContain('.svg');
    const svg = response.text ?? response.body.toString('utf8');
    const { width, height } = expectValidSvgFrame(svg);
    expect(width).toBe(1000);
    expect(height).toBeGreaterThan(architect.functionalBlock.height);
    expect(svg).toContain('Saved Architect Design');
    expect(svg).toContain('Functional Block Diagram');
    expect(svg).toContain('Power Tree');
    expect(svg).toContain('Protocol / Interface Map');
    expect(svg).toContain('ESP32 Controller');
    expect(svg).toContain('Temperature Sensor');
  });

  it('returns the current saved Prototype diagram with its nested board artwork and frame', async () => {
    authenticateOwner();
    mockSavedSession(prototype);
    jest.spyOn(hardwareLibraryService, 'getByIds').mockResolvedValue(entities);

    const response = await request(app)
      .get(`/api/v1/sessions/${SESSION_ID}/export/download?format=svg`)
      .set('Authorization', `Bearer ${ownerToken()}`);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('image/svg+xml');
    const svg = response.text ?? response.body.toString('utf8');
    const { width, height } = expectValidSvgFrame(svg);
    expect(width).toBe(prototype.moduleDiagram.width);
    expect(height).toBe(prototype.moduleDiagram.height);
    expect(svg).toContain('Prototype Mode');
    expect(svg).toContain('Saved Prototype Design');
    expect(svg).toContain('id="mcu-HW-FX01-feature"');
    expect(svg).toContain('id="sensor-HW-FX03-feature"');
    expect(svg).toContain('GND');
  });

  it('requires a signed-in user even when a guest session token is supplied', async () => {
    const response = await request(app)
      .get(`/api/v1/sessions/${SESSION_ID}/export/download?format=svg`)
      .set('x-anon-session-token', 'valid-guest-token');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(response.body.error.message).toMatch(/authentication required/i);
  });

  it('forbids a signed-in user from exporting another user’s saved project', async () => {
    authenticateOwner('other-user');
    jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValueOnce(savedSession(architect, OWNER_ID) as never);

    const response = await request(app)
      .get(`/api/v1/sessions/${SESSION_ID}/export/download?format=svg`)
      .set('Authorization', `Bearer ${ownerToken('other-user')}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(response.body.error.message).toMatch(/permission to access/i);
  });

  it('returns a clear unsupported-format response', async () => {
    authenticateOwner();
    mockSavedSession(architect);

    const response = await request(app)
      .get(`/api/v1/sessions/${SESSION_ID}/export/download?format=png`)
      .set('Authorization', `Bearer ${ownerToken()}`);

    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe('EXPORT_FORMAT_UNSUPPORTED');
    expect(response.body.error.message).toContain('Supported formats: json, svg.');
  });
});
