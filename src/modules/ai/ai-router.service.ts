import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { modelProviderService, ProviderError } from './model-provider.service.js';
import { estimateCostUsd } from './pricing.js';
import { AppError } from '../../common/errors/AppError.js';

export interface GenerateMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ResolvedModelRoute {
  provider: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

export interface ExecuteTaskOptions {
  /** A-F generation cases, M = moderation classification. */
  taskCase: string;
  systemPrompt?: string;
  userPrompt: string;
  sessionId?: string;
  domain?: string;
  temperature?: number;
  maxTokens?: number;
  messages?: GenerateMessage[];
  /** Request strict JSON output where the provider supports it. */
  jsonMode?: boolean;
  /**
   * Optional validator run on the raw text BEFORE the ai_calls row is written, so
   * schema_pass reflects reality. Return true when the response matched the expected schema.
   */
  validateResponse?: (text: string) => boolean;
}

export interface ExecuteTaskResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
  costUsd: number;
  schemaPass: boolean;
  aiCallId?: string;
  provider: string;
  model: string;
}

interface CachedRoute {
  route: ResolvedModelRoute;
  expiresAt: number;
}

export class AiRouterService {
  private cache: Map<string, CachedRoute> = new Map();

  async resolveRoute(taskCase: string, domain?: string): Promise<ResolvedModelRoute> {
    const cacheKey = `${taskCase}:${domain || 'default'}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.route;
    }

    let route = domain
      ? await prisma.modelRoute.findFirst({ where: { taskCase, domain, isActive: true } })
      : null;

    if (!route) {
      route = await prisma.modelRoute.findFirst({ where: { taskCase, domain: null, isActive: true } });
    }

    let resolved: ResolvedModelRoute;
    if (!route) {
      logger.warn({ taskCase, domain }, 'No route in model_routes table, using OpenAI Sol/Luna default fallback');
      resolved = {
        provider: 'openai',
        model: taskCase === 'A' || taskCase === 'D' ? 'gpt-4o' : 'gpt-4o-mini',
        temperature: taskCase === 'A' ? 0.2 : taskCase === 'D' ? 0.4 : 0.1,
        maxTokens: taskCase === 'A' ? 8192 : 4096,
      };
    } else {
      resolved = {
        provider: route.modelProvider,
        model: route.modelName,
        temperature: Number(route.temperature),
        maxTokens: route.maxTokens,
      };
    }

    // TTL cache: DB changes to model_routes take effect without a restart, and every cluster
    // worker converges within ROUTE_CACHE_TTL_SECONDS.
    this.cache.set(cacheKey, { route: resolved, expiresAt: Date.now() + env.ROUTE_CACHE_TTL_SECONDS * 1000 });
    return resolved;
  }

  /**
   * Execute an AI task against the routed model and record it in ai_calls.
   *
   * Non-negotiable rule: every AI call is logged BEFORE its result is returned. If the ledger
   * write fails, the call fails (we never silently lose cost/training data).
   */
  async executeTask(options: ExecuteTaskOptions): Promise<ExecuteTaskResult> {
    const route = await this.resolveRoute(options.taskCase, options.domain);

    const messages: GenerateMessage[] = options.messages || [{ role: 'user', content: options.userPrompt }];
    const promptRecord = JSON.stringify({ system: options.systemPrompt ?? null, messages });

    let generateResult;
    try {
      generateResult = await modelProviderService.generate(route.provider, {
        model: route.model,
        systemPrompt: options.systemPrompt,
        messages,
        temperature: options.temperature ?? route.temperature,
        maxTokens: options.maxTokens ?? route.maxTokens,
        jsonMode: options.jsonMode,
      });
    } catch (err: unknown) {
      // A failed provider call is still a call: log it so cost/error visibility survives even
      // when generation never produces a result (previously only successful calls were logged).
      if (options.sessionId) {
        try {
          await prisma.aiCall.create({
            data: {
              sessionId: options.sessionId,
              taskCase: options.taskCase,
              modelProvider: route.provider,
              modelName: route.model,
              prompt: promptRecord,
              response: '',
              schemaPass: false,
              errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
            },
          });
        } catch (ledgerErr: unknown) {
          logger.error({ err: ledgerErr, sessionId: options.sessionId, taskCase: options.taskCase }, 'Failed to record failed ai_calls ledger entry');
        }
      }
      throw err;
    }

    const cachedTokens = generateResult.cachedTokens ?? 0;
    const costUsd = estimateCostUsd(route.model, generateResult.inputTokens, generateResult.outputTokens, cachedTokens);

    let schemaPass = true;
    if (options.validateResponse) {
      try {
        schemaPass = options.validateResponse(generateResult.text);
      } catch {
        schemaPass = false;
      }
    }

    let aiCallId: string | undefined;
    if (options.sessionId) {
      // promptRecord persists the complete model input, not just the last user turn, so the
      // training corpus can reconstruct exactly what the model saw (computed above so the
      // failure path can log the same record).
      try {
        const aiCall = await prisma.aiCall.create({
          data: {
            sessionId: options.sessionId,
            taskCase: options.taskCase,
            modelProvider: route.provider,
            modelName: route.model,
            prompt: promptRecord,
            response: generateResult.text,
            inputTokens: generateResult.inputTokens,
            outputTokens: generateResult.outputTokens,
            cachedTokens,
            latencyMs: generateResult.latencyMs,
            costUsd,
            schemaPass,
          },
        });
        aiCallId = aiCall.id;
      } catch (err: unknown) {
        logger.error({ err, sessionId: options.sessionId, taskCase: options.taskCase }, 'ai_calls ledger write failed');
        throw new AppError(500, 'INTERNAL_SERVER_ERROR', 'Failed to record AI call ledger entry');
      }
    }

    return {
      content: generateResult.text,
      inputTokens: generateResult.inputTokens,
      outputTokens: generateResult.outputTokens,
      cachedTokens,
      latencyMs: generateResult.latencyMs,
      costUsd,
      schemaPass,
      aiCallId,
      provider: route.provider,
      model: route.model,
    };
  }

  /** Update schema_pass after downstream validation (e.g. Zod parse of the JSON payload). */
  async markSchemaResult(aiCallId: string | undefined, pass: boolean, errorMessage?: string): Promise<void> {
    if (!aiCallId) return;
    try {
      await prisma.aiCall.update({
        where: { id: aiCallId },
        data: { schemaPass: pass, ...(errorMessage ? { errorMessage: errorMessage.slice(0, 2000) } : {}) },
      });
    } catch (err: unknown) {
      logger.warn({ err, aiCallId }, 'Failed to update schema_pass on ai_calls');
    }
  }

  /**
   * Record an embeddings batch against a session (or a synthetic ingestion session id) so
   * embedding spend is visible in the same ledger as everything else.
   */
  async recordEmbeddingUsage(params: {
    sessionId?: string;
    model: string;
    inputs: number;
    totalTokens: number;
    latencyMs: number;
    context: string;
  }): Promise<void> {
    if (!params.sessionId) return;
    try {
      await prisma.aiCall.create({
        data: {
          sessionId: params.sessionId,
          taskCase: 'F',
          modelProvider: 'openai',
          modelName: params.model,
          prompt: `[embeddings] ${params.context} (${params.inputs} inputs)`,
          response: `[${params.inputs} vectors]`,
          inputTokens: params.totalTokens,
          outputTokens: 0,
          latencyMs: params.latencyMs,
          costUsd: estimateCostUsd(params.model, params.totalTokens, 0),
          schemaPass: true,
        },
      });
    } catch (err: unknown) {
      logger.warn({ err, sessionId: params.sessionId }, 'Failed to record embedding usage in ai_calls');
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  /** Whether a provider error should be retried under Rule #8. */
  static isRetryable(err: unknown): boolean {
    return err instanceof ProviderError && err.retryable;
  }
}

export const aiRouterService = new AiRouterService();
