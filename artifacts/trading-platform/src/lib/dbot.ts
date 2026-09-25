/**
 * NeuroTrade ↔ embedded Deriv DBot bridge (frontend side).
 *
 * The builder is served from OUR origin at /dbot/ (API server static + Vite
 * proxy in dev), so the iframe shares this localStorage/sessionStorage. That
 * is the whole SSO trick: we seed the Deriv auth keys DBot reads before the
 * frame boots, and it authorizes straight onto the account that is active in
 * NeuroTrade — demo or real — with no second login.
 */

export interface BridgeToken {
  token: string;
  loginid: string;
  accountType: "demo" | "real";
  currency: string;
  expiresAt: string | null;
}

export interface DbotStrategySummary {
  id: number;
  name: string;
  source: string;
  symbol: string;
  createdAt: string;
}

export interface DbotStrategy extends DbotStrategySummary {
  manifest: unknown;
  xml: string;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      /* non-json error body */
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export async function fetchBridgeToken(): Promise<BridgeToken> {
  return json<BridgeToken>(await fetch("/api/dbot/bridge-token", { credentials: "include" }));
}

export async function fetchStrategies(): Promise<DbotStrategySummary[]> {
  return json<DbotStrategySummary[]>(await fetch("/api/dbot/strategies", { credentials: "include" }));
}

export async function fetchStrategy(id: number): Promise<DbotStrategy> {
  return json<DbotStrategy>(await fetch(`/api/dbot/strategies/${id}`, { credentials: "include" }));
}

export async function postRunState(running: boolean): Promise<void> {
  await fetch("/api/dbot/run-state", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ running }),
  }).catch(() => {
    /* arbiter refusal is surfaced elsewhere */
  });
}

export async function postContractEvent(contract: unknown, stage: "open" | "settled"): Promise<void> {
  await fetch("/api/dbot/events", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contract, stage }),
  }).catch(() => {
    /* journaling must never break the builder frame */
  });
}

/**
 * Seed the Deriv auth storage keys the embedded builder reads on boot.
 * Same origin ⇒ the iframe sees exactly these values.
 */
export function seedDbotAuth(t: BridgeToken): void {
  const expiresAtSeconds = t.expiresAt ? Math.floor(new Date(t.expiresAt).getTime() / 1000) : 0;
  const authInfo = {
    access_token: t.token,
    token_type: "bearer",
    expires_in: expiresAtSeconds ? Math.max(0, expiresAtSeconds - Math.floor(Date.now() / 1000)) : 0,
    expires_at: expiresAtSeconds,
    scope: "trade,read",
    refresh_token: "",
  };
  localStorage.setItem("auth_info", JSON.stringify(authInfo));
  localStorage.setItem("active_loginid", t.loginid);
  localStorage.setItem("account_type", t.accountType);
  sessionStorage.setItem(
    "deriv_accounts",
    JSON.stringify([
      {
        account_id: t.loginid,
        account_type: t.accountType,
        currency: t.currency,
        balance: "0",
        group: t.accountType === "demo" ? "demo" : "real",
        status: "active",
      },
    ]),
  );
}

/** postMessage envelope shared with src/preview/preview-branding.tsx in the builder. */
export const DBOT_FRAME_SOURCE = "neurotrade-dbot";
export const PLATFORM_SOURCE = "neurotrade-platform";

export function postToFrame(frame: HTMLIFrameElement | null, msg: Record<string, unknown>): void {
  frame?.contentWindow?.postMessage({ source: PLATFORM_SOURCE, ...msg }, window.location.origin);
}
