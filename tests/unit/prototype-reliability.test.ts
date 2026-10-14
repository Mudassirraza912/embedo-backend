import { describe, it, expect, jest, afterEach } from '@jest/globals';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { authService } from '../../src/modules/auth/auth.service.js';
import { sessionsService } from '../../src/modules/sessions/sessions.service.js';
import { AppError } from '../../src/common/errors/AppError.js';
import { aiRouterService } from '../../src/modules/ai/ai-router.service.js';
import { routeMessage } from '../../src/modules/sessions/conversation-router.service.js';
import { describeBench, diffBenches } from '../../src/modules/sessions/prototype/prototype-diff.js';
import { stripPowerLinks, ResolverOutput } from '../../src/modules/sessions/prototype/prototype-resolver.js';
import { renderBenchArt } from '../../src/modules/hardware/bench-art.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

/**
 * Prototype reliability (session "Asset Tracker with GNSS LTE-M", 2026-10-13): expired-token
 * refresh, sign-in vs permission errors, corrections routed to the pipeline, and version summaries
 * that come from the graph rather than the request text.
 */

const aiResult = (content: string) => ({
  content,
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 0,
  latencyMs: 10,
  costUsd: 0,
  schemaPass: true,
  provider: 'openai',
  model: 'gpt-4o-mini',
  aiCallId: 'call-1',
});

const refreshRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'rt1',
  userId: 'u1',
  tokenHash: 'h',
  expiresAt: new Date(Date.now() + 86_400_000),
  revokedAt: null as Date | null,
  replacedById: null as string | null,
  createdAt: new Date(),
  user: { id: 'u1', email: 'a@embedo.ai', role: 'user', deletedAt: null, suspendedAt: null },
  ...overrides,
});

