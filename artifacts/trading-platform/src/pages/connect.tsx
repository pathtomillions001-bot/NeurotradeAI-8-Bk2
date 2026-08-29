import { useConnectDerivAccount, useGetAccount, useDisconnectAccount, useGetAccounts, useSwitchAccount } from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { motion } from "framer-motion";
import { useState, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Link, useLocation } from "wouter";
import { CheckCircle, ShieldCheck, Unlink, Wifi, LogIn, KeyRound, CheckCircle2, Zap, FlaskConical, RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";

// ── PKCE utilities ────────────────────────────────────────────────────────────

function base64UrlEncode(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function createPkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64UrlEncode(verifierBytes.buffer);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64UrlEncode(digest);
  return { codeVerifier, codeChallenge };
}

function generateState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return base64UrlEncode(bytes.buffer);
}

function buildRedirectUri(): string {
  const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
  return `${window.location.origin}${base}/connect`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Connect() {
  const { data: account } = useGetAccount({
    query: {
      retry: (failureCount: number, error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return false;
        return failureCount < 1;
      },
    },
  } as { query: any });
  const connect = useConnectDerivAccount();
  const disconnect = useDisconnectAccount();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [oauthPending, setOauthPending] = useState(false);
  const handledRef = useRef(false);

  // ── Handle OAuth2 callback (new: code param; legacy: token1/acct1 params) ──
  useEffect(() => {
    if (handledRef.current) return;
    const params = new URLSearchParams(window.location.search);

    // ── New OAuth2 + PKCE callback ────────────────────────────────────────────
    const code = params.get("code");
    const state = params.get("state");

    if (code && state) {
      handledRef.current = true;

      // Retrieve stored PKCE verifier for this state
      const storedVerifier = sessionStorage.getItem(`pkce_verifier_${state}`);
      const storedRedirectUri = sessionStorage.getItem(`pkce_redirect_${state}`);
      sessionStorage.removeItem(`pkce_verifier_${state}`);
      sessionStorage.removeItem(`pkce_redirect_${state}`);

      if (!storedVerifier) {
        toast.error("OAuth state mismatch — please try logging in again.");
        window.history.replaceState({}, "", window.location.pathname);
        return;
      }

      setOauthPending(true);
      window.history.replaceState({}, "", window.location.pathname);

      const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      fetch(`${BASE}/api/auth/oauth/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          state,
          redirect_uri: storedRedirectUri ?? buildRedirectUri(),
          code_verifier: storedVerifier,
        }),
      })
        .then(async (r) => {
          if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            throw new Error((data as any).error ?? "OAuth login failed");
          }
          return r.json();
        })
        .then(() => {
          toast.success("Signed in with Deriv — live trading enabled!");
          setOauthPending(false);
          queryClient.invalidateQueries();
          // Redirect to dashboard after short delay so the user sees the success state
          setTimeout(() => setLocation("/"), 1200);
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : "OAuth login failed — please try again";
          toast.error(msg);
          setOauthPending(false);
        });

      return;
    }

    // ── Legacy Deriv OAuth callback (token1 / acct1 query params) ────────────
    const oauthToken = params.get("token1");
    const loginId = params.get("acct1");

    if (oauthToken && loginId) {
      handledRef.current = true;
      setOauthPending(true);
      window.history.replaceState({}, "", window.location.pathname);
      connect.mutate({ data: { token: oauthToken } }, {
        onSuccess: () => {
          toast.success("Logged in with Deriv — live trading enabled!");
          setOauthPending(false);
          queryClient.invalidateQueries();
          setTimeout(() => setLocation("/"), 1200);
        },
        onError: (err: unknown) => {
          const msg = err instanceof ApiError
            ? (typeof err.data === "object" && err.data && "error" in (err.data as object)
              ? String((err.data as { error: string }).error)
              : err.message)
            : "OAuth login failed — please try again";
          toast.error(msg);
          setOauthPending(false);
        },
      });
    }
  }, []);

  // ── Initiate OAuth2 + PKCE login ──────────────────────────────────────────
  const handleDerivLogin = async () => {
    try {
      const { codeVerifier, codeChallenge } = await createPkce();
      const state = generateState();
      const redirectUri = buildRedirectUri();

      // Store verifier server-side via the initiate endpoint, and also client-side
      // as a fallback in case the session store misses it
      sessionStorage.setItem(`pkce_verifier_${state}`, codeVerifier);
      sessionStorage.setItem(`pkce_redirect_${state}`, redirectUri);

      const BASE = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
      const initiateParams = new URLSearchParams({
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        redirect_uri: redirectUri,
        state,
        code_verifier: codeVerifier,  // stored server-side, keyed by state
      });

      const r = await fetch(`${BASE}/api/auth/oauth/initiate?${initiateParams.toString()}`);
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error((data as any).error ?? "Failed to initiate OAuth");
      }
      const { url } = await r.json() as { url: string };
      window.location.href = url;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start Deriv login";
      toast.error(msg);
    }
  };

  // ── Manual PAT token connect ───────────────────────────────────────────────
  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    connect.mutate({ data: { token } }, {
      onSuccess: () => {
        toast.success("Account connected — live trading on Deriv");
        setToken("");
        queryClient.invalidateQueries();
        setTimeout(() => setLocation("/"), 1200);
      },
      onError: (err: unknown) => {
        const msg = err instanceof ApiError
          ? (typeof err.data === "object" && err.data && "error" in (err.data as object)
            ? String((err.data as { error: string }).error)
            : err.message)
          : "Failed to connect account";
        toast.error(msg);
      },
    });
  };

  const handleDisconnect = () => {
    disconnect.mutate(undefined, {
      onSuccess: () => {
        toast.success("Account unlinked successfully");
        queryClient.invalidateQueries();
      },
      onError: (err: any) => {
        toast.error(err?.error || "Failed to disconnect account");
      },
    });
  };

  if (oauthPending) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="p-4 md:p-8 max-w-2xl mx-auto flex flex-col items-center justify-center min-h-[50vh] gap-4">
        <div className="relative w-16 h-16">
          <div className="absolute inset-0 rounded-full border-2 border-primary/30 animate-ping" />
          <div className="absolute inset-2 rounded-full border-2 border-primary animate-spin border-t-transparent" />
        </div>
        <p className="text-muted-foreground text-sm font-mono">Authenticating with Deriv…</p>
      </motion.div>
    );
  }

  // ── Account switcher (shown when connected) ──────────────────────────────
  const { data: allAccounts } = useGetAccounts({
    query: {
      enabled: !!account,
      refetchInterval: 15_000,
      retry: false,
    },
  } as any);

  const switchAccount = useSwitchAccount();

  const handleSwitch = (loginId: string) => {
    if (loginId === account?.loginId) return;
    switchAccount.mutate({ data: { loginId } }, {
      onSuccess: (switched) => {
        toast.success(`Switched to ${switched.isVirtual ? "Demo" : "Real"} — ${switched.loginId}`);
        queryClient.invalidateQueries();
      },
      onError: (err: unknown) => {
        const msg = err instanceof ApiError
          ? (typeof err.data === "object" && err.data && "error" in (err.data as object)
            ? String((err.data as any).error) : err.message)
          : "Failed to switch account";
        toast.error(msg);
      },
    });
  };

  if (account) {
    return (
      <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Account Connected</h1>
          <p className="text-muted-foreground mt-1 text-sm">Your Deriv account is linked and trading is live.</p>
        </div>

        {/* ── Active account card ── */}
        <Card className="bg-card border-green-500/30">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-green-500">
              <CheckCircle className="w-5 h-5" /> Active Account
            </CardTitle>
            <CardDescription>The AI engine is executing trades on this account.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 bg-secondary/30 p-4 rounded-lg">
              <div>
                <Label className="text-muted-foreground text-xs uppercase">Account ID</Label>
                <div className="font-mono text-base md:text-lg mt-1 flex items-center gap-2">
                  {account.loginId}
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${account.isVirtual ? "bg-amber-500/20 text-amber-400" : "bg-green-500/20 text-green-400"}`}>
                    {account.isVirtual ? "Demo" : "Real"}
                  </span>
                </div>
              </div>
              <div>
                <Label className="text-muted-foreground text-xs uppercase">Balance</Label>
                <div className="font-mono text-base md:text-lg mt-1 text-green-400">{account.currency} {Number(account.balance).toFixed(2)}</div>
              </div>
              {account.email && (
                <div className="col-span-2">
                  <Label className="text-muted-foreground text-xs uppercase">Email</Label>
                  <div className="text-sm mt-1 text-muted-foreground">{account.email}</div>
                </div>
              )}
            </div>

            <div className="p-3 bg-green-500/5 border border-green-500/20 rounded-lg flex items-center gap-3">
              <Wifi className="w-4 h-4 text-green-500 flex-shrink-0" />
              <div className="text-sm text-green-400">Live trading active — all trades execute on your Deriv account in real-time.</div>
            </div>
          </CardContent>
        </Card>

        {/* ── Account switcher (only if 2+ accounts) ── */}
        {allAccounts && allAccounts.length > 1 && (
          <Card className="bg-card">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <RefreshCw className="w-4 h-4 text-primary" /> Switch Account
              </CardTitle>
              <CardDescription>
                All your Deriv accounts are linked. Tap one to switch — the AI engine reconnects instantly.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {allAccounts.map((acc: any) => {
                const isActive = acc.loginId === account.loginId;
                return (
                  <button
                    key={acc.loginId}
                    onClick={() => handleSwitch(acc.loginId)}
                    disabled={switchAccount.isPending}
                    className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${
                      isActive
                        ? "border-primary/40 bg-primary/5 cursor-default"
                        : "border-border hover:border-primary/30 hover:bg-secondary/60 cursor-pointer"
                    }`}
                  >
                    {/* Icon */}
                    <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${
                      acc.isVirtual
                        ? "bg-amber-500/15 border border-amber-500/30"
                        : "bg-green-500/15 border border-green-500/30"
                    }`}>
                      {acc.isVirtual
                        ? <FlaskConical className="w-4 h-4 text-amber-400" />
                        : <Zap className="w-4 h-4 text-green-400" />
                      }
                    </div>

                    {/* Account details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono font-semibold text-sm">{acc.loginId}</span>
                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded ${
                          acc.isVirtual
                            ? "bg-amber-500/20 text-amber-400"
                            : "bg-green-500/20 text-green-400"
                        }`}>
                          {acc.isVirtual ? "Demo" : "Real"}
                        </span>
                        {isActive && (
                          <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-primary/20 text-primary">
                            Active
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-muted-foreground font-mono mt-0.5">
                        {acc.currency} {Number(acc.balance).toFixed(2)}
                      </div>
                    </div>

                    {/* Right side */}
                    {isActive
                      ? <CheckCircle2 className="w-5 h-5 text-primary flex-shrink-0" />
                      : switchAccount.isPending
                        ? <RefreshCw className="w-4 h-4 text-muted-foreground animate-spin flex-shrink-0" />
                        : <div className="text-xs text-muted-foreground font-medium flex-shrink-0">Switch →</div>
                    }
                  </button>
                );
              })}
            </CardContent>
          </Card>
        )}

        {/* ── Actions ── */}
        <div className="flex flex-col sm:flex-row gap-3">
          <Link href="/" className="flex-1">
            <Button className="w-full">Go to Dashboard</Button>
          </Link>
          <Button
            variant="outline"
            className="flex-1 border-red-500/30 text-red-400 hover:bg-red-500/10 hover:border-red-500/50"
            onClick={handleDisconnect}
            disabled={disconnect.isPending}
          >
            <Unlink className="w-4 h-4 mr-2" />
            {disconnect.isPending ? "Unlinking..." : "Unlink All Accounts"}
          </Button>
        </div>

        <Card className="bg-card">
          <CardHeader>
            <CardTitle className="text-sm">What happens when you unlink?</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground space-y-2">
            <p>• Live trading is paused until you re-link a Deriv account</p>
            <p>• Your trade history and settings are fully preserved</p>
            <p>• The AI engine continues scanning markets in paper trade mode</p>
            <p>• You can re-link your Deriv account at any time</p>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="p-4 md:p-8 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Connect Deriv Account</h1>
        <p className="text-muted-foreground mt-1 text-sm">Sign in with your Deriv account to enable live trading.</p>
      </div>

      {/* Primary: OAuth2 + PKCE Login */}
      <Card className="bg-card border-primary/30 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-primary/5 to-transparent pointer-events-none" />
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LogIn className="w-5 h-5 text-primary" />
            Sign in with Deriv
          </CardTitle>
          <CardDescription>
            Use your existing Deriv account — including Google, Facebook, or email login. No API key needed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button
            className="w-full h-12 text-base font-semibold bg-primary text-black hover:bg-primary/90 shadow-[0_0_20px_rgba(0,255,255,0.25)] transition-all hover:shadow-[0_0_30px_rgba(0,255,255,0.4)]"
            onClick={handleDerivLogin}
          >
            <svg className="w-5 h-5 mr-2" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14H9V8h2v8zm4 0h-2V8h2v8z" />
            </svg>
            Continue with Deriv
          </Button>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <ShieldCheck className="w-3.5 h-3.5 text-primary flex-shrink-0" />
            <span>You'll be redirected to Deriv's secure login page (auth.deriv.com). No passwords stored here.</span>
          </div>

          <div className="grid grid-cols-3 gap-2 pt-1">
            {["Google", "Facebook", "Email"].map((method) => (
              <div key={method} className="text-center p-2 rounded-lg bg-secondary/50 border border-border text-xs text-muted-foreground">
                {method}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-border" />
        <span className="text-xs text-muted-foreground">or use a Bearer / PAT token manually</span>
        <div className="flex-1 h-px bg-border" />
      </div>

      {/* Secondary: Manual token */}
      {showManual ? (
        <Card className="bg-card">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <KeyRound className="w-4 h-4 text-muted-foreground" /> Bearer / Personal Access Token
            </CardTitle>
            <CardDescription>
              Paste your OAuth2 Bearer token or a Deriv Personal Access Token (PAT) with{" "}
              <strong>Read</strong> and <strong>Trade</strong> permissions.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleConnect} className="space-y-4">
              <div className="space-y-2">
                <div className="relative">
                  <Input
                    id="token"
                    type={showToken ? "text" : "password"}
                    placeholder="Bearer or PAT token…"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    className="font-mono bg-secondary/50 border-border pr-16"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {showToken ? "Hide" : "Show"}
                  </button>
                </div>
                <p className="text-xs text-muted-foreground">
                  For full live trading, use{" "}
                  <button type="button" onClick={handleDerivLogin} className="text-primary underline">Sign in with Deriv</button>
                  {" "}above to get an OAuth Bearer token automatically.
                </p>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setShowManual(false)}>
                  Cancel
                </Button>
                <Button type="submit" className="flex-1" disabled={connect.isPending || !token}>
                  {connect.isPending ? "Connecting…" : "Connect with Token"}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <button
          onClick={() => setShowManual(true)}
          className="w-full text-xs text-muted-foreground hover:text-foreground py-2 transition-colors"
        >
          Use a token manually →
        </button>
      )}
    </motion.div>
  );
}
