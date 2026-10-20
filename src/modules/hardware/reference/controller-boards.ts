import type { SourcedFacts } from '../discovery/hardware-sourcer.js';

/**
 * Reference pinouts for the dev boards briefs name most often.
 *
 * A controller sourced from AI product knowledge comes back with a handful of pins (prod,
 * 2026-10-16: a NUCLEO-H743 with 9 signal pins and one UART, a NUCLEO-F446RE with 8), so every
 * check after it fails on the record, not on the design. When the sourcer is asked for one of these
 * boards it uses this pinout instead of asking the model.
 *
 * Sources: the STM32 alternate functions are ST's pin data (generated into Zephyr's hal_stm32
 * pinctrl files); which header pins are free comes from each board's user manual and Zephyr board
 * file (ST-LINK virtual COM port, SWD, Ethernet RMII, USB, LEDs and crystals are left out). RP2040,
 * ESP32-S3, SAMD21 and ATmega328P maps follow the vendor datasheets and the boards' pinout pages.
 * ESP32-S3 routes its peripherals through a GPIO matrix: the pins here are the usual defaults.
 *
 * Pin domains: "3V3 FT" marks STM32 pins that are 5 V tolerant (digital-only pins; analog-capable
 * pins are left as plain 3V3 to stay on the safe side).
 */

export interface ReferenceBoard {
  /** Matched against the proposed product's name and SKU: this exact board only (a Feather RP2040 is not a Pico). */
  match: RegExp;
  facts: SourcedFacts;
  /** The documents the pinout is transcribed from, for the record's notes. */
  documentation: string;
  sourceUrl: string;
}

type Pin = SourcedFacts['pins'][number];

const power = (name: string, direction: 'power_in' | 'power_out', domain: string | null): Pin => ({
  name,
  signal_class: 'power',
  direction,
  voltage_domain: domain,
  functions: [],
});
const ground = (name = 'GND'): Pin => ({ name, signal_class: 'ground', direction: 'ground', voltage_domain: null, functions: [] });
const reserved = (name: string, signal_class: Pin['signal_class'], functions: string[] = []): Pin => ({
  name,
  signal_class,
  direction: 'input',
  voltage_domain: null,
  functions,
});
const io = (name: string, functions: string[], domain: string): Pin => ({
  name,
  signal_class: functions.some((f) => /^ADC/.test(f)) ? 'analog' : 'data',
  direction: 'bidirectional',
  voltage_domain: domain,
  functions,
});

/** Splits a long pin list into two edge headers (a record connector holds at most 48 contacts). */
const twoHeaders = (left: string[], right: string[], refs: [string, string]): SourcedFacts['connectors'] => [
  { ref: refs[0], kind: 'header', edge: 'left', pins: left },
  { ref: refs[1], kind: 'header', edge: 'right', pins: right },
];

// --- STM32 Nucleo ------------------------------------------------------------------------------------

