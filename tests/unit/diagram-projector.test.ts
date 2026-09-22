import { describe, it, expect } from '@jest/globals';
import { projectArchitecture } from '../../src/modules/sessions/pipeline/diagram-projector.js';
import { CanonicalDesignGraph } from '../../src/modules/sessions/pipeline/types.js';

describe('Deterministic Diagram Projector', () => {
  const sampleGraph: CanonicalDesignGraph = {
    projectMeta: {
      name: 'AI Voice Recorder',
      tagline: 'ESP32-S3 based voice recorder',
      controller: 'ESP32-S3-MINI',
    },
    controller: {
      partNumber: 'ESP32-S3-MINI',
      manufacturer: 'Espressif',
      rationale: 'High performance audio capture',
    },
    nodes: [
      {
        id: 'usbc',
        label: 'USB-C',
        sublabel: 'power + data',
        category: 'power',
        partNumber: 'TYPE-C-16P',
      },
      {
        id: 'charger',
        label: 'BQ25186',
        sublabel: '1-cell charger',
        category: 'power',
        partNumber: 'BQ25186',
      },
      {
        id: 'battery',
        label: '1S Li-Po',
        sublabel: '3.7V · 800mAh',
        category: 'power',
        partNumber: 'LIPO-800',
      },
      {
        id: 'regulator',
        label: 'AP63203WU-7',
        sublabel: '3.3V buck',
        category: 'power',
        partNumber: 'AP63203WU-7',
      },
      {
        id: 'mcu',
        label: 'ESP32-S3-MINI',
        sublabel: 'Wi-Fi • BLE MCU',
        category: 'control',
        partNumber: 'ESP32-S3-MINI',
      },
      {
        id: 'emmc',
        label: 'KLM8G1GETF',
        sublabel: '8GB eMMC',
        category: 'storage',
        partNumber: 'KLM8G1GETF',
      },
      {
        id: 'mics',
        label: 'MMICT5848 x2',
        sublabel: 'outward mics L/R',
        category: 'audio',
        partNumber: 'MMICT5848',
      },
    ],
    edges: [
      { from: 'usbc', to: 'mcu', label: 'USB D+/D-', type: 'usb' },
      { from: 'usbc', to: 'charger', label: 'VBUS 5V', type: 'power' },
      { from: 'charger', to: 'battery', label: 'charge', type: 'power' },
      { from: 'charger', to: 'regulator', label: 'VSYS', type: 'power' },
      { from: 'regulator', to: 'mcu', label: '3.3V', type: 'power' },
      { from: 'mcu', to: 'emmc', label: 'SDMMC', type: 'sdmmc' },
      { from: 'mcu', to: 'mics', label: 'I²S', type: 'signal' },
    ],
    powerRails: [
      {
        name: '3.3V',
        voltageV: 3.3,
        source: 'regulator',
        consumers: ['mcu', 'emmc', 'mics'],
      },
    ],
    bom: [
      {
        partNumber: 'ESP32-S3-MINI',
        manufacturer: 'Espressif',
        category: 'MCU',
        description: 'Dual core Xtensa LX7',
        qty: 1,
        unitCostUsd: 2.5,
      },
      {
        partNumber: 'BQ25186',
        manufacturer: 'Texas Instruments',
        category: 'Power Management',
        description: 'Linear Charger',
        qty: 1,
        unitCostUsd: 0.9,
      },
    ],
  };

  it('should project all 3 diagrams matching the frontend schema contract', () => {
    const projected = projectArchitecture(sampleGraph);

    // Meta & BOM
    expect(projected.projectMeta.name).toBe('AI Voice Recorder');
    expect(projected.projectMeta.controller).toBe('ESP32-S3-MINI');
    expect(projected.bom).toHaveLength(2);

    // Summary metrics & suggestions
    expect(projected.summary).toBeDefined();
    expect(projected.summary.mcu).toBe('ESP32-S3-MINI');
    expect(projected.summary.estimatedBomCostUsd).toBe(3.4);
    expect(projected.refineSuggestions?.length).toBeGreaterThan(0);

    // 01 - Functional Block Diagram
    expect(projected.functionalBlock.title).toBe('Functional Block Diagram');
    expect(projected.functionalBlock.nodes.length).toBeGreaterThan(0);
    expect(projected.functionalBlock.edges.length).toBeGreaterThan(0);
    expect(projected.functionalBlock.legend.length).toBeGreaterThan(0);

    // MCU should be positioned in center (x=410)
    const fbMcu = projected.functionalBlock.nodes.find((n) => n.id === 'mcu');
    expect(fbMcu?.x).toBe(410);

    // 02 - Power Tree Diagram
    expect(projected.powerTree.title).toBe('Power Tree');
    const railNode = projected.powerTree.nodes.find((n) => n.id === 'rail');
    expect(railNode).toBeDefined();

    // 03 - Protocol Map Diagram
    expect(projected.protocolMap.title).toBe('Protocol / Interface Map');
    expect(projected.protocolMap.nodes.find((n) => n.id === 'usbc')).toBeDefined();
  });
});
