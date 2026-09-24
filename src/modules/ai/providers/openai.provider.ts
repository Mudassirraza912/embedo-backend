import OpenAI from 'openai';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { GenerateOptions, GenerateResult, EmbedBatchResult, ProviderError, classifyProviderError, StreamOptions } from './types.js';

export const OPENAI_EMBEDDING_MODEL = 'text-embedding-3-small';
export const OPENAI_EMBEDDING_DIMENSIONS = 1536;
/** OpenAI accepts up to 2048 inputs per embeddings request; keep batches modest for latency. */
const EMBED_BATCH_SIZE = 64;

export class OpenAiProvider {
  private client: OpenAI | null = null;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.client = new OpenAI({
        apiKey: env.OPENAI_API_KEY,
        timeout: 45_000,
        maxRetries: 1,
      });
    }
  }

  get isConfigured(): boolean {
    return this.client !== null;
  }

  private requireClient(): OpenAI {
    if (!this.client) {
      throw new ProviderError('openai', 'auth', 'OPENAI_API_KEY is not configured');
    }
    return this.client;
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    const client = this.requireClient();
    const start = Date.now();

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    for (const msg of options.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }

    try {
      const response = await client.chat.completions.create(
        {
          model: options.model || 'gpt-4o',
          messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 4096,
          ...(options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
        },
        options.timeoutMs ? { timeout: options.timeoutMs } : undefined
      );

      const latencyMs = Date.now() - start;
      const text = response.choices[0]?.message?.content || '';
      const inputTokens = response.usage?.prompt_tokens || 0;
      const outputTokens = response.usage?.completion_tokens || 0;
      const cachedTokens = response.usage?.prompt_tokens_details?.cached_tokens ?? undefined;

      logger.debug({ model: options.model, inputTokens, outputTokens, cachedTokens, latencyMs }, 'OpenAI message generated');

      return { text, inputTokens, outputTokens, cachedTokens, latencyMs };
    } catch (err) {
      throw classifyProviderError('openai', err);
    }
  }

  /**
   * Same as generate(), but invokes onDelta for each chunk so the caller can push text to the
   * client while the model is still writing. Usage is requested via stream_options so the
   * ai_calls ledger still gets real token counts.
   */
  async generateStream(options: StreamOptions): Promise<GenerateResult> {
    const client = this.requireClient();
    const start = Date.now();
    let firstTokenMs: number | undefined;

    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (options.systemPrompt) {
      messages.push({ role: 'system', content: options.systemPrompt });
    }
    for (const msg of options.messages) {
      messages.push({ role: msg.role, content: msg.content });
    }

    try {
      const stream = await client.chat.completions.create(
        {
          model: options.model || 'gpt-4o',
          messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 4096,
          ...(options.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        options.timeoutMs ? { timeout: options.timeoutMs } : undefined
      );

      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens: number | undefined;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          if (firstTokenMs === undefined) firstTokenMs = Date.now() - start;
          text += delta;
          options.onDelta(delta, { firstTokenMs });
        }
        // The final chunk carries usage when stream_options.include_usage is set.
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || 0;
          cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined;
        }
      }

      const latencyMs = Date.now() - start;
      logger.debug({ model: options.model, inputTokens, outputTokens, firstTokenMs, latencyMs }, 'OpenAI stream completed');

      return { text, inputTokens, outputTokens, cachedTokens, latencyMs };
    } catch (err) {
      throw classifyProviderError('openai', err);
    }
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    const embedding = result.embeddings[0];
    if (!embedding) {
      throw new ProviderError('openai', 'server', 'OpenAI embedding response was empty');
    }
    return embedding;
  }

  async embedBatch(texts: string[]): Promise<EmbedBatchResult> {
    const client = this.requireClient();
    const start = Date.now();
    const embeddings: number[][] = [];
    let totalTokens = 0;

    try {
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
        const response = await client.embeddings.create({
          model: OPENAI_EMBEDDING_MODEL,
          input: batch,
          dimensions: OPENAI_EMBEDDING_DIMENSIONS,
        });
        // The API returns items with an `index` field; order by it to be safe.
        const ordered = [...response.data].sort((a, b) => a.index - b.index);
        if (ordered.length !== batch.length) {
          throw new ProviderError('openai', 'server', `Embedding batch size mismatch (${ordered.length}/${batch.length})`);
        }
        for (const item of ordered) embeddings.push(item.embedding);
        totalTokens += response.usage?.total_tokens ?? 0;
      }
    } catch (err) {
      throw classifyProviderError('openai', err);
    }

    return { embeddings, totalTokens, latencyMs: Date.now() - start };
  }

  /** OpenAI moderation endpoint (free). Returns null only when the client is not configured. */
  async moderate(text: string): Promise<{ flagged: boolean; categories: string[] } | null> {
    if (!this.client) return null;
    try {
      const response = await this.client.moderations.create({ input: text });
      const result = response.results[0];
      if (!result) return { flagged: false, categories: [] };
      const categories = Object.entries(result.categories)
        .filter(([, v]) => v)
        .map(([k]) => k);
      return { flagged: Boolean(result.flagged), categories };
    } catch (err) {
      throw classifyProviderError('openai', err);
    }
  }
}