/** NUCLEO-F446RE free header pins and their STM32F446RE alternate functions (ST pin data, via Zephyr hal_stm32). */
const F446RE_AF: Record<string, string[]> = {
  PA0: ['UART4_TX', 'ADC1_IN0', 'PWM2_CH1', 'PWM5_CH1'],
  PA1: ['UART4_RX', 'ADC1_IN1', 'PWM2_CH2', 'PWM5_CH2'],
  PA4: ['SPI1_NSS', 'SPI3_NSS', 'ADC1_IN4'],
  PB0: ['SPI3_MOSI', 'ADC1_IN8', 'PWM3_CH3'],
  PC1: ['SPI2_MOSI', 'SPI3_MOSI', 'ADC1_IN11'],
  PC0: ['ADC1_IN10'],
  PA10: ['UART1_RX', 'PWM1_CH3'],
  PB5: ['SPI1_MOSI', 'SPI3_MOSI', 'CAN2_RX', 'PWM3_CH2'],
  PB4: ['I2C3_SDA', 'SPI1_MISO', 'SPI2_NSS', 'SPI3_MISO', 'PWM3_CH1'],
  PB10: ['UART3_TX', 'I2C2_SCL', 'SPI2_SCK', 'PWM2_CH3'],
  PA8: ['I2C3_SCL', 'PWM1_CH1'],
  PA9: ['UART1_TX', 'SPI2_SCK', 'PWM1_CH2'],
  PC7: ['UART6_RX', 'SPI2_SCK', 'PWM3_CH2', 'PWM8_CH2'],
  PB6: ['UART1_TX', 'I2C1_SCL', 'CAN2_TX', 'PWM4_CH1'],
  PA7: ['SPI1_MOSI', 'ADC1_IN7', 'PWM14_CH1', 'PWM3_CH2'],
  PA6: ['SPI1_MISO', 'ADC1_IN6', 'PWM13_CH1', 'PWM3_CH1'],
  PA5: ['SPI1_SCK', 'ADC1_IN5', 'PWM2_CH1'],
  PB9: ['I2C1_SDA', 'SPI2_NSS', 'CAN1_TX', 'PWM11_CH1', 'PWM2_CH2'],
  PB8: ['I2C1_SCL', 'CAN1_RX', 'PWM10_CH1', 'PWM2_CH1'],
  PA11: ['CAN1_RX', 'PWM1_CH4'],
  PA12: ['CAN1_TX'],
  PA15: ['SPI1_NSS', 'SPI3_NSS', 'PWM2_CH1'],
  PB1: ['ADC1_IN9', 'PWM3_CH4'],
  PB12: ['SPI2_NSS', 'CAN2_RX'],
  PB13: ['SPI2_SCK', 'CAN2_TX'],
  PB14: ['SPI2_MISO', 'PWM12_CH1'],
  PB15: ['SPI2_MOSI', 'PWM12_CH2'],
  PC2: ['SPI2_MISO', 'ADC1_IN12'],
  PC3: ['SPI2_MOSI', 'ADC1_IN13'],
  PC4: ['ADC1_IN14'],
  PC5: ['UART3_RX', 'ADC1_IN15'],
  PC6: ['UART6_TX', 'PWM3_CH1', 'PWM8_CH1'],
  PC8: ['PWM3_CH3', 'PWM8_CH3'],
  PC9: ['I2C3_SDA', 'PWM3_CH4', 'PWM8_CH4'],
  PC10: ['UART3_TX', 'UART4_TX', 'SPI3_SCK'],
  PC11: ['UART3_RX', 'UART4_RX', 'SPI3_MISO'],
  PC12: ['UART5_TX', 'I2C2_SDA', 'SPI3_MOSI'],
  PD2: ['UART5_RX'],
};

