/**
 * Small HTTP helpers shared by the remote import sources (lichess / chesscom /
 * catalog). Kept dependency-free: it wraps the global `fetch` (Node 22) behind an
 * injectable type so unit tests can supply a deterministic stub, and adds a 429 /
 * transient-error retry with exponential backoff (SPEC §8).
 */

/** The subset of `fetch` the sources use; injectable so tests stub the network. */
export type FetchFn = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

/** The real global fetch, narrowed to {@link FetchFn}. */
export const globalFetch: FetchFn = (url, init) => globalThis.fetch(url, init);

/** Tuning for {@link fetchWithRetry}. Defaults give ~0.3s+0.6s+1.2s of backoff. */
export interface RetryOptions {
  /** Total attempts including the first (retry budget). Default 4. */
  retries?: number;
  /** Base backoff in ms; doubles each retry. Default 300. */
  baseDelayMs?: number;
  /** Sleep implementation (injectable so tests don't actually wait). */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a status code is worth retrying (rate-limit / transient server). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Fetch `url`, retrying on 429 / transient 5xx and on network errors with
 * exponential backoff up to a small budget. A non-retryable non-2xx response is
 * returned as-is (the caller decides how to surface it); the budget being
 * exhausted on a retryable failure throws the last error so the pipeline can end
 * the job with a clear message.
 */
export async function fetchWithRetry(
  fetchFn: FetchFn,
  url: string,
  init: { headers?: Record<string, string> } = {},
  options: RetryOptions = {},
): Promise<Response> {
  const retries = options.retries ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 300;
  const sleep = options.sleep ?? defaultSleep;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    let response: Response | undefined;
    try {
      response = await fetchFn(url, init);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      response = undefined;
    }

    if (response && !isRetryableStatus(response.status)) {
      return response;
    }
    if (response) {
      lastError = new Error(
        `${response.status} ${response.statusText} from ${url}`.trim(),
      );
    }

    // Out of budget — give up.
    if (attempt === retries - 1) break;

    // Honor Retry-After when the server provides one, else exponential backoff.
    const retryAfter = response?.headers.get('retry-after');
    const delay = retryAfter
      ? Number(retryAfter) * 1000
      : baseDelayMs * 2 ** attempt;
    await sleep(Number.isFinite(delay) && delay > 0 ? delay : baseDelayMs);
  }

  throw lastError ?? new Error(`Failed to fetch ${url}`);
}
