/**
 * Builds the test fixture Hardware Library in tests/fixtures/hardware-library/ (Drive layout:
 * HW-xxxx/HW-xxxx.{json,svg,asset.json}). The unit tests read it, and it can be uploaded to a dev
 * environment through the admin API — the server itself never reads hardware files from disk.
 *
 *   npm run hw:fixtures            then   npm run hw:upload -- --dir tests/fixtures/hardware-library --api <url>
 *
 * These are NOT reviewed library records. Every one is review_status=provisional,
 * verification_method=inferred, record_origin=admin_created, and is only searchable with
 * PROTOTYPE_ALLOW_PROVISIONAL=true. Ids use the HW-FXnn range so they can never collide with the
 * Drive library's HW-0001..HW-0100. Pin facts follow the vendors' published pinouts and the RP2040
 * GPIO function table; the SVGs follow the perimeter-v1 anchor contract (anchors outside the
 * outline, LEAD 20, pitch 22). Output is deterministic: re-running produces identical files.
 */
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BoardDef, buildRecord, buildSvg, PinDef } from '../../src/modules/hardware/discovery/record-builder.js';

// --- RP2040 GPIO function table (RP2040 datasheet §1.4.3) ----------------------------------------
function rp2040Functions(gpio: number): string[] {
  const spi = gpio < 8 || (gpio >= 16 && gpio < 24) ? 0 : 1;
  const spiRole = ['RX', 'CSN', 'SCK', 'TX'][gpio % 4];
  const uart = ((((gpio >> 2) + 1) >> 1) & 1) as 0 | 1;
  const uartRole = ['TX', 'RX', 'CTS', 'RTS'][gpio % 4];
  const i2c = (gpio >> 1) & 1;
  const fns = [
    `GPIO${gpio}`,
    `SPI${spi}_${spiRole}`,
    `UART${uart}_${uartRole}`,
    `I2C${i2c}_${gpio % 2 === 0 ? 'SDA' : 'SCL'}`,
    `PWM${(gpio >> 1) & 7}_${gpio % 2 === 0 ? 'A' : 'B'}`,
  ];
  if (gpio >= 26 && gpio <= 29) fns.push(`ADC${gpio - 26}`);
  return fns;
}

const gpioPin = (name: string, gpio: number): PinDef => ({
  name,
  cls: gpio >= 26 ? 'analog' : 'data',
  dir: 'bidirectional',
  domain: '3V3',
  functions: rp2040Functions(gpio),
});

const STEMMA_TYPE = 'stemma_qt_jst_sh_4pin_right_angle';

