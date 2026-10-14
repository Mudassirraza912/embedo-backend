import { describe, it, expect, beforeAll, afterEach, jest } from '@jest/globals';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { prisma } from '../../src/db/prisma.js';
import { hardwareLibraryService } from '../../src/modules/hardware/hardware-library.service.js';
import { benchKind, renderBenchArt } from '../../src/modules/hardware/bench-art.js';
import { assertSafeModuleSvg } from '../../src/modules/hardware/hardware-svg.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

describe('bench art (diagram drawing of a board, rendered from its record)', () => {
  let entities: LibraryEntity[];
  beforeAll(async () => {
    entities = await Promise.all(Object.values(FIXTURE_IDS).map((id) => loadFixtureEntity(id)));
  });

  it('places an anchor for every wireable contact of the record, using the record anchor ids', () => {
    for (const e of entities) {
      const art = renderBenchArt(e.record, e.isController);
      const expected = e.record.connectors.flatMap((c) =>
        c.connection_mode === 'whole_connector' ? [c.svg_anchor_id] : c.contacts.map((k) => k.svg_anchor_id)
      );
      expect([...art.anchors.keys()].sort()).toEqual(expected.filter(Boolean).sort());
      for (const a of art.anchors.values()) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.x).toBeLessThanOrEqual(art.width);
        expect(a.y).toBeLessThanOrEqual(art.height);
        expect(art.svg).toContain(`id="${a.id}"`);
      }
      // Each anchor sits on the edge its connector declares.
      for (const c of e.record.connectors) {
        const ids = c.connection_mode === 'whole_connector' ? [c.svg_anchor_id] : c.contacts.map((k) => k.svg_anchor_id);
        for (const id of ids.filter(Boolean)) expect(art.edges.get(id!)).toBe(c.position.svg_edge);
      }
    }
  });

  it('is safe to serve, deterministic, and picks a feature from what the board is', () => {
    const kinds = entities.map((e) => benchKind(e.record, e.isController));
    expect(kinds).toEqual(['mcu', 'mcu', 'sensor', 'gps', 'storage']);
    for (const e of entities) {
      const a = renderBenchArt(e.record, e.isController);
      expect(() => assertSafeModuleSvg(a.svg)).not.toThrow();
      expect(renderBenchArt(e.record, e.isController).hash).toBe(a.hash);
    }
  });

  it('only draws a USB socket when the record lists USB power', () => {
    const pico = entities.find((e) => e.hardwareEntityId === FIXTURE_IDS.pico)!;
    const gps = entities.find((e) => e.hardwareEntityId === FIXTURE_IDS.gps)!;
    expect(renderBenchArt(pico.record, true).svg).toContain('>USB</text>');
    expect(renderBenchArt(gps.record).svg).not.toMatch(/USB/);
  });
});

describe('GET /hardware/entities/:id/bench.svg', () => {
  const app = createApp();
  afterEach(() => jest.restoreAllMocks());

  it('serves the bench art of a shared board with an ETag, and 304 on a match', async () => {
    const pico = await loadFixtureEntity(FIXTURE_IDS.pico);
    jest.spyOn(hardwareLibraryService, 'getOne').mockResolvedValue({ ...pico, scope: 'shared_library' });
    const res = await request(app).get('/api/v1/hardware/entities/HW-FX01/bench.svg?controller=1');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    const body = res.text || Buffer.from(res.body as Buffer).toString('utf8');
    expect(body).toContain('data-embedo-svg="bench-');
    expect(body).toContain('Raspberry Pi Pico');
    const again = await request(app).get('/api/v1/hardware/entities/HW-FX01/bench.svg?controller=1').set('If-None-Match', res.headers['etag'] as string);
    expect(again.status).toBe(304);
    expect((await request(app).get('/api/v1/hardware/entities/HW-FX01/bench.svg?controller=yes')).status).toBe(400);
  });

  it('hides another project\'s private board', async () => {
    const pico = await loadFixtureEntity(FIXTURE_IDS.pico);
    jest.spyOn(hardwareLibraryService, 'getOne').mockResolvedValue({ ...pico, scope: 'private_project', projectId: 'p1' });
    jest.spyOn(prisma.designSession, 'findUnique').mockResolvedValue({ userId: 'someone-else', anonSessionToken: null, deletedAt: null } as never);
    expect((await request(app).get('/api/v1/hardware/entities/HW-FX01/bench.svg')).status).toBe(404);
  });
});
