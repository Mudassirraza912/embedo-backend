/**
 * 7-bit I2C addresses of common sensor and peripheral chips, from their datasheets.
 *
 * Sourced records take addresses from AI product knowledge or page text, and get them wrong (prod,
 * 2026-10-16: a BMP390 recorded at 0x44, the SHT31's address, so the bench "failed" on a clash that
 * does not exist; a BME688 at 0x76 where Adafruit's board defaults to 0x77). A chip's possible
 * addresses are fixed by its silicon; which one a breakout uses by default depends on the board, so
 * a record's default is kept when it is one of the chip's addresses, unless the vendor's default is
 * known.
 */

export interface ChipAddresses {
  chip: string;
  match: RegExp;
  /** Every address the chip can take, most common breakout default first. */
  addresses: string[];
  /** Defaults that differ by vendor (Pimoroni ships its BME680/688 at 0x76). */
  vendorDefault?: Array<[RegExp, string]>;
  /** The pin that selects an address, and the level each address needs. */
  strap?: { pin: RegExp; levels: Record<string, 'GND' | 'VCC'> };
}

const range = (from: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) => `0x${(from + i).toString(16).toUpperCase().padStart(2, '0')}`);

const BOSCH_ENV: ChipAddresses['strap'] = { pin: /^(SDO|SDO\/ADR|ADR|SA0)$/i, levels: { '0x76': 'GND', '0x77': 'VCC' } };