// --- boards ----------------------------------------------------------------------------------------
const pico: BoardDef = {
  id: 'HW-FX01',
  family: 'FAM-FX-RPI-PICO',
  name: 'Raspberry Pi Pico',
  vendor: 'Raspberry Pi',
  sku: 'SC0915',
  group: 'Controller Boards',
  categories: ['Processing'],
  role: 'Main Controller',
  silicon: 'RP2040',
  secondary: ['W25Q16JV (2 MB QSPI flash)', 'RT6150B (buck-boost SMPS)'],
  hostRequirement: 'standalone',
  requiredHostInterfaces: [],
  supply: [1.8, 5.5],
  logic: '3.3 V (not 5 V tolerant)',
  powerSources: ['usb', 'header_vsys'],
  rails: [{ rail_name: 'VSYS', voltage_min_v: 1.8, voltage_max_v: 5.5 }],
  pins: [
    ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 26, 27, 28].map((g) => gpioPin(`GP${g}`, g)),
    { name: 'GND', cls: 'ground', dir: 'ground', domain: '0V' },
    { name: 'AGND', cls: 'ground', dir: 'ground', domain: '0V' },
    { name: 'RUN', cls: 'control', dir: 'input', domain: '3V3', functions: ['RESET'] },
    { name: 'ADC_VREF', cls: 'analog', dir: 'input', domain: '3V3' },
    { name: '3V3', cls: 'power', dir: 'power_out', domain: '3V3' },
    { name: '3V3_EN', cls: 'control', dir: 'input', domain: '3V3' },
    { name: 'VSYS', cls: 'power', dir: 'power_in', domain: 'VSYS' },
    { name: 'VBUS', cls: 'power', dir: 'power_out', domain: '5V' },
    { name: 'SWCLK', cls: 'debug', dir: 'input', domain: '3V3', functions: ['SWD_CLK'] },
    { name: 'SWDIO', cls: 'debug', dir: 'bidirectional', domain: '3V3', functions: ['SWD_IO'] },
  ],
  connectors: [
    {
      ref: 'J1',
      type: 'castellated_header_1x20_2.54mm',
      mode: 'individual_contacts',
      edge: 'left',
      contacts: [
        ['1', 'GP0'], ['2', 'GP1'], ['3', 'GND'], ['4', 'GP2'], ['5', 'GP3'], ['6', 'GP4'], ['7', 'GP5'], ['8', 'GND'], ['9', 'GP6'], ['10', 'GP7'],
        ['11', 'GP8'], ['12', 'GP9'], ['13', 'GND'], ['14', 'GP10'], ['15', 'GP11'], ['16', 'GP12'], ['17', 'GP13'], ['18', 'GND'], ['19', 'GP14'], ['20', 'GP15'],
      ],
    },
    {
      ref: 'J2',
      type: 'castellated_header_1x20_2.54mm',
      mode: 'individual_contacts',
      edge: 'right',
      contacts: [
        ['40', 'VBUS'], ['39', 'VSYS'], ['38', 'GND'], ['37', '3V3_EN'], ['36', '3V3'], ['35', 'ADC_VREF'], ['34', 'GP28'], ['33', 'AGND'], ['32', 'GP27'], ['31', 'GP26'],
        ['30', 'RUN'], ['29', 'GP22'], ['28', 'GND'], ['27', 'GP21'], ['26', 'GP20'], ['25', 'GP19'], ['24', 'GP18'], ['23', 'GND'], ['22', 'GP17'], ['21', 'GP16'],
      ],
    },
    { ref: 'J3', type: 'debug_header_1x3_2.54mm', mode: 'individual_contacts', edge: 'bottom', contacts: [['1', 'SWCLK'], ['2', 'GND'], ['3', 'SWDIO']] },
  ],
  interfaces: [
    { type: 'I2C', details: { role: 'controller', sda_pin_id: 'GP4', scl_pin_id: 'GP5', note: 'Default I2C0 pins in Arduino-Pico and MicroPython; any SDA/SCL-capable pair works.' } },
    { type: 'SPI', details: { role: 'controller', sck_pin_id: 'GP18', mosi_pin_id: 'GP19', miso_pin_id: 'GP16', cs_pin_id: 'GP17' } },
    { type: 'UART', details: { role: 'controller', tx_pin_id: 'GP0', rx_pin_id: 'GP1' } },
    { type: 'USB', details: { role: 'device', connector: 'micro-USB' } },
  ],
  ecosystem: ['Breadboard 2.54mm'],
  sources: [
    { source_type: 'product_page', url: 'https://www.raspberrypi.com/products/raspberry-pi-pico/', official: true },
    { source_type: 'datasheet', url: 'https://datasheets.raspberrypi.com/pico/pico-datasheet.pdf', official: true },
  ],
  notes: ['GPIO is 3.3 V only. VBUS is 5 V only while USB is connected.'],
};

