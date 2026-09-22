import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const datasheetsToIngest = [
  {
    partNumber: 'ESP32-WROOM-32',
    manufacturer: 'Espressif Systems',
    category: 'Wi-Fi & Bluetooth MCU Module',
    datasheetUrl: 'https://documentation.espressif.com/esp32-wroom-32_datasheet_en.pdf',
    source: 'manual_ingestion',
    specs: {
      core: 'Dual-core Xtensa 32-bit LX6 MCU',
      clockFrequency: 'Up to 240 MHz',
      sram: '520 KB',
      flash: '4 MB / 8 MB / 16 MB SPI Flash',
      operatingVoltage: { min: 3.0, typ: 3.3, max: 3.6, unit: 'V' },
      operatingCurrent: { min: 80, max: 500, unit: 'mA' },
      operatingTemperature: { min: -40, max: 85, unit: '°C' },
      wireless: {
        wifi: '802.11 b/g/n (up to 150 Mbps)',
        bluetooth: 'v4.2 BR/EDR and BLE specifications',
      },
      peripherals: [
        'Capacitive touch sensors',
        'Hall sensor',
        'SD card interface',
        'Ethernet MAC',
        'High-speed SPI',
        'UART',
        'I2S',
        'I2C',
      ],
      pinCount: 38,
      package: 'SMD-38 Module',
      strappingPins: {
        GPIO0: 'HIGH: Normal Boot, LOW: UART Download Mode',
        GPIO2: 'Must be floating or LOW during download mode',
        GPIO12: 'VDD_SDIO voltage selection (0 for 3.3V, 1 for 1.8V)',
        GPIO15: 'Silent boot (HIGH suppresses boot messages)',
      },
      decouplingRecommendations: [
        '10 uF ceramic capacitor near 3V3 pin',
        '0.1 uF ceramic capacitor near 3V3 pin',
        '10 uF bulk electrolytic or tantalum at power entry',
      ],
    },
    chunks: [
      {
        pageNumber: 1,
        title: 'ESP32-WROOM-32 Overview and Key Features',
        chunkText:
          'ESP32-WROOM-32 is a powerful, generic Wi-Fi+BT+BLE MCU module that targets a wide variety of applications, ranging from low-power sensor networks to the most demanding tasks, such as voice encoding, music streaming and MP3 decoding. At the core of this module is the ESP32-D0WDQ6 chip.',
        metadata: { section: 'Overview', component: 'ESP32-WROOM-32' },
      },
      {
        pageNumber: 4,
        title: 'ESP32-WROOM-32 Pin Layout & Strapping Pins',
        chunkText:
          'ESP32 has 5 strapping pins: MTDI (GPIO12), GPIO0, GPIO2, MTDO (GPIO15), GPIO5. Software can read the values of these 5 bits from register GPIO_STRAPPING. During the chip’s system reset release, the latches sample the voltage levels on the strapping pins and store them until chip reset. For standard 3.3V flash boot: pull GPIO0 HIGH with 10k resistor, GPIO2 LOW or floating.',
        metadata: { section: 'Pin Definitions', component: 'ESP32-WROOM-32', topic: 'strapping' },
      },
      {
        pageNumber: 8,
        title: 'Power Scheme and Decoupling Capacitor Circuit Design',
        chunkText:
          'Power supply input voltage must be between 3.0 V and 3.6 V. Peak current during RF transmission bursts can reach 500 mA. A recommended power circuit includes an LDO capable of delivering at least 600 mA (e.g., AMS1117-3.3, AP2112K-3.3, or ME6211). Place a 10 μF filter capacitor in parallel with a 0.1 μF capacitor as close to the VDD33 pin as possible.',
        metadata: { section: 'Schematic Design Guidelines', component: 'ESP32-WROOM-32', topic: 'power_decoupling' },
      },
      {
        pageNumber: 12,
        title: 'Antenna Keepout and PCB Layout Rules',
        chunkText:
          'The module has an on-board PCB trace antenna. When placing the module on the baseboard, the area under and around the antenna must be free of copper traces, ground planes, or components on all layers. Minimum keepout distance is 15 mm from ground planes and metal enclosures.',
        metadata: { section: 'PCB Layout', component: 'ESP32-WROOM-32', topic: 'rf_layout' },
      },
    ],
    knowledge: [
      {
        sourceType: 'app_note',
        title: 'Espressif Hardware Design Guidelines: ESP32 Power Supply & Stability',
        chunkText:
          'When designing power for ESP32, high-frequency ripple on the 3.3V rail must not exceed 50 mV. An ESDA/TVS diode on USB VBUS is strongly recommended. EN (Chip Enable) pin should have an RC delay circuit (10 kΩ pull-up + 1 μF capacitor to GND) to guarantee clean power-on-reset after 3.3V rail stabilizes.',
        metadata: { verified: true, source: 'Espressif AppNote v3.2', tags: ['power', 'stability', 'reset_circuit'] },
      },
      {
        sourceType: 'forum',
        title: 'Community Best Practice: Preventing ESP32 Brownout Resets',
        chunkText:
          'Brownout resets on ESP32 during Wi-Fi connection attempts are almost always caused by inadequate decoupling capacitance or an LDO with high dropout voltage. Use an LDO rated for >= 600mA with <= 250mV dropout (e.g. AP2112K-3.3 instead of AMS1117 with 5V USB input drops) and ensure at least 22µF total capacitance on the 3.3V output rail.',
        metadata: { verified: true, source: 'ESP32 Community Discussions', tags: ['troubleshooting', 'brownout', 'ldo'] },
      },
    ],
  },
  {
    partNumber: 'ESP32-D0WD-V3',
    manufacturer: 'Espressif Systems',
    category: 'Wi-Fi & Bluetooth SoC IC',
    datasheetUrl: 'https://documentation.espressif.com/esp32_datasheet_en.pdf',
    source: 'manual_ingestion',
    specs: {
      core: 'Dual-core Xtensa 32-bit LX6 microprocessor',
      architecture: 'Harvard architecture with separate I & D buses',
      clockFrequency: 'Adjustable from 80 MHz to 240 MHz',
      sram: '520 KB internal SRAM',
      rom: '448 KB ROM for booting and core functions',
      operatingVoltage: { min: 2.3, typ: 3.3, max: 3.6, unit: 'V' },
      operatingTemperature: { min: -40, max: 125, unit: '°C' },
      package: 'QFN48 (5x5 mm / 6x6 mm)',
      analogFeatures: [
        '12-bit SAR ADC up to 18 channels',
        '2 x 8-bit DAC converters',
        '10 x capacitive touch sensors',
        'Ultra-low-power (ULP) co-processor',
      ],
      gpioCount: 36,
    },
    chunks: [
      {
        pageNumber: 1,
        title: 'ESP32 SoC Architecture and Dual Core Specifications',
        chunkText:
          'ESP32 is a single 2.4 GHz Wi-Fi-and-Bluetooth combo chip designed with TSMC ultra-low-power 40 nm technology. It is designed to achieve the best power and RF performance, robustness, versatility, and reliability in a wide variety of applications and power scenarios.',
        metadata: { section: 'Overview', component: 'ESP32-D0WD-V3' },
      },
      {
        pageNumber: 15,
        title: 'ADC and Analog Characteristics',
        chunkText:
          'ESP32 integrates two 12-bit SAR ADCs supporting a total of 18 measurement channels. ADC1 has 8 channels (GPIO32-GPIO39) and can be used while Wi-Fi is active. ADC2 has 10 channels (GPIO0, 2, 4, 12-15, 25-27) and has restricted availability when the Wi-Fi driver is transmitting.',
        metadata: { section: 'Analog Peripherals', component: 'ESP32-D0WD-V3', topic: 'adc' },
      },
    ],
    knowledge: [
      {
        sourceType: 'app_note',
        title: 'Analog Design Note: ADC2 and Wi-Fi Coexistence on ESP32',
        chunkText:
          'Important Hardware Guideline: When designing circuits with analog sensors requiring continuous sampling, assign sensors to ADC1 (GPIO32 through GPIO39). ADC2 pins cannot be sampled reliably while the Wi-Fi radio is active without software arbitration.',
        metadata: { verified: true, source: 'Espressif Technical Reference Manual', tags: ['analog', 'adc', 'pinout_planning'] },
      },
    ],
  },
];

