import { CanonicalDesignGraph, DesignEdge, DesignNode, BomItem, NodeCategory, EdgeType } from './types.js';

export interface ExpansionCandidate {
  id: string;
  label: string;
  sublabel: string;
  category: NodeCategory;
  partNumber: string;
  manufacturer: string;
  rationale: string;
  voltageV: number;
  currentMa: number;
  interfaces: string[];
  edgeType: EdgeType;
  bomCategory: string;
  bomDescription: string;
  unitCostUsd: number;
}

/**
 * Verified production hardware catalogue for dynamic multi-module architectural expansion.
 * Real, commercially available ICs across sensing, telemetry, actuation, storage, and bus management.
 */
export const EXPANSION_CATALOGUE: readonly ExpansionCandidate[] = [
  // 1. Bus Management & Multiplexing
  {
    id: 'i2c_mux',
    label: 'I2C Bus Multiplexer',
    sublabel: '8-Channel I2C Switch',
    category: 'control',
    partNumber: 'TCA9548APWR',
    manufacturer: 'Texas Instruments',
    rationale: '8-channel bidirectional translation switch resolving I2C address conflicts and isolating bus capacitance across expansion sensors',
    voltageV: 3.3,
    currentMa: 0.1,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Interface & Multiplexers',
    bomDescription: 'Low-Voltage 8-Channel I2C Switch with Reset TSSOP-24',
    unitCostUsd: 1.42,
  },
  {
    id: 'gpio_expander',
    label: 'GPIO Expander',
    sublabel: '16-Bit I2C I/O Expander',
    category: 'control',
    partNumber: 'MCP23017-E/SO',
    manufacturer: 'Microchip',
    rationale: '16-bit remote bidirectional I/O port expander with interrupt output for status LEDs, limit switches, and chip selects',
    voltageV: 3.3,
    currentMa: 1.0,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Interface & Logic',
    bomDescription: '16-bit I/O Expander with I2C Interface SOIC-28',
    unitCostUsd: 1.25,
  },

  // 2. Environmental & Climate Sensing
  {
    id: 'env_bme280',
    label: 'Environmental Sensor',
    sublabel: 'Temp, Humidity & Pressure',
    category: 'sensing',
    partNumber: 'BME280',
    manufacturer: 'Bosch Sensortec',
    rationale: 'Integrated combined temperature, relative humidity, and barometric air pressure sensor for atmospheric monitoring',
    voltageV: 3.3,
    currentMa: 0.36,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Environmental',
    bomDescription: 'Digital Combined Humidity, Pressure and Temp Sensor LGA-8',
    unitCostUsd: 3.85,
  },
  {
    id: 'temp_hum_sht40',
    label: 'Precision Temp & Humidity',
    sublabel: 'High-Accuracy RH/T',
    category: 'sensing',
    partNumber: 'SHT40-AD1B-R2',
    manufacturer: 'Sensirion',
    rationale: 'High-accuracy relative humidity (±1.5% RH) and temperature (±0.1°C) sensor with integrated heater for dew remediation',
    voltageV: 3.3,
    currentMa: 0.08,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Environmental',
    bomDescription: 'High Accuracy Relative Humidity and Temp Sensor DFN-4',
    unitCostUsd: 1.95,
  },
  {
    id: 'co2_scd41',
    label: 'Photoacoustic CO2 Sensor',
    sublabel: 'NDIR/Photoacoustic NDIR',
    category: 'sensing',
    partNumber: 'SCD41-AD1T-00',
    manufacturer: 'Sensirion',
    rationale: 'Miniaturized photoacoustic CO2 sensor (400-5000 ppm) for indoor air quality and ventilation control',
    voltageV: 3.3,
    currentMa: 18.0,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Gas & Air Quality',
    bomDescription: 'Miniature Photoacoustic CO2 Sensor 400-5000ppm SMD',
    unitCostUsd: 16.5,
  },
  {
    id: 'baro_bmp390',
    label: 'Precision Barometer',
    sublabel: 'Altimeter & Pressure',
    category: 'sensing',
    partNumber: 'BMP390',
    manufacturer: 'Bosch Sensortec',
    rationale: 'Ultra-low noise 24-bit digital barometric pressure sensor providing ±3 Pa relative accuracy for altitude tracking',
    voltageV: 3.3,
    currentMa: 0.54,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Pressure',
    bomDescription: 'Digital Barometric Pressure Sensor 300-1250 hPa LGA-10',
    unitCostUsd: 2.1,
  },
  {
    id: 'voc_sgp40',
    label: 'Air Quality VOC Sensor',
    sublabel: 'Volatile Organic Compounds',
    category: 'sensing',
    partNumber: 'SGP40-REEL',
    manufacturer: 'Sensirion',
    rationale: 'MOX-based gas sensor providing VOC index output with automated baseline compensation for indoor air monitoring',
    voltageV: 3.3,
    currentMa: 2.6,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Gas & Air Quality',
    bomDescription: 'Digital Volatile Organic Compound (VOC) Gas Sensor DFN-6',
    unitCostUsd: 3.2,
  },

  // 3. Motion, Spatial & Inertial Sensing
  {
    id: 'imu_icm42688',
    label: '6-Axis High-Grade IMU',
    sublabel: 'Gyroscope & Accelerometer',
    category: 'sensing',
    partNumber: 'ICM-42688-P',
    manufacturer: 'TDK InvenSense',
    rationale: 'High-performance 6-axis MEMS IMU with ultra-low noise density and on-chip DMP for orientation and motion classification',
    voltageV: 3.3,
    currentMa: 0.88,
    interfaces: ['SPI', 'I2C'],
    edgeType: 'spi',
    bomCategory: 'Sensors - Motion',
    bomDescription: '6-Axis IMU (3-Axis Accel + 3-Axis Gyro) 24-QFN',
    unitCostUsd: 2.75,
  },
  {
    id: 'mag_lis3mdl',
    label: '3-Axis Magnetometer',
    sublabel: 'Digital Compass',
    category: 'sensing',
    partNumber: 'LIS3MDLTR',
    manufacturer: 'STMicroelectronics',
    rationale: 'Ultra-low-power 3-axis magnetic sensor (±16 gauss full scale) for heading reference and electronic compass fusion',
    voltageV: 3.3,
    currentMa: 0.27,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Motion',
    bomDescription: 'Ultra-low-power 3-axis Magnetometer LGA-12',
    unitCostUsd: 1.15,
  },
  {
    id: 'accel_adxl345',
    label: 'Ultra-Low Power Accelerometer',
    sublabel: '3-Axis Shock & Motion',
    category: 'sensing',
    partNumber: 'ADXL345BCCZ',
    manufacturer: 'Analog Devices',
    rationale: '3-axis MEMS accelerometer with user-selectable tap/double-tap detection and activity interrupts for wakeup',
    voltageV: 3.3,
    currentMa: 0.14,
    interfaces: ['SPI'],
    edgeType: 'spi',
    bomCategory: 'Sensors - Motion',
    bomDescription: '3-Axis ±16g Digital Accelerometer LGA-14',
    unitCostUsd: 2.3,
  },

  // 4. Optical, Light & Proximity
  {
    id: 'tof_vl53l0x',
    label: 'Time-of-Flight Ranger',
    sublabel: 'Laser Distance Sensor',
    category: 'sensing',
    partNumber: 'VL53L0X',
    manufacturer: 'STMicroelectronics',
    rationale: '940nm VCSEL FlightSense Time-of-Flight ranging sensor measuring distance up to 2m independent of target reflectance',
    voltageV: 3.3,
    currentMa: 19.0,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Optical',
    bomDescription: 'Time-of-Flight (ToF) Laser Ranging Sensor Module 12-LGA',
    unitCostUsd: 3.4,
  },
  {
    id: 'light_tsl2591',
    label: 'Precision Lux Sensor',
    sublabel: 'High Dynamic Range Lux',
    category: 'sensing',
    partNumber: 'TSL25911FN',
    manufacturer: 'ams OSRAM',
    rationale: 'Very-high dynamic range (600,000,000:1) ambient light sensor with separate infrared and full-spectrum photodiodes',
    voltageV: 3.3,
    currentMa: 0.4,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Optical',
    bomDescription: 'Very-High Dynamic Range Light-to-Digital Converter ODFN-6',
    unitCostUsd: 1.6,
  },
  {
    id: 'ambient_veml7700',
    label: 'Ambient Light Sensor',
    sublabel: 'Human-Eye Matched Lux',
    category: 'sensing',
    partNumber: 'VEML7700-TT',
    manufacturer: 'Vishay',
    rationale: 'High-accuracy ambient light sensor with 16-bit resolution and spectral response closely matching the human eye photopic curve',
    voltageV: 3.3,
    currentMa: 0.05,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Optical',
    bomDescription: 'High Accuracy Ambient Light Sensor with I2C Interface SMT',
    unitCostUsd: 1.1,
  },
  {
    id: 'pulse_ox_max30102',
    label: 'Pulse Oximeter & PPG',
    sublabel: 'Heart Rate & SpO2',
    category: 'sensing',
    partNumber: 'MAX30102EFD+T',
    manufacturer: 'Analog Devices',
    rationale: 'Integrated pulse oximetry and heart-rate monitor biosensor module with dual Red/IR LEDs and low-noise photodetector',
    voltageV: 3.3,
    currentMa: 1.2,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Biomedical',
    bomDescription: 'Integrated Pulse Oximeter and Heart-Rate Sensor 14-OESIP',
    unitCostUsd: 4.25,
  },

  // 5. Power Telemetry, Current & Fuel Gauge
  {
    id: 'power_monitor_ina226',
    label: 'Bidirectional Power Monitor',
    sublabel: 'High-Side Current & Power',
    category: 'power',
    partNumber: 'INA226AIDGSR',
    manufacturer: 'Texas Instruments',
    rationale: '16-bit precision current shunt and bus voltage monitor (0V-36V) with programmable calibration and alert output',
    voltageV: 3.3,
    currentMa: 0.33,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Power Management - Monitors',
    bomDescription: '36V, 16-Bit, I2C Current/Power Monitor VSSOP-10',
    unitCostUsd: 1.85,
  },
  {
    id: 'fuel_gauge_max17048',
    label: 'LiPo Fuel Gauge',
    sublabel: 'ModelGauge SoC Sensor',
    category: 'gauge',
    partNumber: 'MAX17048G+T10',
    manufacturer: 'Analog Devices',
    rationale: 'Ultra-low power 1S Li-Ion/LiPo battery fuel gauge utilizing ModelGauge algorithm without requiring a sense resistor',
    voltageV: 3.3,
    currentMa: 0.023,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Power Management - Battery',
    bomDescription: '1S Li+ Battery Fuel Gauge with ModelGauge TDFN-8',
    unitCostUsd: 1.35,
  },

  // 6. Timing, RTC & Non-Volatile Storage
  {
    id: 'rtc_ds3231',
    label: 'Precision Real-Time Clock',
    sublabel: 'TCXO Temperature-Compensated',
    category: 'control',
    partNumber: 'DS3231SN#',
    manufacturer: 'Analog Devices',
    rationale: 'Extremely accurate I2C real-time clock with integrated temperature-compensated crystal oscillator (TCXO, ±2ppm accuracy)',
    voltageV: 3.3,
    currentMa: 0.15,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Clocks & Timing',
    bomDescription: 'Extremely Accurate I2C-Integrated RTC/TCXO/Crystal SO-16',
    unitCostUsd: 3.9,
  },
  {
    id: 'eeprom_at24c256',
    label: 'I2C Serial EEPROM',
    sublabel: '256 Kbit Non-Volatile Memory',
    category: 'storage',
    partNumber: 'AT24C256C-SSHM-T',
    manufacturer: 'Microchip',
    rationale: '256-Kbit (32,768 x 8) I2C serial EEPROM with 1 million write cycle endurance for calibration data and device configuration',
    voltageV: 3.3,
    currentMa: 1.0,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Memory - EEPROM',
    bomDescription: '256-Kbit I2C Serial EEPROM 1MHz SOIC-8',
    unitCostUsd: 0.65,
  },
  {
    id: 'nor_flash_w25q128',
    label: 'SPI NOR Flash',
    sublabel: '128 Mbit Flash Memory',
    category: 'storage',
    partNumber: 'W25Q128JVSIS',
    manufacturer: 'Winbond',
    rationale: '128-Mbit serial NOR Flash memory supporting Quad-SPI at 133MHz for firmware OTA updates, asset storage, and logging',
    voltageV: 3.3,
    currentMa: 15.0,
    interfaces: ['SPI'],
    edgeType: 'spi',
    bomCategory: 'Memory - Flash',
    bomDescription: '128M-bit Serial Flash Memory with Dual/Quad SPI SOIC-8',
    unitCostUsd: 1.18,
  },

  // 7. Precision Analog Conversion & Temperature
  {
    id: 'adc_ads1115',
    label: '16-Bit Precision ADC',
    sublabel: '4-Channel Delta-Sigma ADC',
    category: 'sensing',
    partNumber: 'ADS1115IDGSR',
    manufacturer: 'Texas Instruments',
    rationale: 'Ultra-compact 16-bit precision ADC with internal low-drift reference, programmable gain amplifier, and oscillator',
    voltageV: 3.3,
    currentMa: 0.15,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Data Converters - ADC',
    bomDescription: '16-Bit ADC with Integrated MUX and PGA VSSOP-10',
    unitCostUsd: 2.45,
  },
  {
    id: 'dac_mcp4725',
    label: '12-Bit Digital-to-Analog',
    sublabel: 'I2C Voltage Output DAC',
    category: 'control',
    partNumber: 'MCP4725A0T-E/CH',
    manufacturer: 'Microchip',
    rationale: 'Low-power 12-bit buffered voltage output DAC with non-volatile EEPROM for setpoint generation and analog bias',
    voltageV: 3.3,
    currentMa: 0.21,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Data Converters - DAC',
    bomDescription: '12-Bit Voltage Output Digital-to-Analog Converter SOT-23-6',
    unitCostUsd: 0.95,
  },
  {
    id: 'rtd_max31865',
    label: 'RTD Temperature Converter',
    sublabel: 'PT100/PT1000 SPI Interface',
    category: 'sensing',
    partNumber: 'MAX31865ATP+',
    manufacturer: 'Analog Devices',
    rationale: '15-bit resistance-to-digital converter optimized for platinum resistance temperature detectors (PT100 to PT1000)',
    voltageV: 3.3,
    currentMa: 1.5,
    interfaces: ['SPI'],
    edgeType: 'spi',
    bomCategory: 'Sensors - Temperature',
    bomDescription: 'RTD-to-Digital SPI Converter for PT100/PT1000 TQFN-20',
    unitCostUsd: 4.85,
  },
  {
    id: 'temp_tmp117',
    label: 'High-Precision Temp Sensor',
    sublabel: 'Medical Grade ±0.1°C',
    category: 'sensing',
    partNumber: 'TMP117AIDRVR',
    manufacturer: 'Texas Instruments',
    rationale: 'Digital temperature sensor providing ±0.1°C accuracy across -20°C to +50°C meeting ASTM E1112 clinical standards',
    voltageV: 3.3,
    currentMa: 0.0035,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Sensors - Temperature',
    bomDescription: 'High-Accuracy Low-Power Digital Temp Sensor WSON-6',
    unitCostUsd: 1.9,
  },

  // 8. Actuation, Motor Drives & Power Switching
  {
    id: 'stepper_tmc2209',
    label: 'Silent Stepper Driver',
    sublabel: 'StealthChop2 & StallGuard4',
    category: 'motor',
    partNumber: 'TMC2209-LA',
    manufacturer: 'Trinamic / ADI',
    rationale: 'Ultra-silent motor driver IC for two-phase stepper motors up to 2A RMS with sensorless load detection and UART control',
    voltageV: 3.3,
    currentMa: 2.5,
    interfaces: ['UART', 'GPIO'],
    edgeType: 'uart',
    bomCategory: 'Motor Drivers',
    bomDescription: 'Silent Stepper Driver with StealthChop2 QFN-28',
    unitCostUsd: 2.65,
  },
  {
    id: 'motor_drv8833',
    label: 'Dual H-Bridge Motor Driver',
    sublabel: 'Low-Voltage DC Motor Driver',
    category: 'motor',
    partNumber: 'DRV8833PWP',
    manufacturer: 'Texas Instruments',
    rationale: 'Dual H-bridge driver capable of driving two DC motors or one bipolar stepper motor up to 1.5A per channel',
    voltageV: 3.3,
    currentMa: 1.7,
    interfaces: ['GPIO'],
    edgeType: 'gpio',
    bomCategory: 'Motor Drivers',
    bomDescription: 'Dual H-Bridge Motor Driver HTSSOP-16',
    unitCostUsd: 1.15,
  },
  {
    id: 'load_switch_tps22917',
    label: 'Ultra-Low Leakage Load Switch',
    sublabel: 'Power Gating Switch',
    category: 'power',
    partNumber: 'TPS22917DBVR',
    manufacturer: 'Texas Instruments',
    rationale: 'Ultra-low leakage 2A load switch with controlled slew-rate turn-on for peripheral power gating and standby current optimization',
    voltageV: 3.3,
    currentMa: 0.0005,
    interfaces: ['GPIO'],
    edgeType: 'gpio',
    bomCategory: 'Power Management - Switches',
    bomDescription: 'Ultra-Low Leakage 2A Load Switch SOT-23-6',
    unitCostUsd: 0.52,
  },
  {
    id: 'pwm_servo_pca9685',
    label: '16-Channel PWM Controller',
    sublabel: '12-Bit Servo/LED Driver',
    category: 'control',
    partNumber: 'PCA9685PW',
    manufacturer: 'NXP Semiconductors',
    rationale: '16-channel 12-bit PWM I2C-bus controller for driving RC servo motors and dimming high-brightness LEDs',
    voltageV: 3.3,
    currentMa: 2.0,
    interfaces: ['I2C'],
    edgeType: 'i2c',
    bomCategory: 'Drivers & Controllers',
    bomDescription: '16-Channel 12-bit PWM Fm+ I2C-Bus LED/Servo Driver TSSOP-28',
    unitCostUsd: 1.75,
  },

  // 9. Industrial Communications & Fieldbuses
  {
    id: 'isolated_rs485',
    label: 'Isolated RS-485 Transceiver',
    sublabel: '3000 Vrms Galvanic Isolation',
    category: 'connectivity',
    partNumber: 'ISO1500DBQR',
    manufacturer: 'Texas Instruments',
    rationale: 'Galvanically isolated 3.0kVrms half-duplex RS-485 transceiver with fail-safe receiver and ±16kV ESD protection',
    voltageV: 3.3,
    currentMa: 12.0,
    interfaces: ['UART'],
    edgeType: 'uart',
    bomCategory: 'Interface - RS-485',
    bomDescription: 'Isolated Half-Duplex RS-485 Transceiver SSOP-16',
    unitCostUsd: 3.1,
  },
  {
    id: 'can_fd_tcan1042',
    label: 'Fault-Protected CAN FD',
    sublabel: '5 Mbps CAN FD Transceiver',
    category: 'connectivity',
    partNumber: 'TCAN1042HVD',
    manufacturer: 'Texas Instruments',
    rationale: 'High-speed CAN transceiver supporting CAN FD data rates up to 5 Mbps with ±70V bus fault protection',
    voltageV: 3.3,
    currentMa: 10.0,
    interfaces: ['signal'],
    edgeType: 'signal',
    bomCategory: 'Interface - CAN Bus',
    bomDescription: 'Fault-Protected CAN FD Transceiver with Standby Mode SOIC-8',
    unitCostUsd: 1.1,
  },
  {
    id: 'spi_ethernet_w5500',
    label: 'Hardwired SPI Ethernet',
    sublabel: '10/100 TCP/IP Controller',
    category: 'connectivity',
    partNumber: 'W5500',
    manufacturer: 'WIZnet',
    rationale: 'Hardwired TCP/IP embedded Ethernet controller with integrated 10/100 Ethernet PHY and 8 independent hardware sockets',
    voltageV: 3.3,
    currentMa: 132.0,
    interfaces: ['SPI'],
    edgeType: 'spi',
    bomCategory: 'Networking - Ethernet',
    bomDescription: 'Hardwired TCP/IP SPI 10/100 Ethernet Controller LQFP-48',
    unitCostUsd: 4.6,
  },
  {
    id: 'lora_sx1262',
    label: 'Sub-GHz LoRa Transceiver',
    sublabel: '+22dBm Long Range RF',
    category: 'connectivity',
    partNumber: 'SX1262IMLTRT',
    manufacturer: 'Semtech',
    rationale: 'Sub-GHz long-range LoRa/FSK transceiver with up to +22dBm output power and -148dBm sensitivity for LoRaWAN connectivity',
    voltageV: 3.3,
    currentMa: 40.0,
    interfaces: ['SPI'],
    edgeType: 'spi',
    bomCategory: 'Wireless - LoRa',
    bomDescription: 'Long-Range Sub-GHz LoRa/FSK RF Transceiver QFN-24',
    unitCostUsd: 4.3,
  },
];