const qtPy: BoardDef = {
  id: 'HW-FX02',
  family: 'FAM-FX-ADAFRUIT-QTPY-RP2040',
  name: 'Adafruit QT Py RP2040',
  vendor: 'Adafruit',
  sku: '4900',
  group: 'Controller Boards',
  categories: ['Processing'],
  role: 'Main Controller',
  silicon: 'RP2040',
  secondary: ['8 MB QSPI flash', 'AP2112K-3.3 (3.3 V LDO)', 'NeoPixel RGB LED'],
  hostRequirement: 'standalone',
  requiredHostInterfaces: [],
  supply: [3.5, 5.5],
  logic: '3.3 V (not 5 V tolerant)',
  powerSources: ['usb_c', 'header_5v'],
  rails: [{ rail_name: '5V', voltage_min_v: 3.5, voltage_max_v: 5.5 }],
  pins: [
    gpioPin('A0', 29), gpioPin('A1', 28), gpioPin('A2', 27), gpioPin('A3', 26),
    gpioPin('SDA', 24), gpioPin('SCL', 25), gpioPin('TX', 20),
    { name: '5V', cls: 'power', dir: 'power_out', domain: '5V' },
    { name: 'GND', cls: 'ground', dir: 'ground', domain: '0V' },
    { name: '3V', cls: 'power', dir: 'power_out', domain: '3V3' },
    gpioPin('MO', 3), gpioPin('MI', 4), gpioPin('SCK', 6), gpioPin('RX', 5),
    gpioPin('SDA1', 22), gpioPin('SCL1', 23),
  ],
  connectors: [
    { ref: 'JP1', type: 'castellated_header_1x7_2.54mm', mode: 'individual_contacts', edge: 'left', contacts: [['1', 'A0'], ['2', 'A1'], ['3', 'A2'], ['4', 'A3'], ['5', 'SDA'], ['6', 'SCL'], ['7', 'TX']] },
    { ref: 'JP2', type: 'castellated_header_1x7_2.54mm', mode: 'individual_contacts', edge: 'right', contacts: [['1', '5V'], ['2', 'GND'], ['3', '3V'], ['4', 'MO'], ['5', 'MI'], ['6', 'SCK'], ['7', 'RX']] },
    { ref: 'CONN1', type: STEMMA_TYPE, mode: 'whole_connector', edge: 'bottom', contacts: [['1', 'GND'], ['2', '3V'], ['3', 'SDA1'], ['4', 'SCL1']] },
  ],
  interfaces: [
    { type: 'STEMMA QT', details: { role: 'controller', sda_pin_id: 'SDA1', scl_pin_id: 'SCL1', connectors: ['CONN1'], voltage: '3V3', note: 'STEMMA QT is on I2C1 (Wire1 in Arduino).' } },
    { type: 'I2C', details: { role: 'controller', sda_pin_id: 'SDA1', scl_pin_id: 'SCL1', exposed_on: ['CONN1'] } },
    { type: 'SPI', details: { role: 'controller', sck_pin_id: 'SCK', mosi_pin_id: 'MO', miso_pin_id: 'MI' } },
    { type: 'UART', details: { role: 'controller', tx_pin_id: 'TX', rx_pin_id: 'RX' } },
  ],
  ecosystem: ['STEMMA QT', 'Qwiic', 'QT Py', 'Breadboard 2.54mm'],
  sources: [{ source_type: 'product_page', url: 'https://www.adafruit.com/product/4900', official: true }],
  notes: ['The STEMMA QT port is I2C1 (SDA1/SCL1), separate from the SDA/SCL header pins (I2C0).'],
};

const bme280: BoardDef = {
  id: 'HW-FX03',
  family: 'FAM-FX-ADAFRUIT-BME280-STEMMA-QT',
  name: 'Adafruit BME280 I2C or SPI Temperature Humidity Pressure Sensor - STEMMA QT',
  vendor: 'Adafruit',
  sku: '2652',
  group: 'Sensor Breakouts',
  categories: ['Sensing'],
  role: 'Temperature / humidity / pressure sensing',
  silicon: 'BME280',
  secondary: ['AP2112K-3.3 (3.3 V LDO)', 'BSS138 dual N-FET level shifter (SCL/SDA)'],
  hostRequirement: 'host_required',
  requiredHostInterfaces: ['I2C or SPI'],
  supply: [3.0, 5.0],
  logic: '3-5V (level shifted)',
  powerSources: ['header_vin', 'stemma_qt'],
  // Deliberately the seed library's string form (plan C2): the importer flags it, the runtime uses supply_voltage_*.
  rails: ['3.0-5.0 V on VIN'],
  pins: [
    { name: 'VIN', cls: 'power', dir: 'power_in', domain: 'VIN' },
    { name: '3Vo', cls: 'power', dir: 'power_out', domain: '3V3' },
    { name: 'GND', cls: 'ground', dir: 'ground', domain: '0V' },
    { name: 'SCK', cls: 'data', dir: 'input', domain: 'VIN', functions: ['I2C_SCL', 'SPI_SCK'] },
    { name: 'SDO', cls: 'data', dir: 'output', domain: '3V3', functions: ['SPI_MISO', 'I2C_ADDR_SELECT'] },
    { name: 'SDI', cls: 'data', dir: 'bidirectional', domain: 'VIN', functions: ['I2C_SDA', 'SPI_MOSI'] },
    { name: 'CS', cls: 'data', dir: 'input', domain: 'VIN', functions: ['SPI_CS'] },
  ],
  connectors: [
    { ref: 'JP1', type: 'pin_header_1x7_2.54mm', mode: 'individual_contacts', edge: 'bottom', contacts: [['1', 'VIN'], ['2', '3Vo'], ['3', 'GND'], ['4', 'SCK'], ['5', 'SDO'], ['6', 'SDI'], ['7', 'CS']] },
    { ref: 'CONN4', type: STEMMA_TYPE, mode: 'whole_connector', edge: 'left', contacts: [['1', 'GND'], ['2', 'VIN'], ['3', 'SDI'], ['4', 'SCK']] },
    { ref: 'CONN3', type: STEMMA_TYPE, mode: 'whole_connector', edge: 'right', contacts: [['1', 'GND'], ['2', 'VIN'], ['3', 'SDI'], ['4', 'SCK']] },
  ],
  interfaces: [
    {
      type: 'I2C',
      addresses: ['0x77', '0x76'],
      details: { role: 'target', sda_pin_id: 'SDI', scl_pin_id: 'SCK', exposed_on: ['JP1', 'CONN3', 'CONN4'], default_address: '0x77', alt_address: '0x76 (SDO to GND)', pullups: '10k on board' },
    },
    { type: 'SPI', details: { role: 'peripheral', sck_pin_id: 'SCK', mosi_pin_id: 'SDI', miso_pin_id: 'SDO', cs_pin_id: 'CS' } },
    { type: 'STEMMA QT', details: { connectors: ['CONN3', 'CONN4'], voltage: 'VIN' } },
  ],
  ecosystem: ['STEMMA QT', 'Qwiic', 'Breadboard 2.54mm'],
  sources: [{ source_type: 'product_page', url: 'https://www.adafruit.com/product/2652', official: true }],
  notes: ['Works on 3.3 V and 5 V hosts; SCK/SDI/CS follow VIN through the level shifter. SDO is not level shifted.'],
};