describe('auth: an expired access token never blocks the refresh', () => {
  const app = createApp();
  afterEach(() => jest.restoreAllMocks());

  it('POST /auth/refresh ignores a stale Bearer token and reads the refresh cookie', async () => {
    const expired = jwt.sign({ userId: 'u1', email: 'a@embedo.ai', role: 'user' }, process.env.JWT_ACCESS_SECRET!, { expiresIn: -10 });
    const refresh = jest.spyOn(authService, 'refresh').mockResolvedValue({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    const res = await request(app).post('/api/v1/auth/refresh').set('Authorization', `Bearer ${expired}`).set('Cookie', 'refreshToken=raw-cookie').send({});
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBe('new-access');
    expect(refresh).toHaveBeenCalledWith('raw-cookie');
  });

  it('other routes still reject an expired token with 401 and say why', async () => {
    const expired = jwt.sign({ userId: 'u1', email: 'a@embedo.ai', role: 'user' }, process.env.JWT_ACCESS_SECRET!, { expiresIn: -10 });
    const res = await request(app).get('/api/v1/users/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.details.reason).toBe('token_expired');
    const bad = await request(app).get('/api/v1/users/me').set('Authorization', 'Bearer not.a.jwt');
    expect(bad.status).toBe(401);
    expect(bad.body.error.details.reason).toBe('token_invalid');
  });

  it('a second tab refreshing with a just-rotated token gets a fresh pair instead of a sign-out', async () => {
    jest.spyOn(prisma.refreshToken, 'findFirst').mockResolvedValue(refreshRow({ revokedAt: new Date(Date.now() - 2_000), replacedById: 'rt2' }) as never);
    const revokeAll = jest.spyOn(prisma.refreshToken, 'updateMany').mockResolvedValue({ count: 3 });
    const create = jest.spyOn(prisma.refreshToken, 'create').mockResolvedValue({} as never);
    const pair = await authService.refresh('raw');
    expect(pair.accessToken).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(1);
    expect(revokeAll).not.toHaveBeenCalled();
  });

  it('reuse of a token rotated long ago is still treated as theft', async () => {
    jest.spyOn(prisma.refreshToken, 'findFirst').mockResolvedValue(refreshRow({ revokedAt: new Date(Date.now() - 10 * 60_000), replacedById: 'rt2' }) as never);
    const revokeAll = jest.spyOn(prisma.refreshToken, 'updateMany').mockResolvedValue({ count: 3 });
    await expect(authService.refresh('raw')).rejects.toMatchObject({ statusCode: 401 });
    expect(revokeAll).toHaveBeenCalledTimes(1);
  });
});

describe('sessions: a missing sign-in is 401, another account is 403', () => {
  const owned = { userId: 'user-123', anonSessionToken: null };
  const thrown = (fn: () => void): AppError => {
    try {
      fn();
    } catch (err) {
      return err as AppError;
    }
    throw new Error('expected a throw');
  };

  it('no signed-in user on a user-owned project → 401 sign_in_required', () => {
    const err = thrown(() => sessionsService.verifySessionOwnership(owned, undefined, 'some-guest-token'));
    expect(err.statusCode).toBe(401);
    expect(err.details).toMatchObject({ reason: 'sign_in_required' });
  });

  it('a different signed-in user → 403 FORBIDDEN (access control unchanged)', () => {
    const err = thrown(() => sessionsService.verifySessionOwnership(owned, 'user-456'));
    expect(err.statusCode).toBe(403);
    expect(err.code).toBe('FORBIDDEN');
  });
});

describe('router: prototype corrections change the bench', () => {
  afterEach(() => jest.restoreAllMocks());
  const history = [
    { role: 'user' as const, content: 'Asset tracker with GNSS, LTE-M, accelerometer and long-life battery operation.' },
    { role: 'assistant' as const, content: 'Prototype bench assembled (v1.0)' },
  ];
  const discussVerdict = aiResult(JSON.stringify({ mode: 'discuss', projectTitle: '', isGibberish: false, isNewProject: false, reply: '', isAnswerToPendingQuestion: false }));

  it.each([
    'There should be some 5V to 3.3V module then it power up all modules! \n\nTaking power from nrf9160 is wrong!',
    "But in your modules dig I can't see! Make changes please!",
    'power the sensors from the regulator',
  ])('"%s" → generate', async (message) => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(discussVerdict);
    const result = await routeMessage(message, 's1', history, { projectTitle: 'Asset Tracker', originalBrief: history[0]!.content }, 'prototype');
    expect(result.mode).toBe('generate');
  });

  it.each(['I think its wrong!', '5V line is not connected with Vin? why?', 'why using Adafruit Power Boost?'])('"%s" stays a discussion', async (message) => {
    jest.spyOn(aiRouterService, 'executeTask').mockResolvedValue(discussVerdict);
    const result = await routeMessage(message, 's1', history, { projectTitle: 'Asset Tracker', originalBrief: history[0]!.content }, 'prototype');
    expect(result.mode).toBe('discuss');
  });

  it('"yes" after an offer to rewire applies it', async () => {
    const offered = [...history, { role: 'assistant' as const, content: 'The PowerBoost 5V is not wired to VIN. Want me to rewire it so the regulator powers the modules?' }];
    const result = await routeMessage('yes', 's1', offered, undefined, 'prototype');
    expect(result.mode).toBe('generate');
  });
});

describe('bench description and diff', () => {
  const inst = (instanceId: string, label: string, hardwareEntityId = `HW-${instanceId}`) =>
    ({ instanceId, label, hardwareEntityId, isController: instanceId === 'mcu' }) as never;
  const net = (netId: string, name: string, cls: string, members: string[]) => ({
    netId,
    name,
    class: cls,
    members: members.map((m) => ({ instanceId: m.split('.')[0]!, pinName: m.split('.')[1]!, pinId: m, contactId: null, anchorId: null })),
  });
  const before = {
    instances: [inst('mcu', 'Feather'), inst('gps1', 'GPS'), inst('power1', 'PowerBoost'), inst('regulator1', 'Pololu')],
    nets: [net('n_3v3', '3V3', 'power', ['mcu.3V', 'gps1.VIN']), net('n_power1_5v', 'POWER1_5V', 'gpio', ['mcu.GPIO0', 'power1.5V'])],
    compatibility: { results: [], counts: { PASS: 0, WARNING: 0, BLOCKER: 0, UNKNOWN: 0 } },
  } as never;
  const after = {
    instances: [inst('mcu', 'Feather'), inst('gps1', 'GPS'), inst('power1', 'PowerBoost'), inst('regulator1', 'Pololu')],
    nets: [net('n_3v3', '3V3', 'power', ['regulator1.VOUT', 'mcu.VIN', 'gps1.VIN']), net('n_5v', '5V', 'power', ['power1.5V', 'regulator1.VIN'])],
    compatibility: { results: [], counts: { PASS: 0, WARNING: 0, BLOCKER: 0, UNKNOWN: 0 } },
  } as never;

  it('lists every net so replies can only describe real wiring', () => {
    const text = describeBench(before);
    expect(text).toContain('3V3 (power): mcu.3V, gps1.VIN');
    expect(text).toContain('POWER1_5V (gpio): mcu.GPIO0, power1.5V');
  });

  it('reports rewired nets from the graph', () => {
    const diff = diffBenches(before, after);
    expect(diff.changed).toBe(true);
    expect(diff.lines).toContain('Rewired 3V3: now regulator1.VOUT, mcu.VIN; no longer mcu.3V');
    expect(diff.lines.some((l) => l.startsWith('Rewired 5V (was POWER1_5V)') && l.includes('no longer mcu.GPIO0'))).toBe(true);
  });

  it('an identical bench is no change, whatever the request said', () => {
    expect(diffBenches(before, before)).toEqual({ lines: [], changed: false });
  });
});

describe('bench art: light palette for the light canvas', () => {
  it('changes colours only: same size and anchors, chips stay dark, board turns white', async () => {
    const bme = await loadFixtureEntity(FIXTURE_IDS.bme280);
    const dark = renderBenchArt(bme.record, false);
    const light = renderBenchArt(bme.record, false, 'light');
    expect(light.width).toBe(dark.width);
    expect(light.height).toBe(dark.height);
    expect([...light.anchors.entries()]).toEqual([...dark.anchors.entries()]);
    expect(light.hash).not.toBe(dark.hash);
    expect(light.svg).toContain('stop-color="#FFFFFF"');
    expect(dark.svg).not.toContain('stop-color="#FFFFFF"/>');
    // The default render (exports, old callers) is unchanged by a light render in between.
    expect(renderBenchArt(bme.record, false).svg).toBe(dark.svg);
  });
});

describe('resolver: power is never a signal link', () => {
  it('drops GPIO links that name power pins', async () => {
    const bme = await loadFixtureEntity(FIXTURE_IDS.bme280);
    const powerPin = bme.record.pins.find((p) => p.direction === 'power_in')!;
    const output = {
      modules: [{ instanceId: 'bme1', hardwareEntityId: bme.hardwareEntityId, role: '', links: [{ interface: 'I2C' }, { interface: 'GPIO', pinName: powerPin.pin_name }] }],
    } as unknown as ResolverOutput;
    expect(stripPowerLinks(output, new Map([[bme.hardwareEntityId, bme]]))).toBe(1);
    expect(output.modules[0]!.links).toEqual([{ interface: 'I2C' }]);
  });
});