async function main() {
  console.log('🚀 Starting Datasheet & Knowledge Ingestion for Espressif Links...\n');

  for (const item of datasheetsToIngest) {
    console.log(`📦 Ingesting Component: ${item.partNumber} (${item.manufacturer})...`);

    // 1. Upsert Component
    const component = await prisma.component.upsert({
      where: { partNumber: item.partNumber },
      update: {
        manufacturer: item.manufacturer,
        category: item.category,
        specs: item.specs,
        datasheetUrl: item.datasheetUrl,
        source: item.source,
        lastRefreshed: new Date(),
      },
      create: {
        partNumber: item.partNumber,
        manufacturer: item.manufacturer,
        category: item.category,
        specs: item.specs,
        datasheetUrl: item.datasheetUrl,
        source: item.source,
        lastRefreshed: new Date(),
      },
    });

    console.log(`  ✓ Component recorded with ID: ${component.id}`);

    // 2. Ingest Datasheet Chunks
    console.log(`  📄 Ingesting ${item.chunks.length} Datasheet Chunks...`);
    for (const chunk of item.chunks) {
      await prisma.datasheetChunk.create({
        data: {
          componentId: component.id,
          pageNumber: chunk.pageNumber,
          chunkText: `[${chunk.title}]\n${chunk.chunkText}`,
          chunkMetadata: chunk.metadata,
        },
      });
    }

    // 3. Ingest Knowledge Chunks (Application Notes & Forum Discussions)
    console.log(`  🧠 Ingesting ${item.knowledge.length} Knowledge Chunks (App Notes / Forum)...`);
    for (const k of item.knowledge) {
      await prisma.knowledgeChunk.create({
        data: {
          sourceType: k.sourceType,
          sourceUrl: item.datasheetUrl,
          title: k.title,
          chunkText: k.chunkText,
          chunkMetadata: k.metadata,
        },
      });
    }

    // 4. Create Audit Log
    await prisma.auditLog.create({
      data: {
        action: 'INGEST_DATASHEET_MANUAL',
        entityType: 'Component',
        entityId: component.id,
        metadata: {
          partNumber: item.partNumber,
          datasheetUrl: item.datasheetUrl,
          chunksIngested: item.chunks.length,
          knowledgeChunksIngested: item.knowledge.length,
          status: 'SUCCESS',
        },
      },
    });

    console.log(`  ✓ Audit log created for ${item.partNumber}\n`);
  }

  console.log('🎉 All datasheets and knowledge chunks successfully ingested into PostgreSQL!');
}

main()
  .catch((e) => {
    console.error('❌ Error during ingestion:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
