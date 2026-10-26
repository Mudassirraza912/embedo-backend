import { prisma } from '../../db/prisma.js';
import { logger } from '../../config/logger.js';
import { env } from '../../config/env.js';
import { modelProviderService, ProviderError } from './model-provider.service.js';
import { estimateCostUsd } from './pricing.js';
import { AppError } from '../../common/errors/AppError.js';
import { classifyPrompt, isDifficultyTaskCase, type PromptClassification, type PromptDifficulty } from './prompt-classifier.js';

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
  /** A-F generation cases, M = moderation classification, R = Prototype resolver, X = hardware sourcing/extraction. */
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
  /**
   * The user's own words for this call (brief, request, chat message), never the assembled prompt.
   * On task cases A, R and E it is classified (prompt-classifier.ts, no AI) and the model comes from
   * difficulty_model_routes for that difficulty when an active row exists.
   */
  difficultyText?: string;
}

export interface ExecuteTaskStreamOptions extends Omit<ExecuteTaskOptions, 'validateResponse'> {
  /** Invoked for each text delta as the model writes it. */
  onDelta: (delta: string, meta: { firstTokenMs?: number }) => void;
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
  /** Set when the call was classified (difficultyText on A, R or E). */
  difficulty?: PromptDifficulty;
  difficultyScore?: number;
}

interface CachedRoute {
  route: ResolvedModelRoute;
  expiresAt: number;
}

interface RoutedCall {
  route: ResolvedModelRoute;
  classification?: PromptClassification;
  /** Set when a difficulty route replaced the task route: the model to retry on if it fails. */
  taskRoute?: ResolvedModelRoute;
}

const SUPPORTED_PROVIDERS = new Set(['openai', 'anthropic', 'google']);

export class AiRouterService {
  private cache: Map<string, CachedRoute> = new Map();
  private difficultyCache: { routes: Map<string, { provider: string; model: string }>; expiresAt: number } | null = null;

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
        // A (Sol synthesis), D, R (Prototype resolver) and X (hardware sourcing) need the stronger model.
        model: taskCase === 'A' || taskCase === 'D' || taskCase === 'R' || taskCase === 'X' ? 'gpt-4o' : 'gpt-4o-mini',
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