/** Detects if the prompt is asking to expand modules or add multiple components. */
export function isExpansionRequest(text: string): boolean {
  if (!text) return false;
  return (
    /(?:add|expand|include|scale|attach|connect|mount)\s+(?:(\d+)\s+)?(?:more\s+)?(modules|sensors|peripherals|nodes|ics|devices|components)/i.test(text) ||
    /\b(?:add|include)\s+(?:all\s+of\s+these|these|them|recommended(?:\s+modules|\s+sensors)?)\b/i.test(text) ||
    /\b(?:expand|scale)\s+(?:the\s+)?(?:system|architecture|design)\b/i.test(text)
  );
}

/** Extracts the requested number of expansion modules, defaulting to 10 and safely bounded. */
export function extractExpansionCount(text: string, defaultCount = 10): number {
  const match = text.match(
    /(?:add|expand|include|scale|attach)\s+(?:with\s+)?(?:by\s+)?(\d+)\s+(?:more\s+)?(?:modules|sensors|peripherals|nodes|ics|devices|components)?/i
  );
  if (match && match[1]) {
    const num = parseInt(match[1], 10);
    if (!isNaN(num) && num > 0) {
      return Math.min(Math.max(num, 1), 32);
    }
  }
  return defaultCount;
}

/**
 * Generates an expansion catalogue directive for Sol Tier gpt-4o prompt to guide deep LLM synthesis.
 */
