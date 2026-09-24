/** Shared provider contracts. Only files under modules/ai/providers may import vendor SDKs. */

export interface GenerateOptions {
  model: string;
  systemPrompt?: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  temperature?: number;
  maxTokens?: number;
  /** Ask the provider for a strict JSON object response where supported (OpenAI json_object mode). */
  jsonMode?: boolean;
  /** Per-call timeout override in milliseconds. */
  timeoutMs?: number;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  latencyMs: number;
}

/** Called for every text delta as it arrives; `firstTokenMs` is set on the first call only. */
export type StreamDeltaHandler = (delta: string, meta: { firstTokenMs?: number }) => void;

export interface StreamOptions extends GenerateOptions {
  onDelta: StreamDeltaHandler;
}

export interface EmbedBatchResult {
  embeddings: number[][];
  totalTokens: number;
  latencyMs: number;
}

/** Classification of provider failures so callers can apply the documented retry policy. */
export type ProviderErrorKind = 'rate_limited' | 'auth' | 'invalid_request' | 'timeout' | 'server' | 'unknown';

export class ProviderError extends Error {
  constructor(
    public readonly provider: string,
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  get retryable(): boolean {
    return this.kind === 'rate_limited' || this.kind === 'timeout' || this.kind === 'server';
  }
}

export const classifyProviderError = (provider: string, err: unknown): ProviderError => {
  if (err instanceof ProviderError) return err;
  const e = err as { status?: number; code?: string; name?: string; message?: string };
  const status = typeof e?.status === 'number' ? e.status : undefined;
  const message = e?.message ?? 'Unknown provider error';

  if (e?.name === 'AbortError' || /timeout|timed out/i.test(message)) return new ProviderError(provider, 'timeout', message, status);
  if (status === 429) return new ProviderError(provider, 'rate_limited', message, status);
  if (status === 401 || status === 403) return new ProviderError(provider, 'auth', message, status);
  if (status !== undefined && status >= 500) return new ProviderError(provider, 'server', message, status);
  if (status !== undefined && status >= 400) return new ProviderError(provider, 'invalid_request', message, status);
  return new ProviderError(provider, 'unknown', message, status);
};