const gps: BoardDef = {
  id: 'HW-FX04',
  family: 'FAM-FX-ADAFRUIT-ULTIMATE-GPS',
  name: 'Adafruit Ultimate GPS Breakout v3',
  vendor: 'Adafruit',
  sku: '746',
  group: 'Connectivity Breakouts',
  categories: ['Sensing', 'Connectivity'],
  role: 'GNSS position and time',
  silicon: 'MTK3339 (PA1616S module)',
  secondary: ['3.3 V regulator', 'CR1220 backup battery holder'],
  hostRequirement: 'host_required',
  requiredHostInterfaces: ['UART'],
  supply: [3.3, 5.0],
  logic: '3.3 V output, 5 V safe input',
  powerSources: ['header_vin'],
  rails: [{ rail_name: 'VIN', voltage_min_v: 3.3, voltage_max_v: 5.0 }],
  pins: [
    { name: '3.3V', cls: 'power', dir: 'power_out', domain: '3V3' },
    { name: 'EN', cls: 'control', dir: 'input', domain: '3V3' },
    { name: 'VBAT', cls: 'power', dir: 'power_in', domain: 'VBAT' },
    { name: 'FIX', cls: 'data', dir: 'output', domain: '3V3' },
    { name: 'TX', cls: 'data', dir: 'output', domain: '3V3', functions: ['UART_TX'] },
    { name: 'RX', cls: 'data', dir: 'input', domain: '3V3', functions: ['UART_RX'] },
    { name: 'GND', cls: 'ground', dir: 'ground', domain: '0V' },
    { name: 'VIN', cls: 'power', dir: 'power_in', domain: 'VIN' },
    { name: 'PPS', cls: 'data', dir: 'output', domain: '3V3' },
  ],
  connectors: [
    { ref: 'JP1', type: 'pin_header_1x9_2.54mm', mode: 'individual_contacts', edge: 'bottom', contacts: [['1', '3.3V'], ['2', 'EN'], ['3', 'VBAT'], ['4', 'FIX'], ['5', 'TX'], ['6', 'RX'], ['7', 'GND'], ['8', 'VIN'], ['9', 'PPS']] },
  ],
  interfaces: [{ type: 'UART', details: { role: 'peripheral', tx_pin_id: 'TX', rx_pin_id: 'RX', default_baud: 9600, protocol: 'NMEA 0183' } }],
  ecosystem: ['Breadboard 2.54mm'],
  sources: [{ source_type: 'product_page', url: 'https://www.adafruit.com/product/746', official: true }],
  notes: ['Built-in patch antenna; u.FL connector for an external active antenna. TX is the module output.'],
};

