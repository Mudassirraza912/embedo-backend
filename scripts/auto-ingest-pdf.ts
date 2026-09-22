import { datasheetIngestionService } from '../src/modules/components/datasheet-ingestion.service.js';
import { prisma } from '../src/db/prisma.js';

const urls = [
  'https://documentation.espressif.com/esp32-wroom-32_datasheet_en.pdf',
  'https://documentation.espressif.com/esp32_datasheet_en.pdf',
];

async function main() {
  console.log('🤖 Starting LIVE Automated PDF Scraping & Vector Ingestion...\n');

  for (const url of urls) {
    console.log(`🌐 Fetching & Scraping live PDF: ${url}`);
    const result = await datasheetIngestionService.ingestFromUrl(url);

    console.log(`\n✅ Successfully Ingested Component from Live PDF!`);
    console.log(`   - Part Number:    ${result.partNumber}`);
    console.log(`   - Manufacturer:   ${result.manufacturer}`);
    console.log(`   - Total Pages:    ${result.totalPages}`);
    console.log(`   - Vector Chunks:  ${result.chunksIngested}`);
    console.log(`   - Duration:       ${(result.durationMs / 1000).toFixed(2)}s\n`);
    console.log('------------------------------------------------------------\n');
  }
}

main()
  .catch((err) => {
    console.error('❌ Ingestion Error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