export function getExpansionCataloguePrompt(requestedCount = 10): string {
  const summary = EXPANSION_CATALOGUE.slice(0, 24)
    .map(
      (c) =>
        `- ${c.label} (${c.partNumber}, ${c.manufacturer}): ${c.category}, ${c.interfaces.join('/')}, 3.3V, ${c.rationale}`
    )
    .join('\n');

  return `\nSYSTEM EXPANSION DIRECTIVE (Requested addition of ${requestedCount} modules):
The user requested adding ${requestedCount} modules/sensors to expand the hardware architecture.
You MUST expand the design by incorporating real, verified ICs (e.g. up to ${requestedCount} new nodes and matching BOM items) into the Canonical Design Graph.
Connect peripheral ICs via I2C, SPI, UART, or GPIO to the controller. If adding multiple I2C devices, include the TCA9548APWR I2C multiplexer to prevent address collisions.
Verified candidates from Embedo's hardware library to select from:
${summary}
Ensure every added component has a matching node in "nodes", a connecting bus edge in "edges", is added to "powerRails", and has a corresponding entry in "bom".\n`;
}

/**
 * Deterministic hardware expansion synthesizer.
 * Appends up to targetCount verified, non-duplicate real ICs from the production catalogue,
 * wiring them electrically and updating power rails, BOM, and engineering decisions.
 */
