import { describe, it, expect, beforeAll } from '@jest/globals';
import { assemblePrototype, AssembleOptions } from '../../src/modules/sessions/prototype/prototype-assembler.js';
import { renderPrototypeSvg } from '../../src/modules/sessions/prototype/prototype-svg-exporter.js';
import { PrototypeComposition } from '../../src/modules/sessions/prototype/prototype.types.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
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
    allowProvisional: true,
    svgBasePath: '/api/v1/hardware/entities',
    projectName: 'GPS Weather Logger',
    understanding: 'Pico logs BME280 and GPS readings to microSD',
    notes: '',
  };

  it('produces all three sections from the same composition', () => {
    const p = assemblePrototype(composition, entities, options);
    expect(p.kind).toBe('prototype');
    expect(p.instances.map((i) => i.instanceId)).toEqual(['mcu', 'bme1', 'gps1', 'sd1']);
    expect(p.instances[0]!.svg?.url).toBe('/api/v1/hardware/entities/HW-FX01/svg');
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
    // Provisional fixtures: connected rows are proposed (awaiting review), never asserted as assigned.
    expect(p.pinList.summary.assigned).toBe(0);
    expect(p.pinList.summary.proposed).toBeGreaterThan(0);
    expect(p.pinList.summary.blocking).toBe(0);
    const sda = p.pinList.rows.find((r) => r.instanceId === 'bme1' && r.pin === 'SDI' && r.contact === 'JP1:6')!;
    expect(sda).toMatchObject({ boardPin: 'GP4', net: 'I2C0_SDA', function: 'I2C SDA', status: 'proposed' });
    // A BME280 wired over I2C does not need its SPI-only CS pin.
    expect(p.pinList.rows.find((r) => r.instanceId === 'bme1' && r.pin === 'CS')!.status).toBe('optional');
  });

  it('starts and ends every wire exactly on a module anchor, with orthogonal segments', () => {
    const p = assemblePrototype(composition, entities, options);
    const placed = new Map(p.moduleDiagram.modules.map((m) => [m.instanceId, m]));
    const entityOf = (instanceId: string) => entities.get(p.instances.find((i) => i.instanceId === instanceId)!.hardwareEntityId)!;
    expect(p.moduleDiagram.wires.length).toBe(p.connections.length);
    for (const wire of p.moduleDiagram.wires) {
      const connection = p.connections.find((c) => c.id === wire.connectionId)!;
      const at = (end: typeof connection.from) => {
        const box = placed.get(end.instanceId)!;
        const anchor = entityOf(end.instanceId).svg!.parsed.anchors.get(end.anchorId)!;
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
      expect(wire.dashed).toBe(true); // provisional boards: shown, not asserted
    }
  });

  it('hides unreviewed wiring outside the dev override, and is deterministic', () => {
    const production = assemblePrototype(composition, entities, { ...options, allowProvisional: false });
    expect(production.moduleDiagram.wires).toHaveLength(0);
    expect(production.connections.every((c) => c.state === 'proposed')).toBe(true);
    expect(assemblePrototype(composition, entities, options).stateHash).toBe(assemblePrototype(composition, entities, options).stateHash);
  });

  it('draws reviewed, wiring-ready boards solid', () => {
    const reviewed = new Map(
      [...entities].map(([id, e]) => [id, { ...e, reviewStatus: 'confirmed', assetReadiness: 'wiring_ready' as const }])
    );
    const p = assemblePrototype(composition, reviewed, { ...options, allowProvisional: false });
    expect(p.connections.every((c) => c.state === 'drawn')).toBe(true);
    expect(p.moduleDiagram.wires.every((w) => !w.dashed)).toBe(true);
    expect(p.pinList.summary.assigned).toBeGreaterThan(0);
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
    const artwork = new Map([...entities.values()].map((e) => [e.hardwareEntityId, e.svg!.markup]));
    const svg = renderPrototypeSvg(p, artwork);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('id="bme1-a-HW-FX03-JP1-1"');
    expect(svg).toContain('id="bme2-a-HW-FX03-JP1-1"');
    expect(svg).not.toMatch(/<script/i);
  });
});