/** NUCLEO-H743ZI2 free header pins and their STM32H743ZI alternate functions (same source). */
const H743ZI_AF: Record<string, string[]> = {
  PA3: ['UART2_RX', 'ADC1_IN15', 'PWM15_CH2', 'PWM2_CH4'],
  PC0: ['ADC1_IN10'],
  PC3: ['SPI2_MOSI', 'ADC3_IN1'],
  PB1: ['ADC1_IN5', 'PWM3_CH4'],
  PC2: ['SPI2_MISO', 'ADC3_IN0'],
  PF10: ['ADC3_IN6'],
  PB7: ['UART1_RX', 'I2C1_SDA', 'I2C4_SDA', 'PWM4_CH2'],
  PB6: ['UART1_TX', 'UART5_TX', 'I2C1_SCL', 'I2C4_SCL', 'CAN2_TX', 'PWM4_CH1'],
  PG14: ['UART6_TX', 'SPI6_MOSI'],
  PE13: ['SPI4_MISO', 'PWM1_CH3'],
  PE14: ['SPI4_MOSI', 'PWM1_CH4'],
  PE11: ['SPI4_NSS', 'PWM1_CH2'],
  PE9: ['PWM1_CH1'],
  PG12: ['SPI6_MISO'],
  PF3: ['ADC3_IN5'],
  PD15: ['PWM4_CH4'],
  PD14: ['PWM4_CH3'],
  PB5: ['UART5_RX', 'SPI1_MOSI', 'SPI3_MOSI', 'SPI6_MOSI', 'CAN2_RX', 'PWM3_CH2'],
  PA6: ['SPI1_MISO', 'SPI6_MISO', 'ADC1_IN3', 'PWM13_CH1', 'PWM3_CH1'],
  PA5: ['SPI1_SCK', 'SPI6_SCK', 'ADC1_IN19', 'PWM2_CH1'],
  PB9: ['UART4_TX', 'I2C1_SDA', 'I2C4_SDA', 'SPI2_NSS', 'CAN1_TX', 'PWM17_CH1', 'PWM4_CH4'],
  PB8: ['UART4_RX', 'I2C1_SCL', 'I2C4_SCL', 'CAN1_RX', 'PWM16_CH1', 'PWM4_CH3'],
  PA0: ['UART4_TX', 'ADC1_IN16', 'PWM2_CH1', 'PWM5_CH1'],
  PA4: ['SPI1_NSS', 'SPI3_NSS', 'SPI6_NSS', 'ADC1_IN18'],
  PA8: ['UART7_RX', 'I2C3_SCL', 'PWM1_CH1'],
  PA15: ['UART7_TX', 'SPI1_NSS', 'SPI3_NSS', 'SPI6_NSS', 'PWM2_CH1'],
  PB4: ['UART7_TX', 'SPI1_MISO', 'SPI2_NSS', 'SPI3_MISO', 'SPI6_MISO', 'PWM3_CH1'],
  PB10: ['UART3_TX', 'I2C2_SCL', 'SPI2_SCK', 'PWM2_CH3'],
  PB11: ['UART3_RX', 'I2C2_SDA', 'PWM2_CH4'],
  PB12: ['UART5_RX', 'SPI2_NSS', 'CAN2_RX'],
  PB15: ['UART1_RX', 'SPI2_MOSI', 'PWM12_CH2'],
  PC6: ['UART6_TX', 'PWM3_CH1', 'PWM8_CH1'],
  PC7: ['UART6_RX', 'PWM3_CH2', 'PWM8_CH2'],
  PC8: ['PWM3_CH3', 'PWM8_CH3'],
  PC9: ['I2C3_SDA', 'PWM3_CH4', 'PWM8_CH4'],
  PC10: ['UART3_TX', 'UART4_TX', 'SPI3_SCK'],
  PC11: ['UART3_RX', 'UART4_RX', 'SPI3_MISO'],
  PC12: ['UART5_TX', 'SPI3_MOSI'],
  PD0: ['UART4_RX', 'CAN1_RX'],
  PD1: ['UART4_TX', 'CAN1_TX'],
  PD2: ['UART5_RX'],
  PD3: ['SPI2_SCK'],
  PD4: [],
  PD5: ['UART2_TX'],
  PD6: ['UART2_RX', 'SPI3_MOSI'],
  PD7: ['SPI1_MOSI'],
  PD11: [],
  PD12: ['I2C4_SCL', 'PWM4_CH1'],
  PD13: ['I2C4_SDA', 'PWM4_CH2'],
  PE0: ['UART8_RX'],
  PE1: ['UART8_TX'],
  PE2: ['SPI4_SCK'],
  PE4: ['SPI4_NSS'],
  PE5: ['SPI4_MISO', 'PWM15_CH1'],
  PE6: ['SPI4_MOSI', 'PWM15_CH2'],
  PE7: ['UART7_RX'],
  PE8: ['UART7_TX'],
  PE12: ['SPI4_SCK'],
  PF0: ['I2C2_SDA'],
  PF1: ['I2C2_SCL'],
  PF4: ['ADC3_IN9'],
  PF5: ['ADC3_IN4'],
  PF6: ['UART7_RX', 'SPI5_NSS', 'ADC3_IN8', 'PWM16_CH1'],
  PF7: ['UART7_TX', 'SPI5_SCK', 'ADC3_IN3', 'PWM17_CH1'],
  PF8: ['SPI5_MISO', 'ADC3_IN7', 'PWM13_CH1'],
  PF9: ['SPI5_MOSI', 'ADC3_IN2', 'PWM14_CH1'],
  PF13: ['ADC2_IN2'],
  PF14: ['I2C4_SCL', 'ADC2_IN6'],
  PF15: ['I2C4_SDA'],
  PG9: ['UART6_RX', 'SPI1_MISO'],
  PG10: ['SPI1_NSS'],
};

/** STM32 pins with an analog function are TT_a/TC on some parts; only digital-only pins are marked 5 V tolerant. */
const stm32Pin = (name: string, af: string[]): Pin => io(name, af, af.some((f) => /^ADC/.test(f)) ? '3V3' : '3V3 FT');

const NUCLEO_POWER: Pin[] = [power('VIN', 'power_in', null), power('E5V', 'power_in', '5V'), power('5V', 'power_out', '5V'), power('3V3', 'power_out', '3V3'), ground()];
const NUCLEO_RAILS = [
  { rail_name: 'VIN', voltage_min_v: 7, voltage_max_v: 12 },
  { rail_name: 'E5V', voltage_min_v: 4.75, voltage_max_v: 5.25 },
];

