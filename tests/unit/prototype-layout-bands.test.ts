import { describe, it, expect, beforeAll } from '@jest/globals';
import { assemblePrototype } from '../../src/modules/sessions/prototype/prototype-assembler.js';
import { PrototypeArchitecture } from '../../src/modules/sessions/prototype/prototype.types.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

/** A big bench wraps into stacked bands instead of one very wide backbone. */
describe('prototype layout bands', () => {
  let entities: Map<string, LibraryEntity>;
  const build = (count: number): PrototypeArchitecture =>
    assemblePrototype(
      {
        kind: 'prototype_composition',
        controller: { instanceId: 'mcu', hardwareEntityId: FIXTURE_IDS.pico },
        modules: Array.from({ length: count }, (_, k) =>
          k % 3 === 2
            ? { instanceId: `sd${k}`, hardwareEntityId: FIXTURE_IDS.microSd, role: '', links: [{ interface: 'SPI' }] }
            : { instanceId: `bme${k}`, hardwareEntityId: FIXTURE_IDS.bme280, role: '', links: [{ interface: 'I2C' }] }
        ),
        gaps: [],
      },
      entities,
      { svgBasePath: '/api/v1/hardware/entities', projectName: 'Big bench', understanding: '', notes: '' }
    );
  beforeAll(async () => {
    entities = new Map();
    for (const id of Object.values(FIXTURE_IDS)) entities.set(id, await loadFixtureEntity(id));
  });

  it('keeps a small bench on one backbone', () => {
    const d = build(2).moduleDiagram;
    expect(d.layoutVersion).toBe(3);
    expect(d.bands).toBe(1);
  });

  it('wraps a large bench into bands that grow down as well as across', () => {
    const one = build(2).moduleDiagram;
    const d = build(12).moduleDiagram;
    expect(d.bands).toBeGreaterThan(1);
    expect(d.width / d.height).toBeLessThan(3);
    expect(d.height).toBeGreaterThan(one.height);
    // Every board is drawn, and boards never overlap.
    expect(d.modules).toHaveLength(13);
    const boxes = d.modules.map((m) => m.content!);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
        expect(overlap).toBe(false);
      }
    // A net with pads in several bands gets one track per band, same label and colour.
    const byNet = new Map<string, Array<{ label: string; color: string; y: number }>>();
    for (const b of d.buses!) if (b.netId) byNet.set(b.netId, [...(byNet.get(b.netId) ?? []), b]);
    const spanning = [...byNet.values()].filter((list) => list.length > 1);
    expect(spanning.length).toBeGreaterThan(0);
    for (const list of spanning) {
      expect(new Set(list.map((b) => b.label)).size).toBe(1);
      expect(new Set(list.map((b) => b.color)).size).toBe(1);
    }
    // Every tap's leg ends on its own track.
    for (const b of d.buses!) for (const t of b.taps) expect(t.points[t.points.length - 1]![1]).toBe(b.y);
    // Bus ids stay unique, and the legend has one row per net, not per band.
    expect(new Set(d.buses!.map((b) => b.busId)).size).toBe(d.buses!.length);
    const labels = d.legendCard!.rows.map((r) => r.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('draws every connection of the bench', () => {
    const a = build(12);
    const drawn = new Set(a.moduleDiagram.wires.map((w) => w.connectionId));
    for (const c of a.connections) expect(drawn.has(c.id)).toBe(true);
  });
});
