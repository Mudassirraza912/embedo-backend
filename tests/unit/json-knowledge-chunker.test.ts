import { describe, expect, it } from '@jest/globals';
import { chunkJsonKnowledge } from '../../src/modules/admin/json-knowledge-chunker.js';

describe('chunkJsonKnowledge', () => {
  it('keeps complete array records together and groups multiple records within chunk limits', () => {
    const records = [
      { partNumber: 'PART-A', description: 'a'.repeat(300) },
      { partNumber: 'PART-B', description: 'b'.repeat(300) },
      { partNumber: 'PART-C', description: 'c'.repeat(300) },
    ];

    const chunks = chunkJsonKnowledge('parts.json', { components: records }, 800);

    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => [chunk.firstRecord, chunk.lastRecord, chunk.recordCount])).toEqual([
      [1, 2, 2],
      [3, 3, 1],
    ]);
    expect(chunks[0]?.text).toContain('"partNumber":"PART-A"');
    expect(chunks[0]?.text).toContain('"partNumber":"PART-B"');
    expect(chunks[0]?.text).not.toContain('"partNumber":"PART-C"');
    expect(chunks[1]?.text).toContain('"partNumber":"PART-C"');
  });

  it('retains document-level metadata alongside each complete record', () => {
    const chunks = chunkJsonKnowledge('parts.json', {
      manufacturer: 'Example Semiconductor',
      components: [{ partNumber: 'PART-A' }, { partNumber: 'PART-B' }],
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text.match(/Example Semiconductor/g)).toHaveLength(2);
  });

  it('rejects an individual record too large to embed atomically', () => {
    expect(() =>
      chunkJsonKnowledge('parts.json', { components: [{ partNumber: 'TOO-LARGE', details: 'x'.repeat(1000) }] }, 500)
    ).toThrow(/components\[0\].*maximum complete-record chunk size/);
  });
});