function nucleo(table: Record<string, string[]>, opts: Pick<SourcedFacts, 'product_name' | 'vendor_sku' | 'main_silicon' | 'secondary_ics' | 'interfaces' | 'notes'>): SourcedFacts {
  const signals = Object.entries(table).map(([name, af]) => stm32Pin(name, af));
  const names = signals.map((p) => p.name);
  const half = Math.ceil(names.length / 2);
  return {
    product_name: opts.product_name,
    vendor: 'STMicroelectronics',
    vendor_sku: opts.vendor_sku,
    is_controller: true,
    functional_categories: ['Processing', 'Debug/Programming'],
    prototype_role: 'Main Controller',
    main_silicon: opts.main_silicon,
    secondary_ics: opts.secondary_ics,
    supply_voltage_min_v: 4.75,
    supply_voltage_max_v: 12,
    power_rails: NUCLEO_RAILS,
    logic_level_summary: '3.3 V logic; digital-only pins are 5 V tolerant (FT)',
    power_source_types: ['USB', 'VIN 7-12 V', 'E5V 5 V'],
    required_host_interfaces: [],
    host_requirement: 'standalone',
    pins: [...NUCLEO_POWER, ...signals],
    connectors: twoHeaders(['VIN', 'E5V', '5V', '3V3', 'GND', ...names.slice(0, half)], ['GND', ...names.slice(half)], ['CN7', 'CN10']),
    interfaces: opts.interfaces,
    required_accessories: [],
    notes: opts.notes,
    facts_source: 'vendor_page',
  };
}

const NUCLEO_F446RE: ReferenceBoard = {
  match: /nucleo[\s_-]*f446/i,
  documentation: 'ST UM1724 (STM32 Nucleo-64 user manual) and the STM32F446RE pin data',
  sourceUrl: 'https://www.st.com/en/evaluation-tools/nucleo-f446re.html',
  facts: nucleo(F446RE_AF, {
    product_name: 'NUCLEO-F446RE',
    vendor_sku: 'NUCLEO-F446RE',
    main_silicon: 'STM32F446RE',
    secondary_ics: ['ST-LINK/V2-1'],
    interfaces: [
      { type: 'I2C', role: 'controller', addresses: [], sda: 'PB9', scl: 'PB8' },
      { type: 'SPI', role: 'controller', addresses: [], sck: 'PA5', miso: 'PA6', mosi: 'PA7' },
      { type: 'UART', role: 'controller', addresses: [], tx: 'PA9', rx: 'PA10' },
      { type: 'CAN', role: 'controller', addresses: [], tx: 'PA12', rx: 'PA11' },
    ],
    notes: [
      'PA2/PA3 (USART2) are the ST-LINK virtual COM port; PA13/PA14 are SWD and PB3 is SWO: not offered for wiring.',
      'Power: VIN 7-12 V, or 5 V on E5V (jumper JP5 to E5V), or USB.',
      'CAN1/CAN2 are CAN controllers: a CAN bus also needs a transceiver.',
    ],
  }),
};

const NUCLEO_H743ZI2: ReferenceBoard = {
  match: /nucleo[\s_-]*h743|\bstm32h7\w*\b.*\bnucleo|\bnucleo\b.*\bstm32h7/i,
  documentation: 'ST UM2407 (STM32H7 Nucleo-144 user manual) and the STM32H743ZI pin data',
  sourceUrl: 'https://www.st.com/en/evaluation-tools/nucleo-h743zi.html',
  facts: nucleo(H743ZI_AF, {
    product_name: 'NUCLEO-H743ZI2',
    vendor_sku: 'NUCLEO-H743ZI2',
    main_silicon: 'STM32H743ZI',
    secondary_ics: ['ST-LINK/V3E'],
    interfaces: [
      { type: 'I2C', role: 'controller', addresses: [], sda: 'PB9', scl: 'PB8' },
      { type: 'SPI', role: 'controller', addresses: [], sck: 'PA5', miso: 'PA6', mosi: 'PB5' },
      { type: 'UART', role: 'controller', addresses: [], tx: 'PD5', rx: 'PD6' },
      { type: 'CAN', role: 'controller', addresses: [], tx: 'PD1', rx: 'PD0' },
    ],
    notes: [
      'USART3 (PD8/PD9) is the ST-LINK virtual COM port; Ethernet RMII, USB, SWD/SWO and LED pins (PB0, PB14) are not offered for wiring. PE1 (UART8 TX) also drives user LED LD2.',
      'Power: VIN 7-12 V, or 5 V on E5V, or USB.',
      'FDCAN1/FDCAN2 are CAN-FD controllers: a CAN bus also needs a transceiver.',
    ],
  }),
};

// --- Raspberry Pi Pico family (RP2040 / RP2350) -------------------------------------------------------

