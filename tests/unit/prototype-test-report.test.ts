import { describe, it, expect, beforeAll } from '@jest/globals';
import { allocatePins } from '../../src/modules/sessions/prototype/prototype-allocator.js';
import { assemblePrototype } from '../../src/modules/sessions/prototype/prototype-assembler.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { prepareBundle } from '../../src/modules/hardware/hardware-admin.service.js';
import { factsToBoard, hasSpiPins, SourcedFacts } from '../../src/modules/hardware/discovery/hardware-sourcer.js';
import { buildRecord, buildSvg } from '../../src/modules/hardware/discovery/record-builder.js';
import { isControllerRecord } from '../../src/modules/hardware/hardware.schema.js';
import { parseModuleSvg } from '../../src/modules/hardware/hardware-svg.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

const pin = (name: string, signal_class: SourcedFacts['pins'][number]['signal_class'], direction: SourcedFacts['pins'][number]['direction'], functions: string[] = []) => ({
  name,
  signal_class,
  direction,
  voltage_domain: signal_class === 'power' ? '3V3' : null,
  functions,
});

async function entityFromFacts(facts: SourcedFacts, id: string): Promise<LibraryEntity> {
  const board = factsToBoard(facts, id, `FAM-${id}`, null);
  const { bundle, issues } = prepareBundle({ record: buildRecord(board), svg: buildSvg(board).svg });
  if (!bundle) throw new Error(issues.map((i) => i.message).join('; '));
  const base = await loadFixtureEntity(FIXTURE_IDS.bme280);
  return { ...base, hardwareEntityId: id, isController: isControllerRecord(bundle.record), record: bundle.record, svg: { hash: id, markup: bundle.svg, parsed: parseModuleSvg(bundle.svg) } };
}

/** A Feather-like controller record as AI sourcing produced it on prod: headers listed, SPI pins missing. */
const featherNoSpi: SourcedFacts = {
  product_name: 'Feather-like controller (no SPI in record)',
  vendor: 'Adafruit',
  vendor_sku: null,
  is_controller: true,
  functional_categories: ['Processing'],
  prototype_role: 'Main controller',
  main_silicon: 'nRF52840',
  secondary_ics: [],
  supply_voltage_min_v: 3.3,
  supply_voltage_max_v: 6,
  logic_level_summary: '3.3V',
  power_source_types: ['usb'],
  required_host_interfaces: [],
  host_requirement: 'standalone',
  pins: [
    pin('3V', 'power', 'power_out'),
    pin('GND', 'ground', 'ground'),
    pin('USB', 'power', 'power_in'),
    pin('SDA', 'data', 'bidirectional', ['I2C0_SDA']),
    pin('SCL', 'data', 'bidirectional', ['I2C0_SCL']),
    pin('D5', 'data', 'bidirectional', ['GPIO']),
    pin('D6', 'data', 'bidirectional', ['GPIO']),
    pin('D9', 'data', 'bidirectional', ['GPIO']),
  ],
  connectors: [{ ref: 'J1', kind: 'header', edge: 'left', pins: ['3V', 'GND', 'USB', 'SDA', 'SCL', 'D5', 'D6', 'D9'] }],
  interfaces: [{ type: 'I2C', role: 'controller', addresses: [], sda: 'SDA', scl: 'SCL' }],
  required_accessories: [],
  notes: [],
  facts_source: 'model_knowledge',
};

/**
 * Regressions from the 2026-10-15 Prototype test report and the dev runs that followed it.
 */
