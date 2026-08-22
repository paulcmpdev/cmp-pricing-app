export function withRetry<T>(
  fn: (ctx: { attempt: number }) => Promise<T>,
  options?: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: any) => boolean;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (ctx: { attempt: number; error: any; delayMs: number }) => void;
    signal?: AbortSignal;
  }
): Promise<T>;

export function abortableSleep(
  ms: number,
  options?: { signal?: AbortSignal }
): Promise<void>;