const microSd: BoardDef = {
  id: 'HW-FX05',
  family: 'FAM-FX-ADAFRUIT-MICROSD-BREAKOUT',
  name: 'Adafruit MicroSD card breakout board+',
  vendor: 'Adafruit',
  sku: '254',
  group: 'Storage Breakouts',
  categories: ['Storage'],
  role: 'microSD card storage (SPI)',
  silicon: 'microSD socket',
  secondary: ['3.3 V regulator', '74LVC125 level shifter'],
  hostRequirement: 'host_required',
  requiredHostInterfaces: ['SPI'],
  supply: [4.5, 5.5],
  logic: '3-5V (level shifted)',
  powerSources: ['header_5v'],
  rails: [{ rail_name: '5V', voltage_min_v: 4.5, voltage_max_v: 5.5 }],
  pins: [
    { name: '5V', cls: 'power', dir: 'power_in', domain: '5V' },
    { name: '3v', cls: 'power', dir: 'power_out', domain: '3V3' },
    { name: 'GND', cls: 'ground', dir: 'ground', domain: '0V' },
    { name: 'CLK', cls: 'data', dir: 'input', domain: '3V3', functions: ['SPI_SCK'] },
    { name: 'DO', cls: 'data', dir: 'output', domain: '3V3', functions: ['SPI_MISO'] },
    { name: 'DI', cls: 'data', dir: 'input', domain: '3V3', functions: ['SPI_MOSI'] },
    { name: 'CS', cls: 'data', dir: 'input', domain: '3V3', functions: ['SPI_CS'] },
    { name: 'CD', cls: 'data', dir: 'output', domain: '3V3', functions: ['CARD_DETECT'] },
  ],
  connectors: [
    { ref: 'JP1', type: 'pin_header_1x8_2.54mm', mode: 'individual_contacts', edge: 'bottom', contacts: [['1', '5V'], ['2', '3v'], ['3', 'GND'], ['4', 'CLK'], ['5', 'DO'], ['6', 'DI'], ['7', 'CS'], ['8', 'CD']] },
  ],
  interfaces: [{ type: 'SPI', details: { role: 'peripheral', sck_pin_id: 'CLK', mosi_pin_id: 'DI', miso_pin_id: 'DO', cs_pin_id: 'CS' } }],
  ecosystem: ['Breadboard 2.54mm'],
  sources: [{ source_type: 'product_page', url: 'https://www.adafruit.com/product/254', official: true }],
  accessories: ['a microSD card (FAT16/FAT32)'],
};

const BOARDS = [pico, qtPy, bme280, gps, microSd];

async function main() {
  const outDir = path.resolve(process.argv[2] ?? 'tests/fixtures/hardware-library');
  await fs.mkdir(outDir, { recursive: true });
  for (const b of BOARDS) {
    const dir = path.join(outDir, b.id);
    await fs.mkdir(dir, { recursive: true });
    const record = buildRecord(b);
    const { svg, anchors } = buildSvg(b);
    const asset = {
      hardware_entity_id: b.id,
      file_name: `${b.id}.svg`,
      storage_path: `/modules/${b.id}.svg`,
      build_status: 'complete',
      validation_status: 'passed',
      anchor_ids: anchors,
      generation_source_hash: `sha256:${crypto.createHash('sha256').update(svg).digest('hex')}`,
      generated_at: null,
      approved_by: null,
      approved_at: null,
      artwork_original: true,
    };
    await fs.writeFile(path.join(dir, `${b.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    await fs.writeFile(path.join(dir, `${b.id}.svg`), svg);
    await fs.writeFile(path.join(dir, `${b.id}.asset.json`), `${JSON.stringify(asset, null, 2)}\n`);
    console.log(`✓ ${b.id} ${b.name} (${record.pins.length} pins, ${anchors.length} anchors)`);
  }
  await fs.writeFile(
    path.join(outDir, 'README.md'),
    [
      '# Test fixture Hardware Library',
      '',
      'Generated by `npm run hw:fixtures` (scripts/hardware/build-fixtures.ts). Do not edit by hand.',
      '',
      'Five provisional, unreviewed boards (HW-FX01..HW-FX05) in the Drive library layout, used by the',
      'unit tests. Not deployed. To load them into a dev environment, upload them through the admin API',
      '(they are only searchable with `PROTOTYPE_ALLOW_PROVISIONAL=true`):',
      '',
      '    EMBEDO_ADMIN_TOKEN=<admin JWT> npm run hw:upload -- --dir tests/fixtures/hardware-library --api https://dev-api.embedo.ai/api/v1',
      '',
    ].join('\n')
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
