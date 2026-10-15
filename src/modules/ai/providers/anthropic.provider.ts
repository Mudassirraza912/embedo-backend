import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';

import { GenerateOptions, GenerateResult, ProviderError, StreamOptions, classifyProviderError } from './types.js';
export type { GenerateOptions, GenerateResult, StreamOptions } from './types.js';

export class AnthropicProvider {
  private client: Anthropic | null = null;

  constructor() {
    if (env.ANTHROPIC_API_KEY) {
      this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    }
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    if (!this.client) {
      throw new ProviderError('anthropic', 'auth', 'ANTHROPIC_API_KEY is not configured');
    }

    const start = Date.now();

    let response: Awaited<ReturnType<Anthropic['messages']['create']>>;
    try {
      response = await this.client.messages.create(
        {
          model: options.model || 'claude-3-5-sonnet-20241022',
          system: options.systemPrompt,
          messages: options.messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 4096,
        },
        { timeout: options.timeoutMs ?? 180_000, maxRetries: 2 }
      );
    } catch (err) {
      throw classifyProviderError('anthropic', err);
    }
    if (!('content' in response)) {
      throw new ProviderError('anthropic', 'unknown', 'Unexpected streaming response from Anthropic');
    }

    const latencyMs = Date.now() - start;

    const text = response.content
      .filter((block) => block.type === 'text')
      .map((block) => ('text' in block ? block.text : ''))
      .join('\n');

    logger.debug(
      { model: options.model, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, latencyMs },
      'Anthropic message generated'
    );

    return {
      text,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      latencyMs,
    };
  }

  async generateStream(options: StreamOptions): Promise<GenerateResult> {
    if (!this.client) {
      throw new ProviderError('anthropic', 'auth', 'ANTHROPIC_API_KEY is not configured');
    }

    const start = Date.now();
    let firstTokenMs: number | undefined;
    let text = '';
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      const stream = this.client.messages.stream(
        {
          model: options.model || 'claude-haiku-4-5-20251001',
          system: options.systemPrompt,
          messages: options.messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens ?? 4096,
        },
        { timeout: options.timeoutMs ?? 180_000 }
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && (event.delta as { type?: string; text?: string }).type === 'text_delta') {
          const deltaText = (event.delta as { text: string }).text;
          if (firstTokenMs === undefined) firstTokenMs = Date.now() - start;
          text += deltaText;
          options.onDelta(deltaText, { firstTokenMs });
        }
      }

      const finalMsg = await stream.finalMessage();
      inputTokens = finalMsg.usage.input_tokens;
      outputTokens = finalMsg.usage.output_tokens;
      const latencyMs = Date.now() - start;

      logger.debug(
        { model: options.model, inputTokens, outputTokens, firstTokenMs, latencyMs },
        'Anthropic stream completed'
      );

      return { text, inputTokens, outputTokens, latencyMs };
    } catch (err) {
      throw classifyProviderError('anthropic', err);
    }
  }
}
