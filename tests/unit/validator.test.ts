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

  it('should auto-repair buck-only regulator AP63203 to TPS63031 buck-boost when powered by 2x AA battery', () => {
    const batteryBuckGraph: CanonicalDesignGraph = {
      ...mockGraph,
      nodes: [
        ...mockGraph.nodes,
        {
          id: 'battery',
          label: '2x AA Battery Pack',
          sublabel: '3.0V nominal',
          category: 'power',
          partNumber: '2X-AA-HOLDER',
        },
        {
          id: 'regulator',
          label: 'AP63203',
          sublabel: 'buck regulator',
          category: 'power',
          partNumber: 'AP63203WU-7',
        },
      ],
      bom: [
        {
          partNumber: 'AP63203WU-7',
          manufacturer: 'Diodes Inc',
          category: 'Power Management',
          description: 'Buck Converter',
          qty: 1,
        },
      ],
    };

    const report = validateAndRepairDesignGraph(batteryBuckGraph);
    const regNode = report.repairedGraph.nodes.find((n) => n.id === 'regulator');
    expect(regNode?.partNumber).toBe('TPS63031DSKR');
    expect(regNode?.label).toBe('TPS63031');
    expect(regNode?.sublabel).toBe('buck-boost converter');
    expect(report.issues.some((i) => i.code === 'REGULATOR_TOPOLOGY_INCOMPATIBLE')).toBe(true);
  });

  it('should auto-remove hazardous charger and charging path when battery is primary 2x AA cell', () => {
    const batteryChargerGraph: CanonicalDesignGraph = {
      ...mockGraph,
      nodes: [
        ...mockGraph.nodes,
        {
          id: 'battery',
          label: '2x AA Battery Pack',
          sublabel: '3.0V nominal',
          category: 'power',
          partNumber: '2X-AA-HOLDER',
        },
        {
          id: 'charger',
          label: 'BQ25186',
          sublabel: '1-cell charger',
          category: 'power',
          partNumber: 'BQ25186',
        },
        {
          id: 'regulator',
          label: 'TPS63031',
          sublabel: 'buck-boost converter',
          category: 'power',
          partNumber: 'TPS63031DSKR',
        },
      ],
    };

    const report = validateAndRepairDesignGraph(batteryChargerGraph);
    expect(report.repairedGraph.nodes.some((n) => n.id === 'charger')).toBe(false);
    expect(report.issues.some((i) => i.code === 'PRIMARY_BATTERY_CHARGER_REMOVED')).toBe(true);
  });

  it('should auto-add Semtech SX1262 LoRa transceiver when plain STM32L072CZ MCU is used for LoRaWAN project', () => {
    const loraGraph: CanonicalDesignGraph = {
      projectMeta: {
        name: 'LoRaWAN Weather Station',
        tagline: 'Outdoor temperature sensor over LoRaWAN',
        controller: 'STM32L072CZ',
      },
      controller: {
        partNumber: 'STM32L072CZ',
        manufacturer: 'STMicroelectronics',
        rationale: 'Low power microcontroller',
      },
      nodes: [
        {
          id: 'mcu',
          label: 'STM32L072CZ',
          sublabel: 'Microcontroller',
          category: 'control',
          partNumber: 'STM32L072CZ',
        },
        {
          id: 'sensor',
          label: 'SHT40',
          sublabel: 'Temp & Humidity',
          category: 'sensing',
          partNumber: 'SHT40-AD1B-R2',
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
      bom: [],
    };

    const report = validateAndRepairDesignGraph(loraGraph);
    const loraNode = report.repairedGraph.nodes.find((n) => n.id === 'lora_transceiver');
    expect(loraNode).toBeDefined();
    expect(loraNode?.partNumber).toBe('SX1262IMLTRT');
    expect(report.issues.some((i) => i.code === 'DISCRETE_LORA_TRANSCEIVER_ADDED')).toBe(true);
    const spiEdge = report.repairedGraph.edges.find((e) => e.to === 'lora_transceiver' && e.type === 'spi');
    expect(spiEdge).toBeDefined();
  });
});