describe('prototype test report regressions', () => {
  let pico: LibraryEntity;
  let sd: LibraryEntity;
  beforeAll(async () => {
    pico = await loadFixtureEntity(FIXTURE_IDS.pico);
    sd = await loadFixtureEntity(FIXTURE_IDS.microSd);
  });

  it('wires an SPI chip select once, even when the resolver also lists it as a GPIO link', () => {
    const result = allocatePins({ instanceId: 'mcu', entity: pico, links: [] }, [
      { instanceId: 'sd1', entity: sd, links: [{ interface: 'SPI' }, { interface: 'GPIO', pinName: 'CS' }, { interface: 'GPIO', pinName: 'CD' }] },
    ]);
    const cs = result.nets.filter((n) => n.members.some((m) => m.instanceId === 'sd1' && m.pinName === 'CS'));
    expect(cs).toHaveLength(1);
    expect(cs[0]!.members.filter((m) => m.instanceId === 'mcu')).toHaveLength(1);
    // A pin no bus wires (card detect) still gets its GPIO line.
    const cd = result.nets.find((n) => n.members.some((m) => m.instanceId === 'sd1' && m.pinName === 'CD'));
    expect(cd?.members.filter((m) => m.instanceId === 'mcu')).toHaveLength(1);
    // No net anywhere has two controller signal pins on it.
    for (const net of result.nets.filter((n) => n.class !== 'power' && n.class !== 'ground')) {
      expect(net.members.filter((m) => m.instanceId === 'mcu').length).toBeLessThanOrEqual(1);
    }
  });

  it('says the controller record lacks SPI pins (Unverified) instead of "no free SPI bus" (Fail)', async () => {
    const mcu = await entityFromFacts(featherNoSpi, 'HWP-NOSPI001');
    expect(hasSpiPins(featherNoSpi)).toBe(false);
    const result = allocatePins({ instanceId: 'mcu', entity: mcu, links: [] }, [{ instanceId: 'sd1', entity: sd, links: [{ interface: 'SPI' }] }]);
    const spi = result.results.find((r) => r.ruleType === 'required_host_interface' && r.instanceIds.includes('sd1') && r.status !== 'PASS');
    expect(spi?.status).toBe('UNKNOWN');
    expect(spi?.message).toContain('lists no SPI pins');
    expect(result.results.some((r) => r.message.includes('has no free SPI bus'))).toBe(false);
    // With SPI pins in the record, the same bench wires over SPI.
    expect(hasSpiPins({ ...featherNoSpi, pins: [...featherNoSpi.pins, pin('SCK', 'data', 'output')] })).toBe(true);
  });

  it('reports a board wired to nothing, and the pin list does not call the bench fully connected', async () => {
    const antenna = await entityFromFacts(
      {
        ...featherNoSpi,
        product_name: 'Passive GPS antenna',
        is_controller: false,
        functional_categories: ['Connectivity'],
        prototype_role: 'Antenna',
        host_requirement: 'standalone',
        pins: [pin('ANT', 'other', 'bidirectional'), pin('SHLD', 'other', 'bidirectional')],
        connectors: [{ ref: 'J1', kind: 'other', edge: 'bottom', pins: ['ANT', 'SHLD'] }],
        interfaces: [],
      },
      'HWP-ANT00001'
    );
    const entities = new Map<string, LibraryEntity>([
      [pico.hardwareEntityId, pico],
      [antenna.hardwareEntityId, antenna],
    ]);
    const a = assemblePrototype(
      {
        kind: 'prototype_composition',
        controller: { instanceId: 'mcu', hardwareEntityId: pico.hardwareEntityId },
        modules: [{ instanceId: 'ant1', hardwareEntityId: antenna.hardwareEntityId, role: '', links: [] }],
        gaps: [],
      },
      entities,
      { svgBasePath: '/x', projectName: 'p', understanding: '', notes: '' }
    );
    expect(a.pinList.summary.unwiredModules).toEqual([{ instanceId: 'ant1', label: a.instances.find((i) => i.instanceId === 'ant1')!.label }]);
    const warn = a.compatibility.results.find((r) => r.instanceIds.includes('ant1') && r.message.includes('nothing is wired to it'));
    expect(warn?.status).toBe('WARNING');
    expect(a.compatibility.counts.WARNING).toBeGreaterThan(0);
  });
});
