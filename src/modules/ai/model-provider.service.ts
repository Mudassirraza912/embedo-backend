import { AnthropicProvider } from './providers/anthropic.provider.js';
import { OpenAiProvider } from './providers/openai.provider.js';
import { GoogleProvider } from './providers/google.provider.js';
import { GenerateOptions, GenerateResult, EmbedBatchResult, ProviderError, StreamOptions } from './providers/types.js';
import { AppError } from '../../common/errors/AppError.js';
import { logger } from '../../config/logger.js';

export type { GenerateOptions, GenerateResult, EmbedBatchResult } from './providers/types.js';
export { ProviderError } from './providers/types.js';

/**
 * The ONLY entry point to AI vendors. Nothing outside modules/ai may import a provider SDK.
 * Provider errors are classified (ProviderError) so callers can apply Rule #8:
 *   rate limit -> backoff, server error -> surface, invalid request -> do not retry.
 */
export class ModelProviderService {
  private anthropic = new AnthropicProvider();
  private openai = new OpenAiProvider();
  private google = new GoogleProvider();

  async generate(providerName: string, options: GenerateOptions): Promise<GenerateResult> {
    try {
      switch (providerName.toLowerCase()) {
        case 'anthropic':
          return await this.anthropic.generate(options);
        case 'openai':
          return await this.openai.generate(options);
        case 'google':
          return await this.google.generate(options);
        default:
          throw new AppError(500, 'INTERNAL_SERVER_ERROR', `Unsupported model provider: ${providerName}`);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      const perr = err instanceof ProviderError ? err : new ProviderError(providerName, 'unknown', (err as Error).message);
      logger.error({ provider: providerName, kind: perr.kind, status: perr.status, err: perr.message }, 'Model generation failed');
      throw perr;
    }
  }

  /**
   * Streaming generation. Only OpenAI implements it today; anything else transparently falls back
   * to a single non-streaming call whose whole text is delivered as one delta, so callers never
   * have to branch on provider capability.
   */
  async generateStream(providerName: string, options: StreamOptions): Promise<GenerateResult> {
    try {
      if (providerName.toLowerCase() === 'openai') {
        return await this.openai.generateStream(options);
      }
      const { onDelta, ...rest } = options;
      const result = await this.generate(providerName, rest);
      onDelta(result.text, { firstTokenMs: result.latencyMs });
      return result;
    } catch (err) {
      if (err instanceof AppError) throw err;
      const perr = err instanceof ProviderError ? err : new ProviderError(providerName, 'unknown', (err as Error).message);
      logger.error({ provider: providerName, kind: perr.kind, status: perr.status, err: perr.message }, 'Model streaming failed');
      throw perr;
    }
  }

  async embed(text: string): Promise<number[]> {
    return this.openai.embed(text);
  }

  async embedBatch(texts: string[]): Promise<EmbedBatchResult> {
    return this.openai.embedBatch(texts);
  }

  /** Returns null when no moderation-capable provider is configured. */
  async moderate(text: string): Promise<{ flagged: boolean; categories: string[] } | null> {
    return this.openai.moderate(text);
  }

  get embeddingsConfigured(): boolean {
    return this.openai.isConfigured;
  }
}

export const modelProviderService = new ModelProviderService();

/** Map a ProviderError to the HTTP error surfaced to clients. */
export const toProviderAppError = (err: unknown, provider = 'ai'): AppError => {
  if (err instanceof AppError) return err;
  if (err instanceof ProviderError) {
    return new AppError(502, 'PROVIDER_UNAVAILABLE', `AI provider ${err.provider} request failed (${err.kind})`, {
      provider: err.provider,
      kind: err.kind,
      retryable: err.retryable,
    });
  }
  return new AppError(502, 'PROVIDER_UNAVAILABLE', `AI provider ${provider} request failed`);
};
