/**
 * MetaTrader 5 bridge setup.
 *
 * The EA pairs with a private, reusable code and then supplies the broker catalogue,
 * account snapshot, quotes, bars and high-impact calendar from inside the
 * user's own terminal. No login or password is collected by the platform.
 */

import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Copy, Download, LoaderCircle, RotateCw, ShieldCheck, X } from "lucide-react";
import { deskApi } from "@/lib/desk";
import { pairingRequestView, shouldRequestInitialPairingCode } from "@/lib/pairing-code";

interface BridgeDialogProps {
  open: boolean;
  onClose: () => void;
  linked: boolean;
  onChanged: () => void;
}

export function BridgeDialog({ open, onClose, linked, onChanged }: BridgeDialogProps) {
  const [copied, setCopied] = useState<"code" | "origin" | null>(null);
  const initialPairingRequested = useRef(false);
  const origin = window.location.origin;
  const downloadUrl = `${import.meta.env.BASE_URL}downloads/NeurotradeBridge.mq5?v=3.03`;
  const status = useQuery({
    queryKey: ["bridge-status"],
    queryFn: deskApi.bridgeStatus,
    refetchInterval: open ? 2000 : false,
    enabled: open,
  });
  const pairing = useMutation({ mutationFn: deskApi.pairingCode });
  const unpair = useMutation({
    mutationFn: deskApi.unpair,
    onSuccess: () => {
      pairing.reset();
      initialPairingRequested.current = false;
      onChanged();
    },
  });

  useEffect(() => {
    if (
      shouldRequestInitialPairingCode({
        open,
        linked,
        alreadyAttempted: initialPairingRequested.current,
      })
    ) {
      // Set before mutate so React StrictMode effect replay cannot issue a
      // second code and invalidate the one the user is about to enter.
      initialPairingRequested.current = true;
      pairing.mutate();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, linked]);
  useEffect(() => {
    if (status.data?.linked && !linked) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.linked]);

  const copy = (value: string, target: "code" | "origin") => {
    navigator.clipboard?.writeText(value).then(
      () => {
        setCopied(target);
        window.setTimeout(() => setCopied(null), 1500);
      },
      () => setCopied(null),
    );
  };

  const pairingView = pairingRequestView({
    isPending: pairing.isPending,
    data: pairing.data,
    error: pairing.error,
  });
  if (!open) return null;
  const code = pairingView.kind === "ready" ? pairingView.code : undefined;
  const codeFieldValue = pairingView.kind === "loading"
    ? "Saving durable code…"
    : pairingView.kind === "error"
      ? "Code unavailable"
      : pairingView.kind === "ready"
        ? pairingView.code
        : "Preparing code…";

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-t-2xl border border-zinc-800 bg-zinc-950 shadow-2xl sm:rounded-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-400" /><h2 className="text-sm font-semibold text-zinc-100">MetaTrader 5 bridge</h2></div>
          <button type="button" onClick={onClose} className="rounded p-1 text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200" aria-label="Close"><X className="h-4 w-4" /></button>
        </header>

        <div className="space-y-4 p-4 text-[12px] text-zinc-300 sm:p-5">
          {linked && status.data?.linked ? (
            <>
              <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-3">
                <p className="font-medium text-emerald-300">Terminal linked</p>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-[11px] text-zinc-400">
                  <dt>Login</dt><dd className="text-zinc-200">{status.data.login}</dd>
                  <dt>Server</dt><dd className="break-all text-zinc-200">{status.data.server}</dd>
                  <dt>Last sync</dt><dd className={status.data.stale ? "text-red-400" : status.data.degraded ? "text-amber-300" : "text-zinc-200"}>{Math.round((status.data.lastSyncAgeMs ?? 0) / 1000)}s ago{status.data.stale ? " · STALE" : status.data.degraded ? " · reconnecting" : ""}</dd>
                  <dt>Broker markets</dt><dd className="text-zinc-200">{status.data.catalogCount}</dd>
                  <dt>Selected markets</dt><dd className="text-zinc-200">{status.data.selectedCount}</dd>
                  <dt>Economic calendar</dt><dd className={status.data.calendarAvailable ? "text-emerald-300" : "text-amber-300"}>{status.data.calendarAvailable ? "Available" : "Unavailable — entries paused"}</dd>
                </dl>
              </div>
              {status.data.lastPairingError && <p className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-[11px] leading-relaxed text-red-200">{status.data.lastPairingError}</p>}
              {status.data.degraded && !status.data.stale && (
                <p className="rounded-lg border border-sky-500/40 bg-sky-500/10 p-3 text-[11px] leading-relaxed text-sky-200">
                  The heartbeat is late — the terminal last synced {Math.round((status.data.lastSyncAgeMs ?? 0) / 1000)}s ago
                  {status.data.syncIntervalMs ? ` (it beats every ${(status.data.syncIntervalMs / 1000).toFixed(1)}s)` : ""}. The desk is
                  still analysing, and every market remains gated on its own quote age, so nothing trades on a stale price. If this
                  persists past {Math.round((status.data.staleAfterMs ?? 120_000) / 1000)}s the desk will pause new entries.
                </p>
              )}
              <a href={downloadUrl} download className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300"><Download className="h-3.5 w-3.5" />Download updated bridge v3.03 (compile in MetaEditor)</a>
              {status.data.stale && <p className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-[11px] leading-relaxed text-amber-300">The EA is no longer syncing ({Math.round((status.data.lastSyncAgeMs ?? 0) / 1000)}s, limit {Math.round((status.data.staleAfterMs ?? 120_000) / 1000)}s). It manages existing positions locally but the server will not analyse or open a new trade until the live heartbeat resumes. Check the MT5 Journal, WebRequest allowlist and AutoTrading settings.</p>}
              <button type="button" onClick={() => unpair.mutate()} disabled={unpair.isPending} className="w-full rounded-lg border border-red-500/40 bg-red-500/10 py-2 text-[12px] font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50">{unpair.isPending ? "Unlinking…" : "Unlink terminal and clear live Desk data"}</button>
            </>
          ) : (
            <>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-[11px] leading-relaxed text-zinc-400">
                <strong className="font-semibold text-zinc-200">The EA always attaches first.</strong> The v3.03 connector does not fail initialization when a code, URL or network is missing. It stays on the chart, prints its connection status in the MT5 Journal and retries pairing safely.
              </div>
              <ol className="space-y-4">
                <Step n={1} title="Download, copy and compile the EA">
                  <a href={downloadUrl} download className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1.5 text-[11px] font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20"><Download className="h-3.5 w-3.5" />Download NeurotradeBridge.mq5</a>
                  <p className="mt-2">Copy it into <code className="text-zinc-200">MQL5/Experts</code>, open it in MetaEditor and compile. Attach it to <strong className="text-zinc-200">any chart</strong>; it can monitor and execute selected symbols beyond that chart.</p>
                </Step>
                <Step n={2} title="Allow the exact platform origin in MT5">
                  <p>In <span className="text-zinc-200">Tools → Options → Expert Advisors</span>, tick <span className="text-zinc-200">Allow WebRequest for listed URL</span>, then add this origin exactly (no <code>/api</code> suffix):</p>
                  <CopyValue value={origin} copied={copied === "origin"} onCopy={() => copy(origin, "origin")} />
                  <p className="mt-2 text-[10px] text-zinc-500">For a deployed application use its public HTTPS origin. Do not use localhost from a remote/VPS terminal.</p>
                </Step>
                <Step n={3} title="Set EA inputs and pair">
                  <p>Set <code className="text-zinc-200">ServerUrl</code> to the same origin and paste this private, reusable code into <code className="text-zinc-200">PairingCode</code>:</p>
                  <CopyValue value={codeFieldValue} copied={copied === "code"} onCopy={() => code && copy(code, "code")} disabled={!code} large />
                  {pairingView.kind === "loading" && (
                    <p role="status" aria-live="polite" className="mt-2 flex items-center gap-2 text-[11px] text-sky-300">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> Saving the code securely before it is shown…
                    </p>
                  )}
                  {pairingView.kind === "ready" && (
                    <p role="status" aria-live="polite" className="mt-2 flex items-center gap-2 text-[11px] text-emerald-300">
                      <Check className="h-3.5 w-3.5" /> Code saved. Enter this exact code in the EA.
                    </p>
                  )}
                  {pairingView.kind === "error" && (
                    <div role="alert" className="mt-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-[11px] leading-relaxed text-red-200">
                      <p className="flex items-center gap-1.5 font-medium text-red-300"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />Pairing code unavailable</p>
                      <p className="mt-1.5">{pairingView.message}</p>
                      <button
                        type="button"
                        onClick={() => pairing.mutate()}
                        disabled={pairing.isPending}
                        className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-red-400/40 bg-red-500/10 px-2.5 py-1.5 font-medium text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        <RotateCw className="h-3.5 w-3.5" /> Retry code generation
                      </button>
                      <p className="mt-2 text-[10px] text-red-300/70">A retry may issue a replacement. Since no code is displayed yet, use only the code shown after a successful retry.</p>
                    </div>
                  )}
                  {pairingView.kind === "idle" && (
                    <p role="status" aria-live="polite" className="mt-2 text-[11px] text-zinc-500">Preparing the durable pairing code…</p>
                  )}
                  <p className="mt-2 text-[10px] text-zinc-500">This code stays valid until you unlink MT5 or generate a replacement. Keep it private. The EA saves its token locally and reconnects after restarts. Run one active bridge per account; other charts remain on standby.</p>
                </Step>
              </ol>
              <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3 text-[11px] leading-relaxed text-zinc-400"><p><span className="font-medium text-zinc-200">One account, one Desk.</span> An MT5 account can only be linked to a single Desk at a time. If it is already connected in another browser or device, pairing here is refused until that Desk unlinks it — two Desks on one account would trade the same balance against separate risk limits.</p><p className="mt-2"><span className="font-medium text-zinc-200">No password required.</span> The EA runs in your MT5 terminal, discovers the broker’s own market catalogue and places orders locally. It sends only terminal data needed for the Desk and a scoped pairing token.</p><p className="mt-2"><span className="font-medium text-red-300">Red-folder safety:</span> high-impact events from the MT5 economic calendar pause new entries before and after the release. If the calendar cannot be read, new entries stay paused.</p></div>
              {status.data?.lastPairingError ? (
                <div className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-[11px] leading-relaxed text-red-200">
                  <p className="flex items-center gap-1.5 font-medium text-red-300"><AlertTriangle className="h-3.5 w-3.5 shrink-0" />Pairing refused</p>
                  <p className="mt-1.5">{status.data.lastPairingError}</p>
                  <p className="mt-2 text-[10px] text-red-300/70">
                    The terminal will keep retrying with the code above, so it connects by itself as soon as the account is free — or generate a new code after unlinking it elsewhere.
                  </p>
                </div>
              ) : pairingView.kind === "ready" ? (
                <p role="status" aria-live="polite" className="flex items-center gap-2 text-[11px] text-zinc-500"><span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />Waiting for the terminal to pair…</p>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function CopyValue({ value, copied, onCopy, disabled, large = false }: { value: string; copied: boolean; onCopy: () => void; disabled?: boolean; large?: boolean }) {
  return <div className="mt-2 flex items-stretch gap-2"><code className={`min-w-0 flex-1 break-all rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 font-mono text-emerald-300 ${large ? "text-center text-sm tracking-[0.18em]" : "text-[11px]"}`}>{value}</code><button type="button" disabled={disabled} onClick={onCopy} className="shrink-0 rounded-md border border-zinc-700 px-2 text-zinc-400 transition-colors hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40" aria-label="Copy value">{copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}</button></div>;
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return <li className="flex gap-3"><span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-semibold text-zinc-300">{n}</span><div className="min-w-0 flex-1 text-[11px] leading-relaxed text-zinc-400"><h3 className="font-medium text-zinc-200">{title}</h3>{children}</div></li>;
}
