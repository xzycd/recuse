/**
 * The only HTTP the project does. Native fetch, a timeout, and a retry that
 * backs off. No client library. Every source here is plain REST or GraphQL
 * and adding a dependency to set a header would be silly.
 */

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch and parse JSON, retrying on network faults and 5xx.
 *
 * 4xx is not retried: the request is wrong and repeating it just wastes the
 * remote's time. The one exception is 429, where backing off is the point.
 */
export async function getJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 20_000, retries = 3, method = 'GET', body, headers = {} } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 400ms, 800ms, 1600ms, enough to clear a rate limit, short enough
      // that an interactive command still feels alive.
      await sleep(400 * 2 ** (attempt - 1));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        const err = new HttpError(`${res.status} ${res.statusText}`, res.status, url);
        if (!retryable) throw err;
        lastError = err;
        continue;
      }

      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`request failed after ${retries + 1} attempts: ${url}`);
}

/**
 * Gamma and the CLOB return several fields as JSON encoded inside a string.
 * `outcomes` arrives as the literal text `["Yes", "No"]`. Decode defensively,
 * because a malformed field should cost us one column, not the whole run.
 */
export function parseEmbeddedJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return (value as T) ?? fallback;
  if (value === '' || value === 'null') return fallback;
  try {
    const parsed = JSON.parse(value);
    return (parsed as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Coerce Gamma's mix of numbers and numeric strings into a number. */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}
