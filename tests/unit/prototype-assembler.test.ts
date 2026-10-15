import { describe, it, expect, beforeAll } from '@jest/globals';
import { assemblePrototype, AssembleOptions } from '../../src/modules/sessions/prototype/prototype-assembler.js';
import { renderPrototypeSvg } from '../../src/modules/sessions/prototype/prototype-svg-exporter.js';
import { PrototypeComposition } from '../../src/modules/sessions/prototype/prototype.types.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { renderBenchArt } from '../../src/modules/hardware/bench-art.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

describe('prototype payload: module diagram, pin list and hardware library', () => {
  let entities: Map<string, LibraryEntity>;
  beforeAll(async () => {
    entities = new Map();
    for (const id of Object.values(FIXTURE_IDS)) entities.set(id, await loadFixtureEntity(id));
  });

  const composition: PrototypeComposition = {
    kind: 'prototype_composition',
    controller: { instanceId: 'mcu', hardwareEntityId: FIXTURE_IDS.pico },
    modules: [
      { instanceId: 'bme1', hardwareEntityId: FIXTURE_IDS.bme280, role: 'environment', links: [{ interface: 'I2C' }] },
      { instanceId: 'gps1', hardwareEntityId: FIXTURE_IDS.gps, role: 'position', links: [{ interface: 'UART' }] },
      { instanceId: 'sd1', hardwareEntityId: FIXTURE_IDS.microSd, role: 'logging', links: [{ interface: 'SPI' }] },
    ],
    gaps: [{ category: 'Display/UI', need: 'show readings', suggestion: 'SSD1306 OLED (I2C)' }],
  };
  const options: AssembleOptions = {
    svgBasePath: '/api/v1/hardware/entities',
    projectName: 'GPS Weather Logger',
    understanding: 'Pico logs BME280 and GPS readings to microSD',
    notes: '',
  };

  it('produces all three sections from the same composition', () => {
    const p = assemblePrototype(composition, entities, options);
    expect(p.kind).toBe('prototype');
    expect(p.instances.map((i) => i.instanceId)).toEqual(['mcu', 'bme1', 'gps1', 'sd1']);
    // The diagram draws bench art rendered from the record; the library entry keeps the library asset.
    expect(p.instances[0]!.svg?.url).toBe('/api/v1/hardware/entities/HW-FX01/bench.svg?controller=1');
    expect(p.hardwareLibrary.entries[0]!.svg?.url).toBe('/api/v1/hardware/entities/HW-FX01/svg');
    expect(p.moduleDiagram.modules).toHaveLength(4);
    expect(p.moduleDiagram.gapBoxes).toHaveLength(1);
    expect(p.hardwareLibrary.entries.map((e) => e.hardwareEntityId)).toEqual(['HW-FX01', 'HW-FX03', 'HW-FX04', 'HW-FX05']);
    expect(p.gaps[0]).toMatchObject({ gapId: 'g1', category: 'Display/UI' });
  });

  it('lists every contact of every placed module, wired or not', () => {
    const p = assemblePrototype(composition, entities, options);
    const contacts = ['HW-FX01', 'HW-FX03', 'HW-FX04', 'HW-FX05']
      .map((id) => entities.get(id)!.record.connectors.reduce((n, c) => n + c.contacts.length, 0))
      .reduce((a, b) => a + b, 0);
    expect(p.pinList.rows).toHaveLength(contacts);
    expect(p.pinList.summary.rows).toBe(contacts);
    // Review status is internal: connected rows of provisional fixtures are plain "assigned".
    expect(p.pinList.summary.assigned).toBeGreaterThan(0);
    expect(p.pinList.summary.proposed).toBe(0);
    expect(p.pinList.summary.blocking).toBe(0);
    const sda = p.pinList.rows.find((r) => r.instanceId === 'bme1' && r.pin === 'SDI' && r.contact === 'JP1:6')!;
    expect(sda).toMatchObject({ boardPin: 'GP4', net: 'I2C0_SDA', function: 'I2C SDA', status: 'assigned' });
    // A BME280 wired over I2C does not need its SPI-only CS pin.
    expect(p.pinList.rows.find((r) => r.instanceId === 'bme1' && r.pin === 'CS')!.status).toBe('optional');
  });

  it('starts and ends every wire exactly on a module anchor, with orthogonal segments', () => {
    const p = assemblePrototype(composition, entities, options);
    const placed = new Map(p.moduleDiagram.modules.map((m) => [m.instanceId, m]));
    const instanceOf = (instanceId: string) => p.instances.find((i) => i.instanceId === instanceId)!;
    const artOf = (instanceId: string) => renderBenchArt(entities.get(instanceOf(instanceId).hardwareEntityId)!.record, instanceOf(instanceId).isController);
    expect(p.moduleDiagram.wires.length).toBe(p.connections.length);
    for (const wire of p.moduleDiagram.wires) {
      const connection = p.connections.find((c) => c.id === wire.connectionId)!;
      const at = (end: typeof connection.from) => {
        const box = placed.get(end.instanceId)!;
        const anchor = artOf(end.instanceId).anchors.get(end.anchorId)!;
        return [Math.round((box.x + anchor.x) * 10) / 10, Math.round((box.y + anchor.y) * 10) / 10];
      };
      const ends = [wire.points[0], wire.points[wire.points.length - 1]];
      expect(ends).toContainEqual(at(connection.from));
      expect(ends).toContainEqual(at(connection.to));
      for (let i = 1; i < wire.points.length; i++) {
        const [a, b] = [wire.points[i - 1]!, wire.points[i]!];
        expect(a[0] === b[0] || a[1] === b[1]).toBe(true);
      }
      for (const [x, y] of wire.points) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(p.moduleDiagram.width);
        expect(y).toBeLessThanOrEqual(p.moduleDiagram.height);
      }
      expect(wire.dashed).toBe(false); // review status never changes the drawing
    }
  });

  it('lays nets out as labelled backbone tracks that every board taps', () => {
    const p = assemblePrototype(composition, entities, options);
    const d = p.moduleDiagram;
    expect(d.layoutVersion).toBe(3);
    const wiredNets = new Set(p.connections.filter((c) => c.kind === 'wire').flatMap((c) => c.netIds));
    expect(new Set(d.buses!.map((b) => b.netId))).toEqual(wiredNets);
    // Power first, then ground; one distinct y per track.
    expect(d.buses![0]!.netClass).toBe('power');
    expect(new Set(d.buses!.map((b) => b.y)).size).toBe(d.buses!.length);
    const gnd = d.buses!.find((b) => b.label === 'GND')!;
    expect(gnd.taps.map((t) => t.instanceId).sort()).toEqual(['bme1', 'gps1', 'mcu', 'sd1']);
    expect(gnd.shared).toBe(true);
    for (const b of d.buses!) {
      for (const t of b.taps) {
        expect(t.points[t.points.length - 1]).toEqual([t.x, b.y]);
        expect(t.x).toBeGreaterThanOrEqual(b.x1);
        expect(t.x).toBeLessThanOrEqual(b.x2);
      }
    }
    // No two boards overlap.
    const boxes = d.modules.map((m) => m.content!);
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, b] = [boxes[i]!, boxes[j]!];
        expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
      }
    expect(d.legendCard?.rows.length).toBeGreaterThan(0);
    expect(d.header.title).toBe('Prototype Mode');
  });

  it('never shows library review status: reviewed and unreviewed boards draw the same, and it is deterministic', () => {
    const reviewed = new Map(
      [...entities].map(([id, e]) => [id, { ...e, reviewStatus: 'confirmed', assetReadiness: 'wiring_ready' as const }])
    );
    const unreviewed = assemblePrototype(composition, entities, options);
    const p = assemblePrototype(composition, reviewed, options);
    expect(unreviewed.connections.map((c) => c.state)).toEqual(p.connections.map((c) => c.state));
    expect(unreviewed.connections.every((c) => c.state === 'drawn')).toBe(true);
    expect(unreviewed.moduleDiagram.wires.every((w) => !w.dashed)).toBe(true);
    expect(unreviewed.moduleDiagram.modules.every((m) => m.badge === null)).toBe(true);
    expect(unreviewed.moduleDiagram.legendCard?.dashedNote).toBe(false);
    expect(assemblePrototype(composition, entities, options).stateHash).toBe(assemblePrototype(composition, entities, options).stateHash);
  });

  it('marks an I2C address clash as a conflict on the pin rows and blocks those links', () => {
    const p = assemblePrototype(
      {
        kind: 'prototype_composition',
        controller: { instanceId: 'mcu', hardwareEntityId: FIXTURE_IDS.qtPy },
        modules: [
          { instanceId: 'bme1', hardwareEntityId: FIXTURE_IDS.bme280, role: '', links: [{ interface: 'I2C' }] },
          { instanceId: 'bme2', hardwareEntityId: FIXTURE_IDS.bme280, role: '', links: [{ interface: 'I2C' }] },
        ],
        gaps: [],
      },
      entities,
      options
    );
    expect(p.compatibility.counts.BLOCKER).toBe(1);
    expect(p.pinList.summary.conflict).toBeGreaterThan(0);
    expect(p.connections.every((c) => c.state === 'blocked')).toBe(true);
  });

  it('exports a standalone SVG with per-instance id prefixes', () => {
    const p = assemblePrototype(
      { ...composition, modules: [...composition.modules, { instanceId: 'bme2', hardwareEntityId: FIXTURE_IDS.bme280, role: 'second', links: [] }] },
      entities,
      options
    );
    const artwork = new Map(p.instances.map((i) => [i.instanceId, renderBenchArt(entities.get(i.hardwareEntityId)!.record, i.isController).svg]));
    const svg = renderPrototypeSvg(p, artwork);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('id="bme1-a-HW-FX03-JP1-1"');
    expect(svg).toContain('id="bme2-a-HW-FX03-JP1-1"');
    expect(svg).toContain('Prototype Mode');
    expect(svg).toContain('>GND</text>');
    expect(svg).not.toMatch(/<script/i);
  });
});
