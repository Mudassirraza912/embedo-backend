import { describe, it, expect, beforeAll } from '@jest/globals';
import { assemblePrototype } from '../../src/modules/sessions/prototype/prototype-assembler.js';
import { upgradeWithEntities, boardsToUpgrade } from '../../src/modules/sessions/prototype/diagram-upgrade.js';
import { renderPrototypeSvg } from '../../src/modules/sessions/prototype/prototype-svg-exporter.js';
import { PrototypeArchitecture } from '../../src/modules/sessions/prototype/prototype.types.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { renderBenchArt } from '../../src/modules/hardware/bench-art.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

describe('old-format prototype diagrams are redrawn when served', () => {
  let entities: Map<string, LibraryEntity>;
  let current: PrototypeArchitecture;
  let legacy: PrototypeArchitecture;
  beforeAll(async () => {
    entities = new Map();
    for (const id of Object.values(FIXTURE_IDS)) entities.set(id, await loadFixtureEntity(id));
    current = assemblePrototype(
      {
        kind: 'prototype_composition',
        controller: { instanceId: 'mcu', hardwareEntityId: FIXTURE_IDS.pico },
        modules: [
          { instanceId: 'bme1', hardwareEntityId: FIXTURE_IDS.bme280, role: '', links: [{ interface: 'I2C' }] },
          { instanceId: 'gps1', hardwareEntityId: FIXTURE_IDS.gps, role: '', links: [{ interface: 'UART' }] },
        ],
        gaps: [],
      },
      entities,
      { allowProvisional: true, svgBasePath: '/api/v1/hardware/entities', projectName: 'Logger', understanding: '', notes: '' }
    );
    // What a payload saved before the bus layout looks like: no buses, library-art URLs, lane labels.
    const { buses: _b, legendCard: _l, layoutVersion: _v, ...oldDiagram } = current.moduleDiagram;
    legacy = {
      ...current,
      instances: current.instances.map((i) => ({ ...i, svg: { url: `/api/v1/hardware/entities/${i.hardwareEntityId}/svg`, hash: 'sha256:old', width: 300, height: 300 } })),
      moduleDiagram: { ...oldDiagram, labels: [{ text: 'GND', x: 1, y: 1, netId: 'n_gnd', color: '#fff' }], header: { title: 'Prototype Kit', summary: 'x' } },
    };
  });

  it('redraws the diagram with bench art and keeps everything else as saved', () => {
    expect(boardsToUpgrade(legacy)).toEqual(['HW-FX01', 'HW-FX03', 'HW-FX04']);
    const up = upgradeWithEntities(legacy, entities);
    expect(up.moduleDiagram.layoutVersion).toBe(2);
    expect(up.moduleDiagram.buses!.length).toBeGreaterThan(0);
    expect(up.moduleDiagram.labels).toEqual([]);
    expect(up.instances.every((i) => i.svg!.url.includes('/bench.svg'))).toBe(true);
    expect(up.moduleDiagram).toEqual(current.moduleDiagram);
    for (const key of ['nets', 'connections', 'gaps', 'compatibility', 'pinList', 'hardwareLibrary', 'stateHash', 'versionTag'] as const) {
      expect(up[key]).toEqual(legacy[key]);
    }
  });

  it('leaves current payloads, architect payloads and empty values untouched', () => {
    expect(upgradeWithEntities(current, entities)).toBe(current);
    const architect = { kind: 'architect', functionalBlock: {} };
    expect(upgradeWithEntities(architect, entities)).toBe(architect);
    expect(upgradeWithEntities(null, entities)).toBeNull();
    expect(boardsToUpgrade(current)).toEqual([]);
  });

  it('exports an old payload in the new style only', () => {
    const up = upgradeWithEntities(legacy, entities);
    const art = new Map(up.instances.map((i) => [i.instanceId, renderBenchArt(entities.get(i.hardwareEntityId)!.record, i.isController).svg]));
    const svg = renderPrototypeSvg(up, art);
    expect(svg).toContain('Prototype Mode');
    expect(svg).toContain('id="mcu-HW-FX01-feature"'); // bench art, nested per instance
    expect(svg).not.toContain('perimeter-v1');
    expect(svg).not.toContain('Prototype Kit');
  });
});
