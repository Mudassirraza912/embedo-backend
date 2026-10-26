import { describe, it, expect } from '@jest/globals';
import { reconcileRequirements } from '../../src/modules/sessions/pipeline/requirements-reconciler.js';
import { CanonicalDesignGraph, RequestedRequirement } from '../../src/modules/sessions/pipeline/types.js';

describe('KAN-42: Requirements Coverage & Reconciliation Engine', () => {
  const mockGraph: CanonicalDesignGraph = {
    projectMeta: { name: 'Smart Greenhouse Monitor', tagline: 'Precision Agriculture', controller: 'ESP32-S3' },
    controller: { partNumber: 'ESP32-S3-WROOM-1', manufacturer: 'Espressif', rationale: 'Wi-Fi + BLE dual core' },
    nodes: [
      { id: 'mcu', label: 'Microcontroller', sublabel: 'Wi-Fi/BLE MCU', category: 'control', partNumber: 'ESP32-S3-WROOM-1' },
      { id: 'power', label: 'Battery Pack', sublabel: '3.7V LiPo', category: 'power', partNumber: 'LP-503035' },
      { id: 'charger', label: 'Battery Charger IC', sublabel: 'Linear Charger', category: 'power', partNumber: 'BQ25186' },
      { id: 'temp_humidity', label: 'Temperature & Humidity Sensor', sublabel: 'Digital I2C', category: 'sensing', partNumber: 'SHT40-AD1B-R2' },
      { id: 'light', label: 'Ambient Light Sensor', sublabel: 'I2C Photodiode', category: 'sensing', partNumber: 'OPT3001' },
      { id: 'soil', label: 'Capacitive Soil Moisture', sublabel: 'Analog Probes', category: 'sensing', partNumber: 'SEN0193' },
      { id: 'display', label: 'OLED Display', sublabel: '128x64 I2C', category: 'ui', partNumber: 'SSD1306' },
    ],
    edges: [],
    powerRails: [
      { name: '3.3V', voltageV: 3.3, source: 'charger', consumers: ['mcu', 'temp_humidity', 'light', 'display'] },
    ],
    bom: [],
    engineeringDecisions: [
      'Tradeoff: Cellular modem omitted due to tight power budget and existing Wi-Fi coverage on site.',
    ],
    suggestedRefinements: [],
  };

  it('accurately reconciles 20 requested requirements against a 7-module design without silent omissions', () => {
    // 20 explicit requirements requested by user
    const requestedReqs: RequestedRequirement[] = [
      { id: 'req-1', name: 'ESP32-S3 Microcontroller', category: 'control' },
      { id: 'req-2', name: '3.7V LiPo Battery', category: 'power' },
      { id: 'req-3', name: 'Battery Charger IC with USB-C', category: 'power' },
      { id: 'req-4', name: 'Digital Temperature Sensor', category: 'sensing' },
      { id: 'req-5', name: 'Relative Humidity Sensor', category: 'sensing' },
      { id: 'req-6', name: 'Ambient Light Sensor', category: 'sensing' },
      { id: 'req-7', name: 'Soil Moisture Sensor', category: 'sensing' },
      { id: 'req-8', name: '128x64 OLED Display', category: 'ui' },
      // 12 omitted / left-out items:
      { id: 'req-9', name: 'Cellular Modem LTE Cat-M1', category: 'connectivity' },
      { id: 'req-10', name: 'LoRaWAN Transceiver SX1262', category: 'connectivity' },
      { id: 'req-11', name: 'Sub-1GHz Antenna Switch', category: 'connectivity' },
      { id: 'req-12', name: 'CO2 NDIR Gas Sensor', category: 'sensing' },
      { id: 'req-13', name: 'Barometric Pressure Sensor', category: 'sensing' },
      { id: 'req-14', name: 'RGB Notification LEDs', category: 'ui' },
      { id: 'req-15', name: 'Water Pump Relay Driver', category: 'actuation' },
      { id: 'req-16', name: 'Piezo Buzzer Alarm', category: 'audio' },
      { id: 'req-17', name: 'MicroSD Card Storage', category: 'storage' },
      { id: 'req-18', name: 'External Hardware Watchdog IC', category: 'control' },
      { id: 'req-19', name: 'RS-485 Modbus Industrial Port', category: 'connectivity' },
      { id: 'req-20', name: 'Isolated Analog 0-10V Input', category: 'sensing' },
    ];

    const report = reconcileRequirements(requestedReqs, mockGraph, 'Prompt text', false);

    expect(report.totalRequested).toBe(20);
    // 7 items included (req-1 to req-8, with temp and humidity consolidated into SHT40)
    expect(report.includedCount).toBe(8);
    expect(report.leftOutCount).toBe(11);
    expect(report.needsClarificationCount).toBe(1); // 0-10V analog input needs specs

    // Check specific reconciliation items
    const esp32 = report.items.find((i) => i.id === 'req-1');
    expect(esp32?.status).toBe('included');
    expect(esp32?.matchedPartNumber).toBe('ESP32-S3-WROOM-1');

    const cellular = report.items.find((i) => i.id === 'req-9');
    expect(cellular?.status).toBe('left_out');
    expect(cellular?.reason).toBe('tradeoff');

    const analog010v = report.items.find((i) => i.id === 'req-20');
    expect(analog010v?.status).toBe('needs_clarification');
    expect(analog010v?.clarificationQuestion).toContain('Specify signal range');

    const relay = report.items.find((i) => i.id === 'req-15');
    expect(relay?.status).toBe('left_out');
    expect(relay?.reason).toBe('unexplained');

    expect(report.coveragePercentage).toBe(40);
  });

  it('surfaces an input warning when the specification exceeds the 6,000-character acceptance limit', () => {
    const longPrompt = 'a'.repeat(6001);
    const reqs: RequestedRequirement[] = [{ id: 'req-1', name: 'ESP32 MCU', category: 'control' }];
    const report = reconcileRequirements(reqs, mockGraph, longPrompt, true);

    expect(report.inputWarning).toBeDefined();
    expect(report.inputWarning).toContain('6,000 characters');
  });
});
