import { ingestJsonBodySchema } from '../../src/modules/admin/admin.validation.js';

describe('JSON knowledge ingestion request validation', () => {
  it('accepts a named JSON file payload, including structured arrays', () => {
    expect(ingestJsonBodySchema.safeParse({
      filename: 'component-catalog.json',
      content: [{ partNumber: 'INA219', voltage: '3.3 V' }],
    }).success).toBe(true);
  });

  it('rejects missing filenames and non-JSON filenames', () => {
    expect(ingestJsonBodySchema.safeParse({ content: { key: 'value' } }).success).toBe(false);
    expect(ingestJsonBodySchema.safeParse({ filename: 'notes.txt', content: {} }).success).toBe(false);
    expect(ingestJsonBodySchema.safeParse({ filename: 'empty.json' }).success).toBe(false);
  });
});
