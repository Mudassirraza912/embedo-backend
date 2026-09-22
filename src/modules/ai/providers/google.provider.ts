import { GoogleGenerativeAI } from '@google/generative-ai';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { GenerateOptions, GenerateResult, ProviderError, classifyProviderError } from './types.js';

export class GoogleProvider {
  private client: GoogleGenerativeAI | null = null;

  constructor() {
    if (env.GOOGLE_AI_API_KEY) {
      this.client = new GoogleGenerativeAI(env.GOOGLE_AI_API_KEY);
    }
  }

  async generate(options: GenerateOptions): Promise<GenerateResult> {
    if (!this.client) {
      throw new ProviderError('google', 'auth', 'GOOGLE_AI_API_KEY is not configured');
    }

    const start = Date.now();
    const model = this.client.getGenerativeModel({
      model: options.model || 'gemini-1.5-pro',
      systemInstruction: options.systemPrompt,
    });

    const lastMessage = options.messages[options.messages.length - 1]?.content || '';
    let text: string;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const result = await model.generateContent(lastMessage);
      const response = result.response;
      text = response.text();
      inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
      outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    } catch (err) {
      throw classifyProviderError('google', err);
    }

    const latencyMs = Date.now() - start;

    logger.debug({ model: options.model, latencyMs }, 'Google Gemini message generated');

    return {
      text,
      inputTokens,
      outputTokens,
      latencyMs,
    };
  }
}
