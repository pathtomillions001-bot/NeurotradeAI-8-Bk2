/** Client-side contract and view state for the durable MT5 pairing credential. */

export interface PairingCodeResponse {
  pairingCode: string;
  expiresInMs: number | null;
}

export class DeskApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryable?: boolean,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "DeskApiError";
  }
}

export class PairingCodeResponseError extends Error {
  readonly code = "INVALID_PAIRING_RESPONSE";

  constructor() {
    super("The pairing service returned an empty code. Retry; if it persists, contact support.");
    this.name = "PairingCodeResponseError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Parse the API envelope and reject 2xx responses that cannot be paired. */
export function parsePairingCodeResponse(value: unknown): PairingCodeResponse {
  const response = record(value);
  const pairingCode = typeof response?.pairingCode === "string"
    ? response.pairingCode.trim()
    : "";
  if (!pairingCode) throw new PairingCodeResponseError();

  const expiresInMs = response?.expiresInMs;
  return {
    pairingCode,
    expiresInMs: typeof expiresInMs === "number" && Number.isFinite(expiresInMs)
      ? expiresInMs
      : null,
  };
}

/** Convert legacy string errors and the structured `{ error: { … } }` contract. */
export function deskApiErrorFromResponse(
  status: number,
  statusText: string,
  value: unknown,
): DeskApiError {
  const body = record(value);
  const nestedError = record(body?.error);
  const messageCandidate =
    typeof body?.error === "string"
      ? body.error
      : typeof nestedError?.message === "string"
        ? nestedError.message
        : typeof body?.message === "string"
          ? body.message
          : "";
  const codeCandidate = nestedError?.code ?? body?.errorCode ?? body?.code;
  const retryableCandidate = nestedError?.retryable ?? body?.retryable;
  const requestIdCandidate = nestedError?.requestId ?? body?.requestId;
  const rejections = Array.isArray(body?.rejections)
    ? body.rejections.filter((item): item is string => typeof item === "string")
    : [];
  const baseMessage = typeof messageCandidate === "string" && messageCandidate.trim()
    ? messageCandidate.trim()
    : `${status} ${statusText}`.trim();
  const message = `${baseMessage}${rejections.length > 0 ? `: ${rejections[0]}` : ""}`.slice(0, 500);

  return new DeskApiError(
    message,
    status,
    typeof codeCandidate === "string" ? codeCandidate.slice(0, 64) : undefined,
    typeof retryableCandidate === "boolean" ? retryableCandidate : undefined,
    typeof requestIdCandidate === "string" ? requestIdCandidate.slice(0, 64) : undefined,
  );
}

export type PairingRequestView =
  | { kind: "idle"; showRetry: false }
  | { kind: "loading"; showRetry: false }
  | { kind: "ready"; code: string; showRetry: false }
  | { kind: "error"; message: string; showRetry: true };

/** UI state is explicit; only an error exposes the manual retry action. */
export function pairingRequestView(input: {
  isPending: boolean;
  data?: unknown;
  error?: unknown;
}): PairingRequestView {
  if (input.isPending) return { kind: "loading", showRetry: false };
  if (input.error) {
    return {
      kind: "error",
      message: pairingErrorMessage(input.error),
      showRetry: true,
    };
  }

  const response = record(input.data);
  const code = typeof response?.pairingCode === "string"
    ? response.pairingCode.trim()
    : "";
  return code
    ? { kind: "ready", code, showRetry: false }
    : { kind: "idle", showRetry: false };
}

/**
 * The dialog's one automatic request happens only once per open session. Once
 * it fails, closing/reopening or status polling must not rotate the code; the
 * user gets a visible Retry button instead.
 */
export function shouldRequestInitialPairingCode(input: {
  open: boolean;
  linked: boolean;
  alreadyAttempted: boolean;
}): boolean {
  return input.open && !input.linked && !input.alreadyAttempted;
}

export function pairingErrorMessage(error: unknown): string {
  if (error instanceof PairingCodeResponseError) return error.message;

  if (error instanceof DeskApiError) {
    if (error.status === 404) {
      return "This API does not have the MT5 pairing endpoint yet. Refresh, and if it continues, have the web and API services deployed from the same release.";
    }
    if (
      error.code === "pairing_code_unavailable" ||
      error.code === "database_not_ready"
    ) {
      return error.requestId
        ? `${error.message} Reference: ${error.requestId}`
        : error.message;
    }
    if (error.status >= 500 || /^\d{3}\s/.test(error.message)) {
      return "The pairing service could not confirm a saved code. Check the connection and retry. Use only the code shown after a successful retry.";
    }
    return error.message;
  }

  return "Could not reach the pairing service. Check your connection and retry.";
}
