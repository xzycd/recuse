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

/** A deterministic problem with a response. Retrying downloads the same poison. */
class InvalidResponseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'InvalidResponseError';
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How much of a response we are willing to hold in memory.
 *
 * `res.json()` buffers whatever arrives, with no limit. A full page of Gamma
 * markets is a few hundred kilobytes, so 32MB is far past anything legitimate
 * and still small enough that a misbehaving or hostile endpoint cannot walk the
 * process into an out-of-memory kill by streaming forever.
 */
export const MAX_BODY_BYTES = 32 * 1024 * 1024;

/**
 * Read a response body as JSON, refusing to buffer past a cap.
 *
 * Content-Length is checked first when the server sends one, then the actual
 * bytes are counted while reading, because Content-Length is a claim and the
 * stream is the fact.
 */
export async function readJsonCapped<T>(res: Response, max = MAX_BODY_BYTES): Promise<T> {
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new RangeError('response size cap must be a positive safe integer');
  }
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new InvalidResponseError(`response too large: ${declared} bytes`);
  }

  if (!res.body) throw new InvalidResponseError('response had no JSON body');

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) throw new InvalidResponseError(`response exceeded ${max} bytes`);
      chunks.push(value);
    }
  } finally {
    // Releasing rather than cancelling on the happy path; cancel on the throw
    // is what stops a hostile endpoint from holding the socket open.
    reader.releaseLock();
    if (total > max) await res.body.cancel().catch(() => {});
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(joined);
  } catch (err) {
    throw new InvalidResponseError('response was not valid UTF-8', { cause: err });
  }
  try {
    return JSON.parse(decoded) as T;
  } catch (err) {
    throw new InvalidResponseError('response was not valid JSON', { cause: err });
  }
}

/**
 * Fetch and parse JSON, retrying on network faults and 5xx.
 *
 * 4xx is not retried: the request is wrong and repeating it just wastes the
 * remote's time. The one exception is 429, where backing off is the point.
 */
export async function getJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { timeoutMs = 20_000, retries = 3, method = 'GET', body, headers = {} } = opts;
  const retryCount = Number.isSafeInteger(retries) ? Math.min(5, Math.max(0, retries)) : 3;
  const requestTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.min(120_000, Math.floor(timeoutMs))
    : 20_000;
  // Serialise once. A cyclic object or throwing getter is a request bug and
  // repeating it after a backoff cannot make it succeed.
  const encodedBody = body === undefined ? undefined : JSON.stringify(body);

  let lastError: unknown;

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    if (attempt > 0) {
      // 400ms, 800ms, 1600ms, enough to clear a rate limit, short enough
      // that an interactive command still feels alive.
      await sleep(400 * 2 ** (attempt - 1));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);

    try {
      const res = await fetch(url, {
        method,
        redirect: 'error',
        signal: controller.signal,
        headers: encodedBody === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
        ...(encodedBody === undefined ? {} : { body: encodedBody }),
      });

      if (!res.ok) {
        const retryable = res.status >= 500 || res.status === 429;
        const err = new HttpError(`${res.status} ${res.statusText}`, res.status, url);
        // A response that will not be read still has to be released. Leaving a
        // 429 or 5xx body open on every retry eventually exhausts the connection
        // pool during the exact outage in which retries are most common.
        await res.body?.cancel().catch(() => {});
        if (!retryable) throw err;
        lastError = err;
        continue;
      }

      return await readJsonCapped<T>(res);
    } catch (err) {
      if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
      if (err instanceof InvalidResponseError) throw err;
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`request failed after ${retryCount + 1} attempts: ${url}`);
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

/**
 * A number, or undefined when the field was not there.
 *
 * `num` has a fallback and is right for a display quantity, where zero volume
 * and absent volume look the same on a screen. This one is for fields whose
 * absence changes the answer rather than the picture: an outcome index, a
 * payout, a price. `Number(null)` is 0, and 0 is a real outcome index, so a
 * missing one coerced through a fallback becomes a confident claim about which
 * side somebody was on. That is not hypothetical here, it is the subgraph bug
 * in DNA.md, and this exists so the same mistake has an obvious alternative.
 */
export function numOrUndefined(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
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
