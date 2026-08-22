export interface FixedOriginClient {
  get(path: string, options?: {
    headers?: Record<string, string>;
    query?: Record<string, string | number | null | undefined>;
    retries?: number;
    signal?: AbortSignal;
  }): Promise<{
    data: any;
    headers: { rateLimitRemaining: string | null; retryAfter: string | null };
  }>;
}

export function createFixedOriginClient(options: {
  origin: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  fetch?: (input: string | URL, init?: RequestInit) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}): FixedOriginClient;
