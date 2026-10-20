import { describe, it, expect, beforeAll } from '@jest/globals';
import { allocatePins, AllocInstance } from '../../src/modules/sessions/prototype/prototype-allocator.js';
import { evaluateCompatibility } from '../../src/modules/sessions/prototype/prototype-checks.js';
import { isReservedForSignal } from '../../src/modules/sessions/prototype/prototype-board.js';
import { LibraryEntity } from '../../src/modules/hardware/hardware-library.service.js';
import { FIXTURE_IDS, loadFixtureEntity } from './prototype-fixtures.js';

/**
 * The allocator is the safety core of Prototype mode: the LLM only picks modules and interface
 * links, so every pin, contact and rail here must come from the library record.
 */
describe('prototype pin allocator (fixture library)', () => {
  const lib: Record<keyof typeof FIXTURE_IDS, LibraryEntity> = {} as never;
  beforeAll(async () => {
    for (const [key, id] of Object.entries(FIXTURE_IDS)) {
      lib[key as keyof typeof FIXTURE_IDS] = await loadFixtureEntity(id);
    }
  });

  const mcu = (entity: LibraryEntity): AllocInstance => ({ instanceId: 'mcu', entity, links: [] });
  const mod = (instanceId: string, entity: LibraryEntity, ...links: AllocInstance['links']): AllocInstance => ({ instanceId, entity, links });
  const netNamed = (nets: ReturnType<typeof allocatePins>['nets'], name: string) => nets.find((n) => n.name === name);

  it('uses a STEMMA QT cable when both ends have one, carrying GND, 3V3, SDA and SCL', () => {
    const result = allocatePins(mcu(lib.qtPy), [mod('bme1', lib.bme280, { interface: 'I2C' })]);

    const cables = result.connections.filter((c) => c.kind === 'cable');
    expect(cables).toHaveLength(1);
    expect(cables[0]!.from).toMatchObject({ instanceId: 'mcu', anchorId: 'a-HW-FX02-CONN1' });
    expect(cables[0]!.to.instanceId).toBe('bme1');
    expect(cables[0]!.netIds.sort()).toEqual(['n_3v3', 'n_gnd', 'n_i2c1_scl', 'n_i2c1_sda']);
    // The cable replaces jumpers: no wire is needed for the BME280.
    expect(result.connections.filter((c) => c.kind === 'wire' && (c.from.instanceId === 'bme1' || c.to.instanceId === 'bme1'))).toHaveLength(0);
    // The STEMMA port is I2C1 on the QT Py (SDA1/SCL1), not the header's I2C0 pins.
    expect(netNamed(result.nets, 'I2C1_SDA')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX02:SDA1', 'HW-FX03:SDI']);
    expect(result.linked.get('bme1')).toEqual(new Set(['I2C']));
  });

  it('daisy-chains a second STEMMA QT module from the first one', () => {
    const result = allocatePins(mcu(lib.qtPy), [mod('bme1', lib.bme280, { interface: 'I2C' }), mod('bme2', lib.bme280, { interface: 'I2C' })]);
    const cables = result.connections.filter((c) => c.kind === 'cable');
    expect(cables.map((c) => [c.from.instanceId, c.to.instanceId])).toEqual([
      ['mcu', 'bme1'],
      ['bme1', 'bme2'],
    ]);
  });

  it('wires header jumpers to the controller default I2C pins when the controller has no cable port', () => {
    const result = allocatePins(mcu(lib.pico), [mod('bme1', lib.bme280, { interface: 'I2C' })]);

    expect(result.connections.every((c) => c.kind === 'wire')).toBe(true);
    expect(netNamed(result.nets, 'I2C0_SDA')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:GP4', 'HW-FX03:SDI']);
    expect(netNamed(result.nets, 'I2C0_SCL')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:GP5', 'HW-FX03:SCK']);
    // 3.0-5.0 V module on a 3.3 V controller: the logic-level rail wins.
    expect(netNamed(result.nets, '3V3')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:3V3', 'HW-FX03:VIN']);
    expect(result.peripheralRails.get('bme1')).toBe(3.3);
    // Every wire lands on anchors that exist in the artwork.
    for (const wire of result.connections) {
      const ends = [wire.from, wire.to];
      for (const end of ends) {
        const entity = end.instanceId === 'mcu' ? lib.pico : lib.bme280;
        expect(entity.svg!.parsed.anchors.has(end.anchorId)).toBe(true);
      }
    }
  });

  it('crosses UART: controller TX to module RX and module TX to controller RX', () => {
    const result = allocatePins(mcu(lib.pico), [mod('gps1', lib.gps, { interface: 'UART' })]);
    expect(netNamed(result.nets, 'UART0_TX')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:GP0', 'HW-FX04:RX']);
    expect(netNamed(result.nets, 'UART0_RX')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:GP1', 'HW-FX04:TX']);
  });

  it("prefers the controller's labelled UART pins over any other TX/RX-capable pair", () => {
    const result = allocatePins(mcu(lib.qtPy), [mod('gps1', lib.gps, { interface: 'UART' })]);
    expect(netNamed(result.nets, 'UART1_TX')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX02:TX', 'HW-FX04:RX']);
    expect(netNamed(result.nets, 'UART1_RX')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX02:RX', 'HW-FX04:TX']);
  });

  it('shares SPI SCK/MOSI/MISO, gives the device its own chip select, and powers a 5 V-only module from VBUS', () => {
    const result = allocatePins(mcu(lib.pico), [mod('sd1', lib.microSd, { interface: 'SPI' })]);
    expect(netNamed(result.nets, 'SPI0_SCK')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:GP18', 'HW-FX05:CLK']);
    expect(netNamed(result.nets, 'SPI0_MOSI')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:GP19', 'HW-FX05:DI']);
    expect(netNamed(result.nets, 'SPI0_MISO')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:GP16', 'HW-FX05:DO']);
    expect(netNamed(result.nets, 'SD1_CS')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:GP17', 'HW-FX05:CS']);
    expect(netNamed(result.nets, '5V')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX01:VBUS', 'HW-FX05:5V']);
  });

  it('never puts a controller pin in two signal nets and never hands out reserved pins', () => {
    const result = allocatePins(mcu(lib.pico), [
      mod('bme1', lib.bme280, { interface: 'I2C' }),
      mod('gps1', lib.gps, { interface: 'UART' }, { interface: 'GPIO', pinName: 'PPS' }, { interface: 'GPIO', pinName: 'FIX' }),
      mod('sd1', lib.microSd, { interface: 'SPI' }, { interface: 'GPIO', pinName: 'CD' }),
    ]);
    const signalNets = result.nets.filter((n) => n.class !== 'power' && n.class !== 'ground');
    const controllerPins = signalNets.flatMap((n) => n.members.filter((m) => m.instanceId === 'mcu').map((m) => m.pinId));
    expect(new Set(controllerPins).size).toBe(controllerPins.length);
    for (const pinId of controllerPins) {
      const pin = lib.pico.record.pins.find((p) => p.pin_id === pinId)!;
      expect(isReservedForSignal(pin)).toBe(false);
    }
    // Every member names a pin the board actually has.
    const pinIds = new Set([lib.pico, lib.bme280, lib.gps, lib.microSd].flatMap((e) => e.record.pins.map((p) => p.pin_id)));
    for (const net of result.nets) for (const m of net.members) expect(pinIds.has(m.pinId)).toBe(true);
    expect(result.results.filter((r) => r.status === 'BLOCKER')).toEqual([]);
  });

  it('moves the second of two BME280s to 0x76 and wires its SDO strap to GND', () => {
    const controller = mcu(lib.pico);
    const peripherals = [mod('bme1', lib.bme280, { interface: 'I2C' }), mod('bme2', lib.bme280, { interface: 'I2C' })];
    const allocation = allocatePins(controller, peripherals);
    expect(allocation.i2cAddresses.get('bme1')).toMatchObject({ address: '0x77', moved: false });
    expect(allocation.i2cAddresses.get('bme2')).toMatchObject({ address: '0x76', moved: true, strap: { pin: 'SDO', level: 'GND', wired: true } });
    expect(netNamed(allocation.nets, 'GND')!.members.some((m) => m.instanceId === 'bme2' && m.pinId === 'HW-FX03:SDO')).toBe(true);
    const bus = evaluateCompatibility(controller, peripherals, allocation).filter((r) => r.ruleType === 'bus_address_conflict');
    expect(bus).toHaveLength(1);
    expect(bus[0]).toMatchObject({ status: 'PASS' });
    expect(bus[0]!.message).toContain('0x76');
  });

  it('flags a third BME280 (both addresses taken) as a blocker with the multiplexer fix', () => {
    const controller = mcu(lib.pico);
    const peripherals = ['bme1', 'bme2', 'bme3'].map((id) => mod(id, lib.bme280, { interface: 'I2C' }));
    const allocation = allocatePins(controller, peripherals);
    const conflict = evaluateCompatibility(controller, peripherals, allocation).find((r) => r.ruleType === 'bus_address_conflict' && r.status === 'BLOCKER');
    expect(conflict).toBeDefined();
    expect(conflict!.instanceIds.sort()).toEqual(['bme1', 'bme2', 'bme3']);
    expect(conflict!.suggestedFix).toContain('TCA9548A');
    expect(conflict!.pinIds.sort()).toEqual(['HW-FX03:SCK', 'HW-FX03:SDI']);
  });

  it("reads a rail pin's voltage from its domain, so the QT Py \"3V\" pin is a 3.3 V rail", () => {
    const result = allocatePins(mcu(lib.qtPy), [mod('gps1', lib.gps, { interface: 'UART' })]);
    expect(result.peripheralRails.get('gps1')).toBe(3.3);
    expect(netNamed(result.nets, '3V3')!.members.map((m) => m.pinId).sort()).toEqual(['HW-FX02:3V', 'HW-FX04:VIN']);
  });

  it('reports UNKNOWN, not PASS, when a module supply range is not in its record', () => {
    const unstructured: LibraryEntity = {
      ...lib.bme280,
      record: { ...lib.bme280.record, electrical: { ...lib.bme280.record.electrical, supply_voltage_min_v: null, supply_voltage_max_v: null } },
    };
    const result = allocatePins(mcu(lib.pico), [mod('bme1', unstructured, { interface: 'I2C' })]);
    const rail = result.results.find((r) => r.ruleType === 'required_power_rail');
    expect(rail?.status).toBe('UNKNOWN');
    expect(result.nets.find((n) => n.class === 'power')).toBeUndefined();
  });
});
