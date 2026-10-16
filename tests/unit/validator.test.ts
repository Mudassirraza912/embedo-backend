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

  it('should auto-repair 2-wire 4-20mA loop transmitter with high-power isolator to AD5421 and ADuM1441', () => {
    const loopGraph: CanonicalDesignGraph = {
      projectMeta: {
        name: 'Isolated 4-20 mA HART RTD Transmitter',
        tagline: 'Loop-powered 4-20mA sensor with galvanic isolation',
        controller: 'MSP430F2001',
      },
      controller: {
        partNumber: 'MSP430F2001',
        manufacturer: 'Texas Instruments',
        rationale: 'Ultra-low-power 16-bit MCU',
      },
      nodes: [
        {
          id: 'loop_connector',
          label: 'Loop Connector',
          sublabel: '24V Loop Supply (4-20mA)',
          category: 'power',
          partNumber: 'TB002-500-02BE',
        },
        {
          id: 'isolated_dcdc',
          label: 'ADuM5000',
          sublabel: 'Isolated DC-DC',
          category: 'power',
          partNumber: 'ADuM5000ARWZ',
          currentMa: 20,
        },
        {
          id: 'mcu',
          label: 'MSP430F2001',
          sublabel: 'Microcontroller',
          category: 'control',
          partNumber: 'MSP430F2001',
          currentMa: 0.3,
        },
      ],
      edges: [],
      powerRails: [
        {
          name: '3.3V',
          voltageV: 3.3,
          source: 'loop_connector',
          consumers: ['mcu'],
        },
      ],
      bom: [
        {
          partNumber: 'ADuM5000ARWZ',
          manufacturer: 'Analog Devices',
          category: 'Power Management',
          description: 'Isolated DC/DC Converter 5V 500mW',
          qty: 1,
        },
      ],
    };

    const report = validateAndRepairDesignGraph(loopGraph);
    expect(report.issues.some((i) => i.code === 'LOOP_POWER_BUDGET_EXCEEDED')).toBe(true);
    const isoNode = report.repairedGraph.nodes.find((n) => n.id === 'digital_isolator');
    expect(isoNode).toBeDefined();
    expect(isoNode?.partNumber).toBe('ADuM1441ARSZ');
    expect(isoNode?.currentMa).toBeLessThan(0.05);
    const bomItem = report.repairedGraph.bom.find((b) => b.partNumber === 'ADuM1441ARSZ');
    expect(bomItem).toBeDefined();
  });

  it('should auto-inject 47uF pulse reservoir capacitor when CR2032 powers BLE/RF load', () => {
    const bleBeaconGraph: CanonicalDesignGraph = {
      projectMeta: {
        name: 'BLE Asset Tracker Beacon',
        tagline: 'CR2032 powered iBeacon with accelerometer',
        controller: 'nRF52810',
      },
      controller: {
        partNumber: 'nRF52810-QFAA',
        manufacturer: 'Nordic Semiconductor',
        rationale: 'Ultra-low-power BLE 5.0 SoC',
      },
      nodes: [
        {
          id: 'battery',
          label: 'CR2032 Coin Cell',
          sublabel: '3.0V / 225mAh',
          category: 'power',
          partNumber: 'CR2032',
        },
        {
          id: 'mcu',
          label: 'nRF52810',
          sublabel: 'BLE SoC',
          category: 'control',
          partNumber: 'nRF52810-QFAA',
        },
      ],
      edges: [],
      powerRails: [
        {
          name: '3.0V',
          voltageV: 3.0,
          source: 'battery',
          consumers: ['mcu'],
        },
      ],
      bom: [],
    };

    const report = validateAndRepairDesignGraph(bleBeaconGraph);
    expect(report.issues.some((i) => i.code === 'COIN_CELL_PULSE_CAPACITOR_ADDED')).toBe(true);
    const pulseCapNode = report.repairedGraph.nodes.find((n) => n.id === 'pulse_reservoir_cap');
    expect(pulseCapNode).toBeDefined();
    expect(pulseCapNode?.partNumber).toBe('GRM31CR61A476KE15L');
    const bomItem = report.repairedGraph.bom.find((b) => b.partNumber === 'GRM31CR61A476KE15L');
    expect(bomItem).toBeDefined();
  });

  it('should auto-inject MLCC buffer capacitor for supercapacitor design operating at sub-zero temperatures', () => {
    const supercapGraph: CanonicalDesignGraph = {
      projectMeta: {
        name: 'Agricultural Soil Moisture Node',
        tagline: 'Solar + Supercapacitor node operating outdoors from -30°C to 65°C',
        controller: 'STM32L071',
      },
      controller: {
        partNumber: 'STM32L071KBT6',
        manufacturer: 'STMicroelectronics',
        rationale: 'Ultra-low-power Cortex-M0+ MCU',
      },
      nodes: [
        {
          id: 'solar_panel',
          label: 'Solar Panel',
          sublabel: '5V 100mA',
          category: 'power',
          partNumber: 'SP-5V-100MA',
        },
        {
          id: 'supercap',
          label: 'Supercapacitor Bank',
          sublabel: '5.5V / 10F',
          category: 'power',
          partNumber: 'XT3560-3R0307-R',
        },
        {
          id: 'mcu',
          label: 'STM32L071',
          sublabel: 'MCU',
          category: 'control',
          partNumber: 'STM32L071KBT6',
        },
      ],
      edges: [],
      powerRails: [
        {
          name: '3.3V',
          voltageV: 3.3,
          source: 'supercap',
          consumers: ['mcu'],
        },
      ],
      bom: [],
    };

    const report = validateAndRepairDesignGraph(supercapGraph);
    expect(report.issues.some((i) => i.code === 'SUPERCAPACITOR_COLD_ESR_DERATED')).toBe(true);
    const mlccNode = report.repairedGraph.nodes.find((n) => n.id === 'supercap_mlcc_buffer');
    expect(mlccNode).toBeDefined();
    expect(mlccNode?.partNumber).toBe('GRM32ER61C107ME20L');
  });

  it('should auto-repair tuning-fork quartz crystal to silicon MEMS oscillator for stratospheric flight computer at -60C', () => {
    const flightComputerGraph: CanonicalDesignGraph = {
      projectMeta: {
        name: 'Stratospheric Flight Computer',
        tagline: 'Stratospheric flight computer running down to -60°C',
        controller: 'STM32L151',
      },
      controller: {
        partNumber: 'STM32L151C8T6',
        manufacturer: 'STMicroelectronics',
        rationale: 'Low-power flight controller',
      },
      nodes: [
        {
          id: 'crystal',
          label: '32.768kHz Crystal',
          sublabel: 'Tuning-Fork Crystal',
          category: 'power',
          partNumber: 'ABS07-32.768KHZ-T',
        },
        {
          id: 'mcu',
          label: 'STM32L151',
          sublabel: 'MCU',
          category: 'control',
          partNumber: 'STM32L151C8T6',
        },
      ],
      edges: [],
      powerRails: [
        {
          name: '3.3V',
          voltageV: 3.3,
          source: 'mcu',
          consumers: [],
        },
      ],
      bom: [
        {
          partNumber: 'ABS07-32.768KHZ-T',
          manufacturer: 'Abracon',
          category: 'Crystals',
          description: 'Crystal 32.7680kHz 12.5pF SMD',
          qty: 1,
        },
      ],
    };

    const report = validateAndRepairDesignGraph(flightComputerGraph);
    expect(report.issues.some((i) => i.code === 'EXTREME_COLD_TEMPERATURE_DERATED')).toBe(true);
    const oscNode = report.repairedGraph.nodes.find((n) => n.id === 'crystal');
    expect(oscNode?.partNumber).toBe('SiT1532AI-J4-DCC-32.768E');
    expect(oscNode?.label).toBe('SiT1532');
    const bomItem = report.repairedGraph.bom.find((b) => b.partNumber === 'SiT1532AI-J4-DCC-32.768E');
    expect(bomItem).toBeDefined();
  });

  it('should auto-repair 28V buck regulator to 40V AEC-Q100 LMR14030-Q1 for automotive 12V system', () => {
    const autoGraph: CanonicalDesignGraph = {
      projectMeta: {
        name: 'Automotive LTE Telematics Module',
        tagline: '12V automotive telematics module with ISO 7637-2 load dump protection',
        controller: 'STM32F405',
      },
      controller: {
        partNumber: 'STM32F405RGT6',
        manufacturer: 'STMicroelectronics',
        rationale: 'Telematics application MCU',
      },
      nodes: [
        {
          id: 'battery_12v',
          label: '12V Vehicle Battery',
          sublabel: 'Automotive Power Input',
          category: 'power',
          partNumber: 'AUTOMOTIVE-12V-IN',
        },
        {
          id: 'buck_regulator',
          label: 'TPS54202',
          sublabel: '28V 2A Buck Regulator',
          category: 'power',
          partNumber: 'TPS54202DDCR',
        },
        {
          id: 'mcu',
          label: 'STM32F405',
          sublabel: 'MCU',
          category: 'control',
          partNumber: 'STM32F405RGT6',
        },
      ],
      edges: [],
      powerRails: [
        {
          name: '3.3V',
          voltageV: 3.3,
          source: 'buck_regulator',
          consumers: ['mcu'],
        },
      ],
      bom: [
        {
          partNumber: 'TPS54202DDCR',
          manufacturer: 'Texas Instruments',
          category: 'Power Management',
          description: 'Step-Down Converter 4.5V-28V In, 2A Out',
          qty: 1,
        },
      ],
    };

    const report = validateAndRepairDesignGraph(autoGraph);
    expect(report.issues.some((i) => i.code === 'AUTOMOTIVE_BUCK_VOLTAGE_INSUFFICIENT')).toBe(true);
    const buckNode = report.repairedGraph.nodes.find((n) => n.id === 'buck_regulator');
    expect(buckNode?.partNumber).toBe('LMR14030SDDA');
    expect(buckNode?.label).toBe('LMR14030-Q1');
    const bomItem = report.repairedGraph.bom.find((b) => b.partNumber === 'LMR14030SDDA');
    expect(bomItem).toBeDefined();
    const tvsBom = report.repairedGraph.bom.find((b) => b.partNumber === 'SMCJ36CA');
    expect(tvsBom).toBeDefined();
  });

  it('should auto-protect cellular modem from 5V overvoltage by creating dedicated 3.8V rail', () => {
    const telematicsGraph: CanonicalDesignGraph = {
      projectMeta: {
        name: 'Automotive LTE Telematics Module',
        tagline: 'Telematics with Quectel EC21 LTE Cat-1 Modem',
        controller: 'STM32F405',
      },
      controller: {
        partNumber: 'STM32F405RGT6',
        manufacturer: 'STMicroelectronics',
        rationale: 'Telematics application MCU',
      },
      nodes: [
        {
          id: 'mcu',
          label: 'STM32F405',
          sublabel: 'MCU',
          category: 'control',
          partNumber: 'STM32F405RGT6',
        },
        {
          id: 'lte_modem',
          label: 'Quectel EC21',
          sublabel: 'LTE Cat-1 Modem',
          category: 'connectivity',
          partNumber: 'EC21-A',
        },
      ],
      edges: [],
      powerRails: [
        {
          name: '5V',
          voltageV: 5.0,
          source: 'main_regulator',
          consumers: ['lte_modem'],
        },
        {
          name: '3.3V',
          voltageV: 3.3,
          source: 'main_regulator',
          consumers: ['mcu'],
        },
      ],
      bom: [
        {
          partNumber: 'EC21-A',
          manufacturer: 'Quectel',
          category: 'Wireless',
          description: 'LTE Cat 1 Module',
          qty: 1,
        },
      ],
    };

    const report = validateAndRepairDesignGraph(telematicsGraph);
    expect(report.issues.some((i) => i.code === 'CELLULAR_MODEM_VBAT_OVERVOLTAGE')).toBe(true);
    const rail5V = report.repairedGraph.powerRails.find((r) => r.name === '5V');
    expect(rail5V?.consumers.includes('lte_modem')).toBe(false);
    const rail38V = report.repairedGraph.powerRails.find((r) => r.voltageV === 3.8);
    expect(rail38V).toBeDefined();
    expect(rail38V?.consumers.includes('lte_modem')).toBe(true);
    const modemNode = report.repairedGraph.nodes.find((n) => n.id === 'lte_modem');
    expect(modemNode?.voltageV).toBe(3.8);
    const poscapBom = report.repairedGraph.bom.find((b) => b.partNumber === '6TPB470M');
    expect(poscapBom).toBeDefined();
  });

  it('should auto-upgrade 1W isolated DC-DC to 2W B0505S-2WR3 for 4-channel isolated RS-485 bridge', () => {
    const rs485Graph: CanonicalDesignGraph = {
      projectMeta: {
        name: 'USB 2.0 to 4-Channel Isolated RS-485 Bridge',
        tagline: '4-channel isolated RS-485 transceiver with ESD protection',
        controller: 'ESP32-P4',
      },
      controller: {
        partNumber: 'ESP32-P4',
        manufacturer: 'Espressif',
        rationale: 'High-speed USB host/device MCU',
      },
      nodes: [
        {
          id: 'isolated_dcdc',
          label: 'B0505S-1W',
          sublabel: '1W Isolated DC-DC',
          category: 'power',
          partNumber: 'B0505S-1W',
        },
        {
          id: 'mcu',
          label: 'ESP32-P4',
          sublabel: 'MCU',
          category: 'control',
          partNumber: 'ESP32-P4',
        },
        {
          id: 'rs485_ch1',
          label: 'ISO1500 CH1',
          sublabel: 'Isolated RS-485',
          category: 'connectivity',
          partNumber: 'ISO1500DBQ',
        },
        {
          id: 'rs485_ch2',
          label: 'ISO1500 CH2',
          sublabel: 'Isolated RS-485',
          category: 'connectivity',
          partNumber: 'ISO1500DBQ',
        },
        {
          id: 'rs485_ch3',
          label: 'ISO1500 CH3',
          sublabel: 'Isolated RS-485',
          category: 'connectivity',
          partNumber: 'ISO1500DBQ',
        },
        {
          id: 'rs485_ch4',
          label: 'ISO1500 CH4',
          sublabel: 'Isolated RS-485',
          category: 'connectivity',
          partNumber: 'ISO1500DBQ',
        },
      ],
      edges: [],
      powerRails: [
        {
          name: '5V_ISO',
          voltageV: 5.0,
          source: 'isolated_dcdc',
          consumers: ['rs485_ch1', 'rs485_ch2', 'rs485_ch3', 'rs485_ch4'],
        },
      ],
      bom: [
        {
          partNumber: 'B0505S-1W',
          manufacturer: 'Mornsun',
          category: 'Power Management',
          description: 'Isolated DC/DC Converter 5V to 5V 1W',
          qty: 1,
        },
      ],
    };

    const report = validateAndRepairDesignGraph(rs485Graph);
    expect(report.issues.some((i) => i.code === 'ISOLATED_DCDC_UNDERSIZED')).toBe(true);
    const dcdcNode = report.repairedGraph.nodes.find((n) => n.id === 'isolated_dcdc');
    expect(dcdcNode?.partNumber).toBe('B0505S-2WR3');
    expect(dcdcNode?.label).toBe('B0505S-2WR3');
    const bomItem = report.repairedGraph.bom.find((b) => b.partNumber === 'B0505S-2WR3');
    expect(bomItem).toBeDefined();
  });

  it('should de-duplicate cascaded ECG analog front-ends by removing redundant AD8232 when ADS1292R is present', () => {
    const ecgGraph: CanonicalDesignGraph = {
      projectMeta: {
        name: 'Wearable ECG Monitor',
        tagline: 'Single-lead wearable ECG monitor with 24-bit ADC and RLD',
        controller: 'nRF52840',
      },
      controller: {
        partNumber: 'nRF52840-QIAA',
        manufacturer: 'Nordic Semiconductor',
        rationale: 'BLE SoC',
      },
      nodes: [
        {
          id: 'ad8232',
          label: 'AD8232',
          sublabel: 'Analog ECG Front-End',
          category: 'sensing',
          partNumber: 'AD8232ACPTZ',
        },
        {
          id: 'ads1292',
          label: 'ADS1292R',
          sublabel: '24-Bit 2-Channel ECG AFE',
          category: 'sensing',
          partNumber: 'ADS1292RIRSMR',
        },
        {
          id: 'mcu',
          label: 'nRF52840',
          sublabel: 'BLE SoC',
          category: 'control',
          partNumber: 'nRF52840-QIAA',
        },
      ],
      edges: [
        { from: 'ad8232', to: 'ads1292', label: 'ANALOG_IN', type: 'analog' },
        { from: 'mcu', to: 'ads1292', label: 'SPI', type: 'spi' },
      ],
      powerRails: [
        {
          name: '3.3V',
          voltageV: 3.3,
          source: 'regulator',
          consumers: ['mcu', 'ad8232', 'ads1292'],
        },
      ],
      bom: [
        {
          partNumber: 'AD8232ACPTZ',
          manufacturer: 'Analog Devices',
          category: 'Analog Front End',
          description: 'Single-Lead Heart Rate Monitor Front End',
          qty: 1,
        },
        {
          partNumber: 'ADS1292RIRSMR',
          manufacturer: 'Texas Instruments',
          category: 'Analog Front End',
          description: 'Low-Power 2-Channel 24-Bit AFE for ECG',
          qty: 1,
        },
      ],
    };

    const report = validateAndRepairDesignGraph(ecgGraph);
    expect(report.issues.some((i) => i.code === 'REDUNDANT_ECG_AFE_REMOVED')).toBe(true);
    expect(report.repairedGraph.nodes.some((n) => n.id === 'ad8232')).toBe(false);
    expect(report.repairedGraph.nodes.some((n) => n.id === 'ads1292')).toBe(true);
    expect(report.repairedGraph.bom.some((b) => b.partNumber === 'AD8232ACPTZ')).toBe(false);
    expect(report.repairedGraph.bom.some((b) => b.partNumber === 'ADS1292RIRSMR')).toBe(true);
    const rail = report.repairedGraph.powerRails.find((r) => r.name === '3.3V');
    expect(rail?.consumers.includes('ad8232')).toBe(false);
    expect(rail?.consumers.includes('ads1292')).toBe(true);
  });
});