  /** Active difficulty routes keyed `<taskCase>:<difficulty>`, cached like model_routes. */
  async resolveDifficultyRoute(taskCase: string, difficulty: PromptDifficulty): Promise<{ provider: string; model: string } | null> {
    if (!this.difficultyCache || this.difficultyCache.expiresAt <= Date.now()) {
      const routes = new Map<string, { provider: string; model: string }>();
      try {
        const rows = await prisma.difficultyModelRoute.findMany({ where: { isActive: true } });
        for (const row of rows) {
          if (!SUPPORTED_PROVIDERS.has(row.modelProvider.toLowerCase())) continue;
          routes.set(`${row.taskCase}:${row.difficulty}`, { provider: row.modelProvider.toLowerCase(), model: row.modelName });
        }
      } catch (err: unknown) {
        // Never block a call on this table: without it every call keeps its model_routes model.
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'difficulty_model_routes unreadable; using model_routes only');
      }
      this.difficultyCache = { routes, expiresAt: Date.now() + env.ROUTE_CACHE_TTL_SECONDS * 1000 };
    }
    return this.difficultyCache.routes.get(`${taskCase}:${difficulty}`) ?? null;
  }

  /** The task case's route, swapped for its difficulty route when the call opts in and one is set. */
  private async routeCall(options: { taskCase: string; domain?: string; difficultyText?: string }): Promise<RoutedCall> {
    // A copy: the fallback path below rewrites provider/model, which must not leak into the cache.
    const route = { ...(await this.resolveRoute(options.taskCase, options.domain)) };
    if (!options.difficultyText || !isDifficultyTaskCase(options.taskCase)) return { route };
    let classification: PromptClassification;
    try {
      classification = classifyPrompt(options.difficultyText);
    } catch (err: unknown) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), taskCase: options.taskCase }, 'Prompt classification failed; using the task route');
      return { route };
    }
    const chosen = await this.resolveDifficultyRoute(options.taskCase, classification.difficulty);
    const taskRoute = chosen && (chosen.provider !== route.provider || chosen.model !== route.model) ? { ...route } : undefined;
    if (chosen) {
      route.provider = chosen.provider;
      route.model = chosen.model;
    }
    logger.info(
      { taskCase: options.taskCase, difficulty: classification.difficulty, score: classification.score, model: route.model, difficultyRoute: Boolean(chosen) },
      'Prompt difficulty classified',
    );
    return { route, classification, taskRoute };
  }

  /**
   * Safety net for admin-chosen models: when the difficulty route's model fails (retired, refuses a
   * parameter, quota…), the call is retried once on the task route, so a model choice can never
   * break a user's request. `route` is updated to the model that actually answered.
   */
  private async withTaskRouteFallback<T>(
    route: ResolvedModelRoute,
    taskRoute: ResolvedModelRoute | undefined,
    taskCase: string,
    run: (r: ResolvedModelRoute) => Promise<T>,
    canRetry: () => boolean = () => true,
  ): Promise<T> {
    try {
      return await run(route);
    } catch (err: unknown) {
      if (!taskRoute || !canRetry()) throw err;
      logger.warn(
        { taskCase, difficultyModel: `${route.provider}/${route.model}`, taskModel: `${taskRoute.provider}/${taskRoute.model}`, err: err instanceof Error ? err.message.slice(0, 300) : String(err) },
        'Difficulty route model failed; retrying on the task route',
      );
      route.provider = taskRoute.provider;
      route.model = taskRoute.model;
      return run(route);
    }
  }

  /**
   * Execute an AI task against the routed model and record it in ai_calls.
   *
   * Non-negotiable rule: every AI call is logged BEFORE its result is returned. If the ledger
   * write fails, the call fails (we never silently lose cost/training data).
   */
  async executeTask(options: ExecuteTaskOptions): Promise<ExecuteTaskResult> {
    const { route, classification, taskRoute } = await this.routeCall(options);
    const difficulty = difficultyColumns(classification);

    const messages: GenerateMessage[] = options.messages || [{ role: 'user', content: options.userPrompt }];
    const promptRecord = JSON.stringify({ system: options.systemPrompt ?? null, messages });

    let generateResult;
    try {
      generateResult = await this.withTaskRouteFallback(route, taskRoute, options.taskCase, (r) =>
        modelProviderService.generate(r.provider, {
          model: r.model,
          systemPrompt: options.systemPrompt,
          messages,
          temperature: options.temperature ?? r.temperature,
          maxTokens: options.maxTokens ?? r.maxTokens,
          jsonMode: options.jsonMode,
        }),
      );
    } catch (err: unknown) {
      if (route.provider === 'openai' && env.ANTHROPIC_API_KEY && this.isQuotaOrAuthError(err)) {
        logger.warn({ taskCase: options.taskCase, originalModel: route.model }, 'OpenAI quota exhausted, attempting Anthropic fallback');
        const fallbackModel =
          options.taskCase === 'A' || options.taskCase === 'D' || options.taskCase === 'R' || options.taskCase === 'X'
            ? 'claude-sonnet-4-6'
            : 'claude-haiku-4-5-20251001';
        try {
          generateResult = await modelProviderService.generate('anthropic', {
            model: fallbackModel,
            systemPrompt: options.systemPrompt,
            messages,
            temperature: options.temperature ?? route.temperature,
            maxTokens: options.maxTokens ?? route.maxTokens,
            jsonMode: options.jsonMode,
          });
          route.provider = 'anthropic';
          route.model = fallbackModel;
        } catch (fallbackErr) {
          logger.error({ fallbackErr }, 'Anthropic fallback failed');
        }
      }

      if (!generateResult) {
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
                ...difficulty,
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
            ...difficulty,
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
      ...(classification ? { difficulty: classification.difficulty, difficultyScore: classification.score } : {}),
    };
  }

  /**
   * Streaming twin of executeTask for conversational replies. Deltas reach the caller (and so the
   * user) while the model is still writing, so the ai_calls row is necessarily written AFTER the
   * text has started flowing — the documented "log before the result is used" invariant is kept
   * in spirit by writing the row before the reply is *persisted or acted on*, and a provider
   * failure mid-stream is still logged with whatever partial text was produced.
   */
  async executeTaskStream(options: ExecuteTaskStreamOptions): Promise<ExecuteTaskResult> {
    const { route, classification, taskRoute } = await this.routeCall(options);
    const difficulty = difficultyColumns(classification);
    const messages: GenerateMessage[] = options.messages || [{ role: 'user', content: options.userPrompt }];
    const promptRecord = JSON.stringify({ system: options.systemPrompt ?? null, messages });

    let partial = '';
    let generateResult;
    try {
      generateResult = await this.withTaskRouteFallback(
        route,
        taskRoute,
        options.taskCase,
        (r) =>
          modelProviderService.generateStream(r.provider, {
            model: r.model,
            systemPrompt: options.systemPrompt,
            messages,
            temperature: options.temperature ?? r.temperature,
            maxTokens: options.maxTokens ?? r.maxTokens,
            jsonMode: options.jsonMode,
            onDelta: (delta, meta) => {
              partial += delta;
              options.onDelta(delta, meta);
            },
          }),
        // Text already reached the user: retrying would repeat it.
        () => partial === '',
      );
    } catch (err: unknown) {
      if (route.provider === 'openai' && env.ANTHROPIC_API_KEY && this.isQuotaOrAuthError(err)) {
        logger.warn({ taskCase: options.taskCase, originalModel: route.model }, 'OpenAI quota exhausted in stream, attempting Anthropic fallback');
        const fallbackModel = 'claude-haiku-4-5-20251001';
        try {
          generateResult = await modelProviderService.generateStream('anthropic', {
            model: fallbackModel,
            systemPrompt: options.systemPrompt,
            messages,
            temperature: options.temperature ?? route.temperature,
            maxTokens: options.maxTokens ?? route.maxTokens,
            jsonMode: options.jsonMode,
            onDelta: (delta, meta) => {
              partial += delta;
              options.onDelta(delta, meta);
            },
          });
          route.provider = 'anthropic';
          route.model = fallbackModel;
        } catch (fallbackErr) {
          logger.error({ fallbackErr }, 'Anthropic stream fallback failed');
        }
      }

      if (!generateResult) {
        if (options.sessionId) {
          try {
            await prisma.aiCall.create({
              data: {
                sessionId: options.sessionId,
                taskCase: options.taskCase,
                modelProvider: route.provider,
                modelName: route.model,
                ...difficulty,
                prompt: promptRecord,
                response: partial,
                schemaPass: false,
                errorMessage: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
              },
            });
          } catch (ledgerErr: unknown) {
            logger.error({ err: ledgerErr, sessionId: options.sessionId, taskCase: options.taskCase }, 'Failed to record failed streaming ai_calls entry');
          }
        }
        throw err;
      }
    }

    const cachedTokens = generateResult.cachedTokens ?? 0;
    const costUsd = estimateCostUsd(route.model, generateResult.inputTokens, generateResult.outputTokens, cachedTokens);

    let aiCallId: string | undefined;
    if (options.sessionId) {
      try {
        const aiCall = await prisma.aiCall.create({
          data: {
            sessionId: options.sessionId,
            taskCase: options.taskCase,
            modelProvider: route.provider,
            modelName: route.model,
            ...difficulty,
            prompt: promptRecord,
            response: generateResult.text,
            inputTokens: generateResult.inputTokens,
            outputTokens: generateResult.outputTokens,
            cachedTokens,
            latencyMs: generateResult.latencyMs,
            costUsd,
            schemaPass: true,
          },
        });
        aiCallId = aiCall.id;
      } catch (err: unknown) {
        logger.error({ err, sessionId: options.sessionId, taskCase: options.taskCase }, 'streaming ai_calls ledger write failed');
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
      schemaPass: true,
      aiCallId,
      provider: route.provider,
      model: route.model,
      ...(classification ? { difficulty: classification.difficulty, difficultyScore: classification.score } : {}),
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
    this.difficultyCache = null;
  }

  private isQuotaOrAuthError(err: unknown): boolean {
    if (err instanceof ProviderError && (err.kind === 'auth' || err.kind === 'rate_limited')) {
      return /insufficient_quota|credit_balance_exhausted|quota|billing|exceeded your current quota/i.test(err.message);
    }
    const msg = err instanceof Error ? err.message : String(err);
    return /insufficient_quota|credit_balance_exhausted|quota|billing|exceeded your current quota/i.test(msg);
  }

  /** Whether a provider error should be retried under Rule #8. */
  static isRetryable(err: unknown): boolean {
    return err instanceof ProviderError && err.retryable;
  }
}

const difficultyColumns = (c: PromptClassification | undefined) =>
  c ? { promptDifficulty: c.difficulty, difficultyScore: c.score } : {};

export const aiRouterService = new AiRouterService();
