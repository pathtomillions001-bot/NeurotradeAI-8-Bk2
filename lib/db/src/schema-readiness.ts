/**
 * Retryable database-schema readiness without a false-positive "ready" state.
 *
 * The bootstrap promise resolves only after the entire schema apply callback
 * succeeds. Callers that serve requests should use waitForReady() with a
 * deadline; the background retry loop itself continues until it recovers.
 */

export interface SchemaReadinessStatus {
  ready: boolean;
  attempts: number;
  readyAt: number | null;
  lastAttemptAt: number | null;
  lastFailureAt: number | null;
  /** Safe driver/SQLSTATE identifier only; never the raw error message. */
  lastFailureCode: string | null;
}

export interface SchemaBootstrapFailure {
  attempt: number;
  failureCode: string;
  failedAt: number;
  retryInMs: number;
}

export interface SchemaBootstrapOptions {
  apply: () => Promise<void>;
  retryDelayMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onFailure?: (failure: SchemaBootstrapFailure) => void;
}

export class SchemaNotReadyError extends Error {
  readonly code = "SCHEMA_NOT_READY";

  constructor(readonly timeoutMs: number) {
    super(`Database schema was not ready within ${timeoutMs}ms`);
    this.name = "SchemaNotReadyError";
  }
}

/** Return an allow-listed error identifier suitable for logs and diagnostics. */
export function safeSchemaFailureCode(error: unknown): string {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  if (
    typeof candidate === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(candidate)
  ) {
    return candidate;
  }
  return error instanceof Error ? "SCHEMA_BOOTSTRAP_FAILED" : "UNKNOWN_SCHEMA_FAILURE";
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createSchemaBootstrap(options: SchemaBootstrapOptions) {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const current: SchemaReadinessStatus = {
    ready: false,
    attempts: 0,
    readyAt: null,
    lastAttemptAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
  };
  let started = false;

  const status = (): SchemaReadinessStatus => ({ ...current });

  const waitForReady = async (timeoutMs: number): Promise<void> => {
    if (current.ready) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new SchemaNotReadyError(timeoutMs)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const run = async (): Promise<void> => {
    while (!current.ready) {
      current.attempts += 1;
      current.lastAttemptAt = (options.now ?? Date.now)();
      try {
        await options.apply();
        current.ready = true;
        current.readyAt = (options.now ?? Date.now)();
        resolveReady();
        return;
      } catch (error) {
        const failedAt = (options.now ?? Date.now)();
        const retryInMs = Math.max(
          0,
          options.retryDelayMs?.(current.attempts) ??
            Math.min(30_000, 5_000 * current.attempts),
        );
        current.lastFailureAt = failedAt;
        current.lastFailureCode = safeSchemaFailureCode(error);
        try {
          options.onFailure?.({
            attempt: current.attempts,
            failureCode: current.lastFailureCode,
            failedAt,
            retryInMs,
          });
        } catch {
          // Diagnostic callbacks must never stop schema recovery.
        }
        try {
          await (options.sleep ?? sleepFor)(retryInMs);
        } catch {
          // A failed delay must not mark the database ready or stop retries.
        }
      }
    }
  };

  const start = (): void => {
    if (started || current.ready) return;
    started = true;
    void run();
  };

  return { ready, start, status, waitForReady };
}