/** RP2040 GPIO functions on GP0-GP28 (datasheet function table F1-F4, plus the ADC inputs). */
function rp2040Functions(n: number): string[] {
  const block = n >> 2;
  const uart = ((block + 1) >> 1) & 1;
  const spi = (block >> 1) & 1;
  const out: string[] = [];
  if (n % 4 === 0) out.push(`UART${uart}_TX`);
  if (n % 4 === 1) out.push(`UART${uart}_RX`);
  out.push(`I2C${(n >> 1) & 1}_${n % 2 === 0 ? 'SDA' : 'SCL'}`);
  out.push(`SPI${spi}_${['MISO', 'NSS', 'SCK', 'MOSI'][n % 4]}`);
  if (n >= 26 && n <= 28) out.push(`ADC0_IN${n - 26}`);
  out.push(`PWM${(n >> 1) & 7}_${n % 2 === 0 ? 'A' : 'B'}`);
  return out;
}

function pico(product: string, silicon: string, wireless: boolean): SourcedFacts {
  const gp = (n: number) => io(`GP${n}`, rp2040Functions(n), '3V3');
  const header = [...Array.from({ length: 23 }, (_, n) => gp(n)), gp(26), gp(27), gp(28)];
  return {
    product_name: product,
    vendor: 'Raspberry Pi',
    vendor_sku: product.toUpperCase().replace(/\s+/g, '-'),
    is_controller: true,
    functional_categories: wireless ? ['Processing', 'Connectivity'] : ['Processing'],
    prototype_role: 'Main Controller',
    main_silicon: silicon,
    secondary_ics: wireless ? ['CYW43439 (Wi-Fi / Bluetooth)', 'RT6150 buck-boost'] : ['RT6150 buck-boost'],
    supply_voltage_min_v: 1.8,
    supply_voltage_max_v: 5.5,
    power_rails: [
      { rail_name: 'VSYS', voltage_min_v: 1.8, voltage_max_v: 5.5 },
      { rail_name: 'VBUS', voltage_min_v: 4.75, voltage_max_v: 5.25 },
    ],
    logic_level_summary: '3.3 V logic (not 5 V tolerant)',
    power_source_types: ['Micro-USB', 'VSYS 1.8-5.5 V'],
    required_host_interfaces: [],
    host_requirement: 'standalone',
    pins: [
      power('VBUS', 'power_in', '5V'),
      power('VSYS', 'power_in', null),
      power('3V3', 'power_out', '3V3'),
      reserved('3V3_EN', 'control'),
      reserved('RUN', 'control'),
      reserved('ADC_VREF', 'other'),
      ground('AGND'),
      ground(),
      ...header,
    ],
    connectors: twoHeaders(
      ['GP0', 'GP1', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND', 'GP6', 'GP7', 'GP8', 'GP9', 'GND', 'GP10', 'GP11', 'GP12', 'GP13', 'GND', 'GP14', 'GP15'],
      ['VBUS', 'VSYS', 'GND', '3V3_EN', '3V3', 'ADC_VREF', 'GP28', 'AGND', 'GP27', 'GP26', 'RUN', 'GP22', 'GND', 'GP21', 'GP20', 'GND', 'GP19', 'GP18', 'GND', 'GP17', 'GP16'],
      ['J1', 'J2']
    ),
    interfaces: [
      { type: 'I2C', role: 'controller', addresses: [], sda: 'GP4', scl: 'GP5' },
      { type: 'SPI', role: 'controller', addresses: [], sck: 'GP18', mosi: 'GP19', miso: 'GP16' },
      { type: 'UART', role: 'controller', addresses: [], tx: 'GP0', rx: 'GP1' },
    ],
    required_accessories: [],
    notes: [
      'Power from USB (VBUS), or 1.8-5.5 V on VSYS (e.g. a 1-cell LiPo through a Schottky diode). VBUS carries 5 V only while USB powers the board.',
      'GPIOs are 3.3 V only: 5 V signals need a divider or level shifter.',
    ],
    facts_source: 'vendor_page',
  };
}

const PICO_2: ReferenceBoard = {
  match: /raspberry\s*pi\s*pico\s*2\b/i,
  documentation: 'Raspberry Pi Pico 2 datasheet (pinout; RP2350 GPIO functions match RP2040 on GP0-GP28 for UART, I2C, SPI and PWM)',
  sourceUrl: 'https://www.raspberrypi.com/products/raspberry-pi-pico-2/',
  facts: pico('Raspberry Pi Pico 2', 'RP2350', false),
};
const PICO_W: ReferenceBoard = {
  match: /raspberry\s*pi\s*pico\s*wh?\b/i,
  documentation: 'Raspberry Pi Pico W datasheet and the RP2040 datasheet GPIO function table',
  sourceUrl: 'https://www.raspberrypi.com/products/raspberry-pi-pico/',
  facts: pico('Raspberry Pi Pico W', 'RP2040', true),
};
const PICO: ReferenceBoard = {
  match: /raspberry\s*pi\s*pico\b/i,
  documentation: 'Raspberry Pi Pico datasheet and the RP2040 datasheet GPIO function table',
  sourceUrl: 'https://www.raspberrypi.com/products/raspberry-pi-pico/',
  facts: pico('Raspberry Pi Pico', 'RP2040', false),
};

// --- ESP32-S3-DevKitC-1 ------------------------------------------------------------------------------

/** Default peripheral pins (ESP32-S3 routes UART/I2C/SPI/TWAI through its GPIO matrix). */
const ESP32S3_ROLES: Record<number, string[]> = {
  1: ['ADC1_IN0', 'PWM'],
  2: ['ADC1_IN1', 'PWM'],
  4: ['ADC1_IN3', 'PWM'],
  5: ['ADC1_IN4', 'PWM'],
  6: ['ADC1_IN5', 'PWM'],
  7: ['ADC1_IN6', 'PWM'],
  8: ['I2C0_SDA', 'ADC1_IN7', 'PWM'],
  9: ['I2C0_SCL', 'ADC1_IN8', 'PWM'],
  10: ['SPI2_NSS', 'ADC1_IN9', 'PWM'],
  11: ['SPI2_MOSI', 'PWM'],
  12: ['SPI2_SCK', 'PWM'],
  13: ['SPI2_MISO', 'PWM'],
  14: ['PWM'],
  15: ['UART2_TX', 'PWM'],
  16: ['UART2_RX', 'PWM'],
  17: ['UART1_TX', 'PWM'],
  18: ['UART1_RX', 'PWM'],
  21: ['PWM'],
  39: ['I2C1_SDA', 'PWM'],
  40: ['I2C1_SCL', 'PWM'],
  41: ['CAN0_TX', 'PWM'],
  42: ['CAN0_RX', 'PWM'],
  47: ['PWM'],
};
const esp32s3Pin = (n: number): Pin => {
  if ([0, 3, 45, 46].includes(n)) return reserved(`GPIO${n}`, 'control', ['STRAPPING']);
  if (n === 19 || n === 20) return reserved(`GPIO${n}`, 'control', [n === 19 ? 'USB_DM' : 'USB_DP']);
  if (n === 43 || n === 44) return reserved(`GPIO${n}`, 'debug', [n === 43 ? 'CONSOLE_TX' : 'CONSOLE_RX']);
  if (n >= 35 && n <= 37) return reserved(`GPIO${n}`, 'control', ['PSRAM']);
  if (n === 38 || n === 48) return reserved(`GPIO${n}`, 'control', ['RGB_LED']);
  return io(`GPIO${n}`, ESP32S3_ROLES[n] ?? ['PWM'], '3V3');
};
const ESP32S3_LEFT = [4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9, 10, 11, 12, 13, 14];
const ESP32S3_RIGHT = [43, 44, 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0, 45, 48, 47, 21, 20, 19];

const ESP32_S3_DEVKITC: ReferenceBoard = {
  match: /esp32[\s_-]*s3[\s_-]*devkit\s*-?c/i,
  documentation: 'Espressif ESP32-S3-DevKitC-1 user guide (header J1/J3) and the ESP32-S3 datasheet',
  sourceUrl: 'https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide.html',
  facts: {
    product_name: 'ESP32-S3-DevKitC-1',
    vendor: 'Espressif',
    vendor_sku: 'ESP32-S3-DEVKITC-1',
    is_controller: true,
    functional_categories: ['Processing', 'Connectivity'],
    prototype_role: 'Main Controller',
    main_silicon: 'ESP32-S3 (ESP32-S3-WROOM-1)',
    secondary_ics: ['CP2102N USB-UART bridge'],
    supply_voltage_min_v: 4.75,
    supply_voltage_max_v: 5.25,
    power_rails: [{ rail_name: '5V', voltage_min_v: 4.75, voltage_max_v: 5.25 }],
    logic_level_summary: '3.3 V logic (not 5 V tolerant)',
    power_source_types: ['USB', '5V pin'],
    required_host_interfaces: [],
    host_requirement: 'standalone',
    pins: [
      power('5V', 'power_in', '5V'),
      power('3V3', 'power_out', '3V3'),
      reserved('RST', 'control'),
      ground(),
      ...[...ESP32S3_LEFT, ...ESP32S3_RIGHT].map(esp32s3Pin),
    ],
    connectors: twoHeaders(
      ['3V3', '3V3', 'RST', ...ESP32S3_LEFT.map((n) => `GPIO${n}`), '5V', 'GND'],
      ['GND', ...ESP32S3_RIGHT.map((n) => `GPIO${n}`), 'GND', 'GND'],
      ['J1', 'J3']
    ),
    interfaces: [
      { type: 'I2C', role: 'controller', addresses: [], sda: 'GPIO8', scl: 'GPIO9' },
      { type: 'SPI', role: 'controller', addresses: [], sck: 'GPIO12', mosi: 'GPIO11', miso: 'GPIO13', cs: 'GPIO10' },
      { type: 'UART', role: 'controller', addresses: [], tx: 'GPIO17', rx: 'GPIO18' },
      { type: 'CAN', role: 'controller', addresses: [], tx: 'GPIO41', rx: 'GPIO42' },
    ],
    required_accessories: [],
    notes: [
      'UART, I2C, SPI and TWAI (CAN) can be routed to any free GPIO through the GPIO matrix; these are the default pins.',
      'Strapping (GPIO0/3/45/46), USB (GPIO19/20), console UART (GPIO43/44), octal PSRAM (GPIO35-37) and RGB LED (GPIO38/48) pins are not offered for wiring.',
      'Power from USB, or 5 V on the 5V pin. TWAI is a CAN controller: a CAN bus also needs a transceiver.',
    ],
    facts_source: 'vendor_page',
  },
};

// --- Arduino ---------------------------------------------------------------------------------------

const NANO_33_IOT: ReferenceBoard = {
  match: /nano\s*33\s*iot/i,
  documentation: 'Arduino Nano 33 IoT datasheet and pinout (ABX00027)',
  sourceUrl: 'https://docs.arduino.cc/hardware/nano-33-iot/',
  facts: {
    product_name: 'Arduino Nano 33 IoT',
    vendor: 'Arduino',
    vendor_sku: 'ABX00027',
    is_controller: true,
    functional_categories: ['Processing', 'Connectivity'],
    prototype_role: 'Main Controller',
    main_silicon: 'SAMD21G18A',
    secondary_ics: ['NINA-W102 (Wi-Fi / Bluetooth)', 'LSM6DS3 IMU', 'MPM3610 buck'],
    supply_voltage_min_v: 4.5,
    supply_voltage_max_v: 21,
    power_rails: [{ rail_name: 'VIN', voltage_min_v: 4.5, voltage_max_v: 21 }],
    logic_level_summary: '3.3 V logic (not 5 V tolerant)',
    power_source_types: ['Micro-USB', 'VIN 4.5-21 V'],
    required_host_interfaces: [],
    host_requirement: 'standalone',
    pins: [
      power('VIN', 'power_in', null),
      power('3V3', 'power_out', '3V3'),
      reserved('5V', 'other'),
      reserved('AREF', 'other'),
      reserved('RST', 'control'),
      ground(),
      io('D13', ['SPI0_SCK'], '3V3'),
      io('D12', ['SPI0_MISO', 'PWM'], '3V3'),
      io('D11', ['SPI0_MOSI', 'PWM'], '3V3'),
      io('D10', ['PWM'], '3V3'),
      io('D9', ['PWM'], '3V3'),
      io('D8', [], '3V3'),
      io('D7', [], '3V3'),
      io('D6', ['PWM'], '3V3'),
      io('D5', ['PWM'], '3V3'),
      io('D4', [], '3V3'),
      io('D3', ['PWM'], '3V3'),
      io('D2', ['PWM'], '3V3'),
      io('RX', ['UART1_RX'], '3V3'),
      io('TX', ['UART1_TX'], '3V3'),
      io('A0', ['ADC0_IN0'], '3V3'),
      io('A1', ['ADC0_IN1'], '3V3'),
      io('A2', ['ADC0_IN2', 'PWM'], '3V3'),
      io('A3', ['ADC0_IN3', 'PWM'], '3V3'),
      io('A4', ['I2C0_SDA', 'ADC0_IN4'], '3V3'),
      io('A5', ['I2C0_SCL', 'ADC0_IN5', 'PWM'], '3V3'),
      io('A6', ['ADC0_IN6'], '3V3'),
      io('A7', ['ADC0_IN7'], '3V3'),
    ],
    connectors: twoHeaders(
      ['D13', '3V3', 'AREF', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', '5V', 'RST', 'GND', 'VIN'],
      ['D12', 'D11', 'D10', 'D9', 'D8', 'D7', 'D6', 'D5', 'D4', 'D3', 'D2', 'GND', 'RST', 'RX', 'TX'],
      ['JP1', 'JP2']
    ),
    interfaces: [
      { type: 'I2C', role: 'controller', addresses: [], sda: 'A4', scl: 'A5' },
      { type: 'SPI', role: 'controller', addresses: [], sck: 'D13', mosi: 'D11', miso: 'D12' },
      { type: 'UART', role: 'controller', addresses: [], tx: 'TX', rx: 'RX' },
    ],
    required_accessories: [],
    notes: [
      'The 5V pin is not connected unless the VUSB jumper is closed, so it is not used as a supply.',
      'I/O is 3.3 V only: 5 V signals need a divider or level shifter.',
    ],
    facts_source: 'vendor_page',
  },
};

const UNO_R3: ReferenceBoard = {
  match: /arduino\s*uno(?!\s*r4)\b/i,
  documentation: 'Arduino UNO R3 datasheet and pinout (A000066)',
  sourceUrl: 'https://docs.arduino.cc/hardware/uno-rev3/',
  facts: {
    product_name: 'Arduino UNO R3',
    vendor: 'Arduino',
    vendor_sku: 'A000066',
    is_controller: true,
    functional_categories: ['Processing'],
    prototype_role: 'Main Controller',
    main_silicon: 'ATmega328P',
    secondary_ics: ['ATmega16U2 USB-serial'],
    supply_voltage_min_v: 7,
    supply_voltage_max_v: 12,
    power_rails: [{ rail_name: 'VIN', voltage_min_v: 7, voltage_max_v: 12 }],
    logic_level_summary: '5 V logic',
    power_source_types: ['USB', 'Barrel jack 7-12 V', 'VIN 7-12 V'],
    required_host_interfaces: [],
    host_requirement: 'standalone',
    pins: [
      power('VIN', 'power_in', null),
      power('5V', 'power_out', '5V'),
      power('3V3', 'power_out', '3V3'),
      reserved('IOREF', 'other'),
      reserved('RESET', 'control'),
      reserved('AREF', 'other'),
      ground(),
      io('A0', ['ADC0_IN0'], '5V'),
      io('A1', ['ADC0_IN1'], '5V'),
      io('A2', ['ADC0_IN2'], '5V'),
      io('A3', ['ADC0_IN3'], '5V'),
      io('A4', ['I2C0_SDA', 'ADC0_IN4'], '5V'),
      io('A5', ['I2C0_SCL', 'ADC0_IN5'], '5V'),
      io('D0', ['UART0_RX'], '5V'),
      io('D1', ['UART0_TX'], '5V'),
      io('D2', [], '5V'),
      io('D3', ['PWM'], '5V'),
      io('D4', [], '5V'),
      io('D5', ['PWM'], '5V'),
      io('D6', ['PWM'], '5V'),
      io('D7', [], '5V'),
      io('D8', [], '5V'),
      io('D9', ['PWM'], '5V'),
      io('D10', ['SPI0_NSS', 'PWM'], '5V'),
      io('D11', ['SPI0_MOSI', 'PWM'], '5V'),
      io('D12', ['SPI0_MISO'], '5V'),
      io('D13', ['SPI0_SCK'], '5V'),
    ],
    connectors: twoHeaders(
      ['IOREF', 'RESET', '3V3', '5V', 'GND', 'GND', 'VIN', 'A0', 'A1', 'A2', 'A3', 'A4', 'A5'],
      ['D0', 'D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8', 'D9', 'D10', 'D11', 'D12', 'D13', 'GND', 'AREF'],
      ['POWER', 'DIGITAL']
    ),
    interfaces: [
      { type: 'I2C', role: 'controller', addresses: [], sda: 'A4', scl: 'A5' },
      { type: 'SPI', role: 'controller', addresses: [], sck: 'D13', mosi: 'D11', miso: 'D12' },
      { type: 'UART', role: 'controller', addresses: [], tx: 'D1', rx: 'D0' },
    ],
    required_accessories: [],
    notes: ['D0/D1 are shared with the USB serial port: disconnect the module while uploading.', '5 V logic: 3.3 V modules need level shifting.'],
    facts_source: 'vendor_page',
  },
};

/** Most specific first (Pico 2 / Pico W before Pico). */
export const REFERENCE_BOARDS: ReferenceBoard[] = [NUCLEO_H743ZI2, NUCLEO_F446RE, PICO_2, PICO_W, PICO, ESP32_S3_DEVKITC, NANO_33_IOT, UNO_R3];

/** The reference pinout for a proposed controller, from its name and SKU; null when there is none. */
export function referenceBoardFor(product: { product_name: string; vendor_sku?: string | null }): ReferenceBoard | null {
  const text = [product.product_name, product.vendor_sku ?? ''].join(' ');
  return REFERENCE_BOARDS.find((b) => b.match.test(text)) ?? null;
}
