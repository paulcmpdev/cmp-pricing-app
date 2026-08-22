export interface SourceError extends Error {
  category: string;
  statusCode?: number;
  url?: string;
  retryable: boolean;
  retryAfter?: string;
}

export const ErrorCategory: {
  readonly AUTH: 'auth';
  readonly RATE_LIMIT: 'rate_limit';
  readonly TIMEOUT: 'timeout';
  readonly SERVER: 'server';
  readonly NETWORK: 'network';
  readonly PARSE: 'parse';
  readonly SCHEMA: 'schema';
  readonly REDIRECT: 'redirect';
  readonly VALIDATION: 'validation';
  readonly CANCELED: 'canceled';
};

export function createSourceError(
  category: string,
  message: string,
  options?: { statusCode?: number; url?: string; retryable?: boolean }
): SourceError;

export function redactUrl(url: string): string;
export function redactErrorSummary(message: string, maxLength?: number): string;
