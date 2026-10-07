/** Credential-free MetaTrader 5 EA pairing and connection diagnostics. */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy, ShieldCheck, X } from "lucide-react";
import { deskApi } from "@/lib/desk";

interface BridgeDialogProps {
  open: boolean;
  onClose: () => void;
  linked: boolean;
  onChanged: () => void;
}

export function BridgeDialog({ open, onClose, linked, onChanged }: BridgeDialogProps) {
  const queryClient = useQueryClient();
  const [copied, setCopied] = useState<"origin" | "code" | null>(null);
  const origin = window.location.origin;

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
      onChanged();
      void queryClient.invalidateQueries({ queryKey: ["bridge-status"] });
    },
  });

  // Issue a short-lived pairing code when the dialog opens for an unlinked desk.
  useEffect(() => {
    if (open && !linked && !pairing.data && !pairing.isPending && !pairing.isError) pairing.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, linked]);

  // Reflect the first successful EA sync without requiring a manual refresh.
  useEffect(() => {
    if (status.data?.linked && !linked) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.linked]);

  if (!open) return null;

  const code = pairing.data?.pairingCode;
  const copyValue = async (kind: "origin" | "code", value: string) => {
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(kind);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3 sm:p-5">
      <div className="max-h-[92dvh] w-full max-w-xl overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-zinc-100">MetaTrader 5 connection</h2>
          </div>
          <button type="button" onClick={onClose} className="text-zinc-500 transition-colors hover:text-zinc-200" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="space-y-4 p-4 text-xs text-zinc-300">
          {linked && status.data?.linked ? (
            <>
              <div className={`space-y-2 rounded-lg border p-3 ${status.data.stale ? "border-amber-500/30 bg-amber-500/5" : "border-emerald-500/30 bg-emerald-500/5"}`}>
                <p className={`font-semibold ${status.data.stale ? "text-amber-300" : "text-emerald-300"}`}>
                  {status.data.stale ? "Terminal paired · heartbeat stale" : "Terminal connected"}
                </p>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px] text-zinc-400">
                  <dt>Login</dt><dd className="text-zinc-200">{status.data.login}</dd>
                  <dt>Server</dt><dd className="break-all text-zinc-200">{status.data.server}</dd>
                  <dt>Last heartbeat</dt>
                  <dd className={status.data.stale ? "text-red-400" : "text-zinc-200"}>
                    {Math.round((status.data.lastSyncAgeMs ?? 0) / 1000)}s ago{status.data.stale && " · STALE"}
                  </dd>
                  <dt>Queued commands</dt><dd className="text-zinc-200">{status.data.queuedCommands ?? 0}</dd>
                </dl>
              </div>

              {status.data.stale && (
                <div className="space-y-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-3">
                  <p className="text-[11px] leading-relaxed text-amber-200/80">
                    No recent sync arrived. Check that the terminal is online, the EA is attached and enabled, and the site origin is in MT5&apos;s WebRequest allowlist. Stale quotes cannot be analysed or traded.
                  </p>
                  <button type="button" onClick={() => pairing.mutate()} disabled={pairing.isPending} className="rounded-md border border-zinc-700 px-3 py-2 text-[10px] text-zinc-200 hover:bg-zinc-900 disabled:opacity-50">
                    {pairing.isPending ? "Creating code…" : "Generate a fresh pairing code"}
                  </button>
                  {code && <PairingCode code={code} copied={copied === "code"} onCopy={() => void copyValue("code", code)} />}
                  {code && <p className="text-[10px] leading-relaxed text-zinc-500">In MT5 EA properties, set <b className="text-zinc-300">ServerUrl</b> to the origin shown below and <b className="text-zinc-300">PairingCode</b> to this code, then reinitialize the EA.</p>}
                </div>
              )}

              <button
                type="button"
                onClick={() => unpair.mutate()}
                disabled={unpair.isPending}
                className="w-full rounded-lg border border-red-500/40 bg-red-500/10 py-2.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                {unpair.isPending ? "Unlinking…" : "Unlink terminal and clear live data"}
              </button>
              {unpair.error instanceof Error && <p className="text-[10px] text-red-300">{unpair.error.message}</p>}
            </>
          ) : (
            <>
              <ol className="space-y-4">
                <Step n={1}>
                  Copy the latest <code className="text-zinc-200">artifacts/mt5-ea/NeurotradeBridge.mq5</code> into the terminal&apos;s <code className="text-zinc-200">MQL5/Experts</code> folder and compile it in MetaEditor. The current EA reads MT5&apos;s built-in high-impact economic calendar; if the broker calendar is unavailable, new entries remain blocked. The EA stays attached and retries pairing if the first attempt fails.
                </Step>
                <Step n={2}>
                  In MetaTrader 5, open <b className="text-zinc-200">Tools → Options → Expert Advisors</b>, enable <b className="text-zinc-200">Allow WebRequest for listed URL</b>, and add this exact origin (no `/api` path):
                  <div className="mt-2 flex min-w-0 items-center gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-2 text-[11px] text-emerald-300">{origin}</code>
                    <CopyButton copied={copied === "origin"} onClick={() => void copyValue("origin", origin)} label="Copy site origin" />
                  </div>
                </Step>
                <Step n={3}>
                  Attach the EA to any chart. In its inputs set <code className="text-zinc-200">ServerUrl</code> to the origin above and <code className="text-zinc-200">PairingCode</code> to this one-time code:
                  <div className="mt-2"><PairingCode code={code ?? ""} copied={copied === "code"} onCopy={() => code && void copyValue("code", code)} pending={pairing.isPending} /></div>
                  <p className="mt-1.5 text-[10px] text-zinc-500">Valid for 10 minutes · single use. The EA stays attached and retries if pairing is temporarily unavailable. Generate a fresh code before reattaching the EA after a restart.</p>
                </Step>
              </ol>

              {(pairing.error instanceof Error || status.error instanceof Error) && (
                <p className="rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2 text-[11px] text-red-300">
                  {(pairing.error ?? status.error) instanceof Error ? (pairing.error ?? status.error as Error).message : "Could not reach the API."}
                </p>
              )}

              <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
                <p className="text-[11px] leading-relaxed text-zinc-400">
                  <b className="text-zinc-200">No MT5 password is requested or transmitted.</b> The EA reports the broker&apos;s own account, symbol specifications, quotes, candles and positions. The desk stays empty until those real snapshots arrive. Start on demo; real-account execution has additional explicit safety gates.
                </p>
              </div>
              <p className="flex items-center gap-2 text-[10px] text-zinc-500">
                <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                Waiting for a successful EA heartbeat…
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function PairingCode({ code, copied, onCopy, pending = false }: { code: string; copied: boolean; onCopy: () => void; pending?: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <code className="min-w-0 flex-1 break-all rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2.5 text-center font-mono text-base tracking-[0.25em] text-emerald-300">
        {pending ? "………" : code || "— — — —"}
      </code>
      <CopyButton copied={copied} onClick={onCopy} label="Copy pairing code" disabled={!code} />
    </div>
  );
}

function CopyButton({ copied, onClick, label, disabled = false }: { copied: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className="shrink-0 rounded-md border border-zinc-700 p-2 text-zinc-400 transition-colors hover:text-zinc-100 disabled:opacity-40" aria-label={label}>
      {copied ? <Check className="h-4 w-4 text-emerald-400" /> : <Copy className="h-4 w-4" />}
    </button>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[11px] font-semibold text-zinc-300">{n}</span>
      <div className="min-w-0 flex-1 text-[11px] leading-relaxed text-zinc-400">{children}</div>
    </li>
  );
}
