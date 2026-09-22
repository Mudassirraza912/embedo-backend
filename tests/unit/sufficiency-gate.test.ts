import { describe, it, expect } from '@jest/globals';
import { checkSufficiency } from '../../src/modules/sessions/pipeline/sufficiency-gate.js';
import { StructuredIntent } from '../../src/modules/sessions/pipeline/types.js';

describe('Sufficiency Gate', () => {
  it('should flag incomplete intent missing device type and subsystems', () => {
    const incompleteIntent: StructuredIntent = {
      deviceType: 'device',
      purpose: '',
      subsystems: {},
      constraints: {},
      mustHaveInterfaces: [],
    };

    const result = checkSufficiency(incompleteIntent);
    expect(result.sufficient).toBe(false);
    expect(result.missingFields).toContain('deviceType');
    expect(result.missingFields).toContain('subsystems');
    expect(result.clarificationQuestions.length).toBeGreaterThan(0);
  });

  it('should pass complete intent with device type, sensors, and power', () => {
    const completeIntent: StructuredIntent = {
      deviceType: 'Environmental Monitor',
      purpose: 'Battery-powered BLE environmental monitor logging temperature and CO2',
      subsystems: {
        sensing: ['temperature', 'humidity', 'co2'],
        connectivity: ['ble'],
        power: ['lipo_battery', 'usb_c'],
      },
      constraints: {
        powerSource: '3.7V LiPo with USB-C charging',
        formFactor: 'compact wearable',
      },
      mustHaveInterfaces: ['i2c'],
    };

    const result = checkSufficiency(completeIntent);
    expect(result.sufficient).toBe(true);
    expect(result.missingFields).toHaveLength(0);
    expect(result.clarificationQuestions).toHaveLength(0);
  });

  it('should provide suggested default power source for portable devices if omitted', () => {
    const portableIntent: StructuredIntent = {
      deviceType: 'Wearable Tracker',
      purpose: 'A portable wearable fitness tracker with IMU and BLE',
      subsystems: {
        sensing: ['imu'],
        connectivity: ['ble'],
      },
      constraints: {},
      mustHaveInterfaces: ['spi'],
    };

    const result = checkSufficiency(portableIntent);
    expect(result.suggestedDefaults?.['powerSource']).toBeDefined();
    expect(result.suggestedDefaults?.['powerSource']).toContain('LiPo Battery');
  });
});

/**
 * PRD §6.11 / Roadmap Phase-1 acceptance criterion, stated verbatim:
 * "Portable environmental monitor with temperature, humidity, CO₂ sensing and BLE connectivity"
 * names sensing and connectivity but never confirms a power source — it must ask, not guess.
 */
describe('Sufficiency Gate — PRD §6.11 worked example', () => {
  const co2MonitorIntent: StructuredIntent = {
    deviceType: 'environmental monitor',
    purpose: 'portable air-quality sensing with temperature, humidity and CO2',
    subsystems: { sensing: ['temperature', 'humidity', 'co2'], connectivity: ['ble'] },
    constraints: {},
    mustHaveInterfaces: ['i2c'],
  };

  it('BLOCKS generation and asks about the power source', () => {
    const result = checkSufficiency(co2MonitorIntent, 'Portable environmental monitor with temperature, humidity, CO2 sensing and BLE connectivity.');

    expect(result.sufficient).toBe(false);
    expect(result.missingFields).toContain('powerSource');
    expect(result.clarificationQuestions.length).toBeGreaterThan(0);
    expect(result.clarificationQuestions.join(' ').toLowerCase()).toContain('powered');
    // It recognises "portable" and proposes a sensible default alongside the question.
    expect(result.suggestedDefaults?.['powerSource']).toContain('LiPo');
  });

  it('PASSES once the power source is supplied', () => {
    const answered: StructuredIntent = {
      ...co2MonitorIntent,
      constraints: { powerSource: 'rechargeable 3.7V LiPo with USB-C charging' },
    };
    const result = checkSufficiency(answered, 'Portable environmental monitor ... powered by a rechargeable LiPo.');
    expect(result.sufficient).toBe(true);
    expect(result.missingFields).not.toContain('powerSource');
  });

  it('does not block a mains/USB device that states its supply', () => {
    const wallPowered: StructuredIntent = {
      deviceType: 'access control terminal',
      purpose: 'wall-mounted RFID access terminal with keypad and SSR outputs',
      subsystems: { sensing: ['rfid'], connectivity: ['ble'], power: ['12v_dc'] },
      constraints: { formFactor: 'din_rail' },
      mustHaveInterfaces: ['spi'],
    };
    const result = checkSufficiency(wallPowered, 'Wall mounted access control terminal on 12V DC.');
    expect(result.sufficient).toBe(true);
  });
});