export const CHIP_ADDRESSES: ChipAddresses[] = [
  { chip: 'SHT3x', match: /\bSHT3[015](?:-D|-DIS)?\b/i, addresses: ['0x44', '0x45'], strap: { pin: /^(ADDR|ADR|AD)$/i, levels: { '0x44': 'GND', '0x45': 'VCC' } } },
  { chip: 'SHT4x', match: /\bSHT4[015]\b/i, addresses: ['0x44'] },
  { chip: 'SHTC3', match: /\bSHTC3\b/i, addresses: ['0x70'] },
  { chip: 'SCD4x', match: /\bSCD4[01]\b/i, addresses: ['0x62'] },
  { chip: 'SCD30', match: /\bSCD30\b/i, addresses: ['0x61'] },
  { chip: 'BMP58x', match: /\bBMP58[01]\b/i, addresses: ['0x47', '0x46'], strap: { pin: /^(SDO|ADR)$/i, levels: { '0x46': 'GND', '0x47': 'VCC' } } },
  {
    chip: 'BME/BMP 2xx-6xx',
    match: /\bBM[EP](?:280|388|390|680|688)\b/i,
    addresses: ['0x77', '0x76'],
    // Adafruit and SparkFun pull SDO high (0x77); Pimoroni pulls it low.
    vendorDefault: [[/pimoroni/i, '0x76'], [/adafruit|sparkfun/i, '0x77']],
    strap: BOSCH_ENV,
  },
  { chip: 'BMP180', match: /\bBMP(?:180|085)\b/i, addresses: ['0x77'] },
  { chip: 'DPS310 / MS5611', match: /\bDPS310\b|\bMS56(?:07|11)\b/i, addresses: ['0x77', '0x76'], strap: BOSCH_ENV },
  { chip: 'LPS2x', match: /\bLPS2[25]/i, addresses: ['0x5D', '0x5C'], strap: { pin: /^(SDO|SA0)$/i, levels: { '0x5C': 'GND', '0x5D': 'VCC' } } },
  { chip: 'VEML7700', match: /\bVEML77\d0\b/i, addresses: ['0x10'] },
  { chip: 'VEML6075', match: /\bVEML6075\b/i, addresses: ['0x10'] },
  { chip: 'TSL2591', match: /\bTSL2591\b/i, addresses: ['0x29'] },
  { chip: 'TSL2561', match: /\bTSL256[01]\b/i, addresses: ['0x39', '0x29', '0x49'] },
  { chip: 'BH1750', match: /\bBH1750/i, addresses: ['0x23', '0x5C'], strap: { pin: /^(ADDR|ADD|ADO)$/i, levels: { '0x23': 'GND', '0x5C': 'VCC' } } },
  { chip: 'LTR-390', match: /\bLTR-?390/i, addresses: ['0x53'] },
  { chip: 'APDS-9960 / AS7341', match: /\bAPDS-?9960\b|\bAS7341\b/i, addresses: ['0x39'] },
  { chip: 'SSD1306 / SH110x', match: /\bSSD1306\b|\bSH110[67]\b/i, addresses: ['0x3C', '0x3D'] },
  { chip: 'MPU-6050 / ICM / BMI', match: /\bMPU-?(?:6050|6500|9250|9255)\b|\bICM-?(?:20948|20649|20602|42605|42670|42688)(?:-P)?\b|\bBMI(?:088|160|270)\b/i, addresses: ['0x68', '0x69'], strap: { pin: /^(AD0|ADO|SDO|SDO\/AD0|SA0)$/i, levels: { '0x68': 'GND', '0x69': 'VCC' } } },
  { chip: 'LSM6DSx', match: /\bLSM6DS/i, addresses: ['0x6A', '0x6B'], strap: { pin: /^(SDO|SA0|DO)$/i, levels: { '0x6A': 'GND', '0x6B': 'VCC' } } },
  { chip: 'LIS3MDL', match: /\bLIS3MDL\b/i, addresses: ['0x1C', '0x1E'], strap: { pin: /^(SDO|SA1|DO)$/i, levels: { '0x1C': 'GND', '0x1E': 'VCC' } } },
  { chip: 'LIS2MDL', match: /\bLIS2MDL\b/i, addresses: ['0x1E'] },
  { chip: 'LIS3DH', match: /\bLIS3DH\b/i, addresses: ['0x18', '0x19'], strap: { pin: /^(SDO|SA0|DO)$/i, levels: { '0x18': 'GND', '0x19': 'VCC' } } },
  { chip: 'ADXL34x', match: /\bADXL34[35]\b/i, addresses: ['0x53', '0x1D'], strap: { pin: /^(SDO|ALT ?ADDR(?:ESS)?|ALT)$/i, levels: { '0x53': 'GND', '0x1D': 'VCC' } } },
  { chip: 'BNO055', match: /\bBNO055\b/i, addresses: ['0x28', '0x29'], strap: { pin: /^(ADR|ADDR|COM3)$/i, levels: { '0x28': 'GND', '0x29': 'VCC' } } },
  { chip: 'BNO08x', match: /\bBNO0(?:80|85|86)\b/i, addresses: ['0x4A', '0x4B'], vendorDefault: [[/sparkfun/i, '0x4B']], strap: { pin: /^(DI|SA0|ADR)$/i, levels: { '0x4A': 'GND', '0x4B': 'VCC' } } },
  { chip: 'QMC5883L', match: /\bQMC5883/i, addresses: ['0x0D'] },
  { chip: 'HMC5883L', match: /\bHMC5883/i, addresses: ['0x1E'] },
  { chip: 'MAX3010x', match: /\bMAX3010[025]\b/i, addresses: ['0x57'] },
  { chip: 'MLX90614', match: /\bMLX90614\b/i, addresses: ['0x5A'] },
  { chip: 'MLX90640', match: /\bMLX90640\b/i, addresses: ['0x33'] },
  { chip: 'AMG88xx', match: /\bAMG88/i, addresses: ['0x69', '0x68'] },
  { chip: 'INA219/INA226/INA260', match: /\bINA2(?:19|26|28|60)\b/i, addresses: range(0x40, 16) },
  { chip: 'INA3221', match: /\bINA3221\b/i, addresses: range(0x40, 4) },
  { chip: 'ADS1x15', match: /\bADS1[01]1[3-5]\b/i, addresses: range(0x48, 4), strap: { pin: /^(ADDR|ADR)$/i, levels: { '0x48': 'GND', '0x49': 'VCC' } } },
  { chip: 'TMP102/TMP117', match: /\bTMP1(?:02|17)\b/i, addresses: range(0x48, 4), strap: { pin: /^(ADD0|ADDR|A0)$/i, levels: { '0x48': 'GND', '0x49': 'VCC' } } },
  { chip: 'MCP9808', match: /\bMCP9808\b/i, addresses: range(0x18, 8) },
  { chip: 'AHT1x/2x', match: /\bAHT(?:10|15|20|21|25)\b/i, addresses: ['0x38'] },
  { chip: 'HTU21D / Si70xx / HDC1080', match: /\bHTU2[01]D?\b|\bSI70(?:13|20|21)\b|\bHDC10[78]0\b/i, addresses: ['0x40'] },
  { chip: 'SGP30', match: /\bSGP30\b/i, addresses: ['0x58'] },
  { chip: 'SGP40/41', match: /\bSGP4[01]\b/i, addresses: ['0x59'] },
  { chip: 'ENS160', match: /\bENS160\b/i, addresses: ['0x53', '0x52'] },
  { chip: 'CCS811', match: /\bCCS811\b/i, addresses: ['0x5A', '0x5B'] },
  { chip: 'SEN5x / SPS30', match: /\bSEN5[045]\b|\bSPS30\b/i, addresses: ['0x69'] },
  { chip: 'PMSA003I', match: /\bPMSA003I\b/i, addresses: ['0x12'] },
  { chip: 'VL53Lx / VL6180X', match: /\bVL53L[014]|\bVL6180/i, addresses: ['0x29'] },
  { chip: 'DS3231 / DS1307 / PCF8523', match: /\bDS3231\b|\bDS1307\b|\bPCF8523\b/i, addresses: ['0x68'] },
  { chip: 'PCF8563', match: /\bPCF8563\b/i, addresses: ['0x51'] },
  { chip: 'MAX1704x', match: /\bMAX1704[389]\b/i, addresses: ['0x36'] },
  { chip: 'LC709203F', match: /\bLC709203/i, addresses: ['0x0B'] },
  { chip: 'AS5600', match: /\bAS5600\b/i, addresses: ['0x36'] },
  { chip: 'MCP4725', match: /\bMCP4725\b/i, addresses: ['0x62', '0x63'] },
  { chip: 'PCA9685', match: /\bPCA9685\b/i, addresses: range(0x40, 8) },
  { chip: 'TCA9548A', match: /\b[TP]CA9548A?\b/i, addresses: range(0x70, 8) },
  { chip: 'MCP23008/17', match: /\bMCP230(?:08|17)\b/i, addresses: range(0x20, 8) },
  { chip: 'PCF8574A', match: /\bPCF8574A\b/i, addresses: range(0x38, 8) },
  { chip: 'PCF8574', match: /\bPCF8574(?!A)/i, addresses: ['0x27', ...range(0x20, 7)] },
  { chip: 'MPR121', match: /\bMPR121\b/i, addresses: range(0x5a, 4) },
  { chip: 'DRV2605', match: /\bDRV2605/i, addresses: ['0x5A'] },
  { chip: 'Si5351', match: /\bSI5351/i, addresses: ['0x60'] },
  { chip: 'ATECC608', match: /\bATECC608/i, addresses: ['0x60'] },
  { chip: 'VCNL4040', match: /\bVCNL40[24]0\b/i, addresses: ['0x60'] },
];

