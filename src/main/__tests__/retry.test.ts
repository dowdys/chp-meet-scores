import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchWithRetry, isTransientNetworkError, TRANSIENT_STATUS_CODES } from '../tools/retry';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  vi.restoreAllMocks();
  // Suppress console.log during tests
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('isTransientNetworkError', () => {
  it('identifies transient network errors', () => {
    expect(isTransientNetworkError(new Error('fetch failed'))).toBe(true);
    expect(isTransientNetworkError(new Error('ECONNRESET'))).toBe(true);
    expect(isTransientNetworkError(new Error('ETIMEDOUT'))).toBe(true);
    expect(isTransientNetworkError(new Error('socket hang up'))).toBe(true);
    expect(isTransientNetworkError(new Error('network error occurred'))).toBe(true);
  });

  it('rejects non-transient errors', () => {
    expect(isTransientNetworkError(new Error('Invalid JSON'))).toBe(false);
    expect(isTransientNetworkError(new Error('Unauthorized'))).toBe(false);
    expect(isTransientNetworkError(new Error('Not found'))).toBe(false);
    expect(isTransientNetworkError('string error')).toBe(false);
    expect(isTransientNetworkError(null)).toBe(false);
  });
});

describe('TRANSIENT_STATUS_CODES', () => {
  it('includes expected codes', () => {
    expect(TRANSIENT_STATUS_CODES.has(429)).toBe(true);
    expect(TRANSIENT_STATUS_CODES.has(500)).toBe(true);
    expect(TRANSIENT_STATUS_CODES.has(502)).toBe(true);
    expect(TRANSIENT_STATUS_CODES.has(503)).toBe(true);
    expect(TRANSIENT_STATUS_CODES.has(504)).toBe(true);
  });

  it('excludes non-transient codes', () => {
    expect(TRANSIENT_STATUS_CODES.has(200)).toBe(false);
    expect(TRANSIENT_STATUS_CODES.has(400)).toBe(false);
    expect(TRANSIENT_STATUS_CODES.has(401)).toBe(false);
    expect(TRANSIENT_STATUS_CODES.has(403)).toBe(false);
    expect(TRANSIENT_STATUS_CODES.has(404)).toBe(false);
  });
});

describe('fetchWithRetry', () => {
  it('returns immediately on success', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const resp = await fetchWithRetry('https://example.com');
    expect(resp.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns immediately on non-transient error status (e.g. 404)', async () => {
    mockFetch.mockResolvedValueOnce(new Response('not found', { status: 404 }));
    const resp = await fetchWithRetry('https://example.com');
    expect(resp.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('retries on 503 then succeeds', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const resp = await fetchWithRetry('https://example.com', undefined, {
      baseDelayMs: 1, // Speed up test
    });
    expect(resp.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('retries on network error then succeeds', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const resp = await fetchWithRetry('https://example.com', undefined, {
      baseDelayMs: 1,
    });
    expect(resp.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('throws non-transient network errors immediately', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Invalid URL'));

    await expect(
      fetchWithRetry('https://example.com', undefined, { baseDelayMs: 1 })
    ).rejects.toThrow('Invalid URL');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after maxRetries', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('err', { status: 503 }))
      .mockResolvedValueOnce(new Response('err', { status: 503 }))
      .mockResolvedValueOnce(new Response('err', { status: 503 }))
      .mockResolvedValueOnce(new Response('err', { status: 503 }));

    const resp = await fetchWithRetry('https://example.com', undefined, {
      maxRetries: 3,
      baseDelayMs: 1,
    });
    // Returns the last failed response instead of throwing
    expect(resp.status).toBe(503);
    expect(mockFetch).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });

  it('throws after maxRetries on persistent network errors', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(
      fetchWithRetry('https://example.com', undefined, {
        maxRetries: 3,
        baseDelayMs: 1,
      })
    ).rejects.toThrow('ECONNRESET');
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it('passes through request init options', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));

    await fetchWithRetry('https://example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"test": true}',
    });

    expect(mockFetch).toHaveBeenCalledWith('https://example.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"test": true}',
    });
  });
});
