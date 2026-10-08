export interface JsonKnowledgeChunk {
  text: string;
  firstRecord: number;
  lastRecord: number;
  recordCount: number;
}

interface JsonKnowledgeRecord {
  path: string;
  value: unknown;
  documentContext?: Record<string, unknown>;
}

export const JSON_KNOWLEDGE_CHUNK_SIZE = 6_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function extractRecords(content: unknown): JsonKnowledgeRecord[] {
  if (Array.isArray(content)) {
    return content.map((value, index) => ({ path: `[${index}]`, value }));
  }

  if (!isRecord(content)) {
    return [{ path: 'document', value: content }];
  }

  const collections = Object.entries(content).filter(([, value]) => Array.isArray(value) && value.length > 0);
  if (collections.length > 0) {
    const documentContext = Object.fromEntries(
      Object.entries(content).filter(([, value]) => !Array.isArray(value))
    );
    return collections.flatMap(([key, values]) =>
      (values as unknown[]).map((value, index) => ({
        path: `${key}[${index}]`,
        value,
        ...(Object.keys(documentContext).length > 0 ? { documentContext } : {}),
      }))
    );
  }

  const entries = Object.entries(content);
  if (entries.length > 1 && entries.every(([, value]) => isRecord(value))) {
    return entries.map(([key, value]) => ({ path: key, value }));
  }

  return [{ path: 'document', value: content }];
}

/**
 * Group complete JSON records into embedding chunks. A record is never split across chunks;
 * oversized individual records are rejected rather than silently indexed as partial components.
 */
export function chunkJsonKnowledge(
  filename: string,
  content: unknown,
  maxChunkSize = JSON_KNOWLEDGE_CHUNK_SIZE
): JsonKnowledgeChunk[] {
  const records = extractRecords(content);
  const chunks: JsonKnowledgeChunk[] = [];
  let text = '';
  let firstRecord = 1;
  let lastRecord = 0;
  let recordCount = 0;

  const flush = () => {
    if (!text) return;
    chunks.push({ text, firstRecord, lastRecord, recordCount });
    text = '';
    recordCount = 0;
  };

  records.forEach((record, index) => {
    const context = record.documentContext
      ? `\nDocument context: ${JSON.stringify(record.documentContext)}`
      : '';
    const formatted = `File: ${filename}\nRecord: ${record.path}${context}\n${JSON.stringify(record.value)}`;
    if (formatted.length > maxChunkSize) {
      throw new RangeError(
        `JSON record "${record.path}" is ${formatted.length} characters; the maximum complete-record chunk size is ${maxChunkSize}`
      );
    }

    const separator = text ? '\n\n' : '';
    if (text.length + separator.length + formatted.length > maxChunkSize) flush();

    if (!text) firstRecord = index + 1;
    text = text ? `${text}\n\n${formatted}` : formatted;
    lastRecord = index + 1;
    recordCount += 1;
  });

  flush();
  return chunks;
}