export interface AddressFacts {
  chip: string;
  addresses: string[];
  strap: ChipAddresses['strap'] | null;
}

const norm = (a: string) => `0x${a.replace(/^0x/i, '').toUpperCase().padStart(2, '0')}`;

/**
 * A module's addresses: the chip's set when its silicon is known (the record's default first if it
 * is one of them, else the vendor's default), otherwise the record's own list. Null for an
 * unknown chip with no recorded address.
 */
export function addressesFor(record: { identity: { main_silicon?: string | null; product_name: string; vendor: string }; interfaces: { interfaces: Array<{ type: string; addresses: string[]; details?: unknown }> } }): AddressFacts | null {
  const iface = record.interfaces.interfaces.find((i) => /I2C|STEMMA|QWIIC/i.test(i.type));
  const details = (iface?.details ?? {}) as Record<string, unknown>;
  const recorded = [
    ...(typeof details['default_address'] === 'string' ? [details['default_address']] : []),
    ...(iface?.addresses ?? []),
  ]
    .filter((a) => /^0x[0-7][0-9a-f]$/i.test(a))
    .map(norm);
  const text = `${record.identity.main_silicon ?? ''} ${record.identity.product_name}`;
  const chip = CHIP_ADDRESSES.find((c) => c.match.test(text));
  if (!chip) return recorded.length > 0 ? { chip: record.identity.main_silicon ?? record.identity.product_name, addresses: [...new Set(recorded)], strap: null } : null;
  const vendorDefault = chip.vendorDefault?.find(([re]) => re.test(record.identity.vendor))?.[1];
  // A vendor's known default beats a recorded one (records often come from AI product knowledge).
  const first = vendorDefault ?? recorded.find((a) => chip.addresses.includes(a)) ?? chip.addresses[0]!;
  return { chip: chip.chip, addresses: [first, ...chip.addresses.filter((a) => a !== first)], strap: chip.strap ?? null };
}
