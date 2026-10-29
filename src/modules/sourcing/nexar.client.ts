import { env } from '../../config/env.js';

const TOKEN_URL = 'https://identity.nexar.com/connect/token';
const GRAPHQL_URL = 'https://api.nexar.com/graphql';
const REQUEST_TIMEOUT_MS = 12_000;

export class NexarError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'NexarError';
  }
}

let cachedToken: { value: string; expiresAt: number } | null = null;

export const resetNexarTokenCache = (): void => {
  cachedToken = null;
};

export const nexarConfigured = (): boolean =>
  env.NEXAR_ENABLED && Boolean(env.NEXAR_CLIENT_ID) && Boolean(env.NEXAR_CLIENT_SECRET);

let tokenInflight: Promise<string> | null = null;

// Tokens last ~24h; refresh 5 minutes early and share one refresh between concurrent callers.
async function getToken(forceRefresh = false): Promise<string> {
  if (!forceRefresh && cachedToken && cachedToken.expiresAt > Date.now() + 300_000) return cachedToken.value;
  if (!tokenInflight) {
    tokenInflight = requestToken().finally(() => {
      tokenInflight = null;
    });
  }
  return tokenInflight;
}

async function requestToken(): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.NEXAR_CLIENT_ID ?? '',
      client_secret: env.NEXAR_CLIENT_SECRET ?? '',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new NexarError(`Nexar token request failed (${res.status})`, res.status >= 500);
  const body = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new NexarError('Nexar token response had no access_token');
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return cachedToken.value;
}

export async function nexarQuery<T>(query: string, variables: Record<string, unknown>, retried = false): Promise<T> {
  const token = await getToken();
  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 401) {
    cachedToken = null;
    if (!retried) {
      await getToken(true);
      return nexarQuery<T>(query, variables, true);
    }
  }
  if (!res.ok) throw new NexarError(`Nexar query failed (${res.status})`, res.status >= 500 || res.status === 429);
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length || !body.data) {
    throw new NexarError(`Nexar query error: ${body.errors?.[0]?.message ?? 'no data'}`);
  }
  return body.data;
}
