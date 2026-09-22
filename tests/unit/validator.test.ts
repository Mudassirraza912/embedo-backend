import { describe, it, expect } from '@jest/globals';
import { validateAndRepairDesignGraph } from '../../src/modules/sessions/pipeline/validator.js';
import { CanonicalDesignGraph } from '../../src/modules/sessions/pipeline/types.js';

describe('Hardware Validator & Auto-Repairer', () => {
  const mockGraph: CanonicalDesignGraph = {
    projectMeta: {
      name: 'Smart BLE Sensor',
      tagline: 'BLE environmental sensing tag',
      controller: 'ESP32-S3-MINI-1',
    },
    controller: {
      partNumber: 'ESP32-S3-MINI-1',
      manufacturer: 'Espressif',
      rationale: 'Integrated BLE and native USB interface',
    },
    nodes: [
      {
        id: 'mcu',
        label: 'ESP32-S3-MINI-1',
        sublabel: 'BLE Controller',
        category: 'control',
        partNumber: 'ESP32-S3-MINI-1',
      },
      {
        id: 'sensor',
        label: 'SHTC3',
        sublabel: 'Temp & Humidity',
        category: 'sensing',
        partNumber: 'SHTC3',
        interfaces: ['I2C'],
      },
    ],
    edges: [],
    powerRails: [
      {
        name: '3.3V',
        voltageV: 3.3,
        source: 'regulator',
        consumers: [],
      },
    ],
    bom: [
      {
        partNumber: 'ESP32-S3-MINI-1',
        manufacturer: 'Espressif',
        category: 'Microcontroller',
        description: 'Wi-Fi & BLE MCU',
        qty: 1,
      },
    ],
  };

  it('should auto-repair disconnected peripherals by creating controller edges', () => {
    const report = validateAndRepairDesignGraph(mockGraph);

    expect(report.isValid).toBe(true);
    expect(report.repairedGraph.edges.length).toBeGreaterThan(0);
    const mcuEdge = report.repairedGraph.edges.find(
      (e) => e.from === 'mcu' && e.to === 'sensor'
    );
    expect(mcuEdge).toBeDefined();
  });

  it('should auto-connect unpowered nodes to default 3.3V power rail', () => {
    const report = validateAndRepairDesignGraph(mockGraph);

    expect(report.repairedGraph.powerRails[0]?.consumers).toContain('sensor');
  });

  it('should filter out invalid edges with non-existent endpoints', () => {
    const brokenGraph: CanonicalDesignGraph = {
      ...mockGraph,
      edges: [
        {
          from: 'mcu',
          to: 'non_existent_node',
          label: 'SPI',
          type: 'spi',
        },
      ],
    };

    const report = validateAndRepairDesignGraph(brokenGraph);
    const brokenEdge = report.repairedGraph.edges.find((e) => e.to === 'non_existent_node');
    expect(brokenEdge).toBeUndefined();
  });
});