export function expandDesignGraphWithModules(
  baseline: CanonicalDesignGraph,
  targetCount = 10,
  _contextHint = ''
): CanonicalDesignGraph {
  const graph: CanonicalDesignGraph = structuredClone(baseline);

  // Find or resolve MCU node
  const mcu =
    graph.nodes.find((n) => n.category === 'control') ??
    graph.nodes.find((n) => n.id === 'mcu') ??
    graph.nodes[0];
  const mcuId = mcu ? mcu.id : 'mcu';

  const existingNodeIds = new Set(graph.nodes.map((n) => n.id.toLowerCase()));
  const existingParts = new Set(graph.nodes.map((n) => (n.partNumber ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')));
  const existingBomParts = new Set(graph.bom.map((b) => b.partNumber.toLowerCase().replace(/[^a-z0-9]/g, '')));

  // Identify primary 3.3V power rail or create one
  let rail3v3 = graph.powerRails.find((r) => r.voltageV === 3.3);
  if (!rail3v3) {
    if (graph.powerRails.length > 0) {
      rail3v3 = graph.powerRails[0];
    } else {
      rail3v3 = {
        name: '3V3',
        voltageV: 3.3,
        source: 'regulator',
        consumers: [mcuId],
      };
      graph.powerRails.push(rail3v3);
    }
  }

  // Filter candidates that are not already present in the baseline
  const availableCandidates = EXPANSION_CATALOGUE.filter((c) => {
    const normPart = c.partNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    return !existingNodeIds.has(c.id.toLowerCase()) && !existingParts.has(normPart);
  });

  const countToAdd = Math.min(targetCount, availableCandidates.length);
  const selected = availableCandidates.slice(0, countToAdd);

  if (selected.length === 0) {
    return graph;
  }

  // Check if I2C multiplexer is needed
  const i2cDevices = selected.filter((s) => s.interfaces.includes('I2C'));
  let muxId: string | null = null;
  if (i2cDevices.length >= 4 && !existingNodeIds.has('i2c_mux')) {
    const mux = selected.find((s) => s.id === 'i2c_mux');
    if (mux) {
      muxId = mux.id;
    }
  }

  const addedLabels: string[] = [];

  for (const item of selected) {
    // Generate unique node ID
    let nodeId = item.id;
    let counter = 1;
    while (existingNodeIds.has(nodeId)) {
      nodeId = `${item.id}_${counter++}`;
    }
    existingNodeIds.add(nodeId);

    const node: DesignNode = {
      id: nodeId,
      label: item.label,
      sublabel: item.sublabel,
      category: item.category,
      partNumber: item.partNumber,
      manufacturer: item.manufacturer,
      rationale: item.rationale,
      voltageV: item.voltageV,
      currentMa: item.currentMa,
      interfaces: [...item.interfaces],
    };
    graph.nodes.push(node);
    addedLabels.push(item.label);

    // Create edge: if item is an I2C device and mux is active (and item is not the mux itself), route via mux
    const fromId = muxId && item.id !== muxId && item.interfaces.includes('I2C') ? muxId : mcuId;
    const edge: DesignEdge = {
      from: fromId,
      to: nodeId,
      label: item.interfaces[0] || 'I2C',
      type: item.edgeType,
      busType: item.edgeType.toUpperCase(),
      dashed: false,
    };
    graph.edges.push(edge);

    // Power rail attachment
    if (rail3v3 && !rail3v3.consumers.includes(nodeId)) {
      rail3v3.consumers.push(nodeId);
    }

    // BOM item
    const normPart = item.partNumber.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!existingBomParts.has(normPart)) {
      const bomItem: BomItem = {
        partNumber: item.partNumber,
        manufacturer: item.manufacturer,
        category: item.bomCategory,
        description: item.bomDescription,
        qty: 1,
        unitCostUsd: item.unitCostUsd,
      };
      graph.bom.push(bomItem);
      existingBomParts.add(normPart);
    }
  }

  // Update engineering decisions
  const countStr = selected.length.toString();
  const sampleNames = selected.slice(0, 3).map((s) => s.partNumber).join(', ');
  const decisionText = `Expanded architecture with ${countStr} production-grade modules (${sampleNames}, etc.) covering environmental, motion, power telemetry, and industrial communication subsystems.`;
  graph.engineeringDecisions = [
    decisionText,
    ...(graph.engineeringDecisions || []).filter((d) => !d.startsWith('Expanded architecture')),
  ].slice(0, 5);

  // Update project tagline
  if (graph.projectMeta) {
    graph.projectMeta.tagline = `${graph.projectMeta.tagline || 'Embedded System'} (Expanded with ${countStr} modules)`;
  }

  return graph;
}
