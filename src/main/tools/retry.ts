/**
 * Retry utility for external HTTP calls.
 * Handles transient errors (network failures, 429/5xx) with exponential backoff
 * so the agent doesn't waste tokens "reasoning" about retrying.
 */

const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504, 520, 529]);

function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes('fetch failed') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('aborted')
  );
}

export interface RetryOptions {
  /** Max number of retries (default: 3) */
  maxRetries?: number;
  /** Base delay in ms, doubled each retry (default: 1000) */
  baseDelayMs?: number;
  /** Max delay cap in ms (default: 30000) */
  maxDelayMs?: number;
}

/**
 * Drop-in replacement for fetch() that retries on transient failures.
 * - Network errors (ECONNRESET, ETIMEDOUT, fetch failed): retry with backoff
 * - HTTP 429: use Retry-After header if present, else backoff
 * - HTTP 500/502/503/504/520/529: retry with backoff
 * - All other errors/statuses: return immediately (no retry)
 */
export async function fetchWithRetry(
  url: string | URL | Request,
  init?: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const { maxRetries = 3, baseDelayMs = 1000, maxDelayMs = 30000 } = options || {};

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, init);

      if (response.ok || !TRANSIENT_STATUS_CODES.has(response.status)) {
        return response;
      }

      // Transient HTTP status — retry unless exhausted
      if (attempt === maxRetries) {
        return response;
      }

      let delay: number;
      if (response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : baseDelayMs * Math.pow(2, attempt);
      } else {
        delay = baseDelayMs * Math.pow(2, attempt);
      }
      delay = Math.min(delay, maxDelayMs);

      console.log(
        `[retry] HTTP ${response.status} from ${typeof url === 'string' ? url.substring(0, 80) : 'request'}, ` +
        `retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    } catch (err) {
      if (attempt === maxRetries || !isTransientNetworkError(err)) {
        throw err;
      }

      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(
        `[retry] Network error: ${msg.substring(0, 80)}, ` +
        `retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error('fetchWithRetry: retry loop exited unexpectedly');
}

// Export for testing
export { isTransientNetworkError, TRANSIENT_STATUS_CODES };
