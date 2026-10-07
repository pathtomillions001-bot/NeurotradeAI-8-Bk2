/**
 * MetaTrader 5 bridge setup.
 *
 * The pairing flow is deliberately credential-free: the user installs the
 * Expert Advisor, types a short-lived code into its inputs, and the terminal
 * proves possession by redeeming it. No MT5 password is ever entered here,
 * transmitted, or stored — the server only ever learns an account number.
 *
 * That property is worth more than the convenience of "just type your login
 * and password and we'll handle it": a database leak then exposes an
 * identifier, not the ability to trade someone else's money.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Check, Copy, ShieldCheck, X } from "lucide-react";
import { deskApi } from "@/lib/desk";

interface BridgeDialogProps {
  open: boolean;
  onClose: () => void;
  linked: boolean;
  onChanged: () => void;
}

export function BridgeDialog({ open, onClose, linked, onChanged }: BridgeDialogProps) {
  const [copied, setCopied] = useState(false);

  const status = useQuery({
    queryKey: ["bridge-status"],
    queryFn: deskApi.bridgeStatus,
    refetchInterval: open ? 2000 : false,
    enabled: open,
  });

  const pairing = useMutation({
    mutationFn: deskApi.pairingCode,
  });

  const unpair = useMutation({
    mutationFn: deskApi.unpair,
    onSuccess: onChanged,
  });

  // Issue a code as soon as the dialog opens for an unlinked desk — one less
  // click between the user and a working terminal.
  useEffect(() => {
    if (open && !linked && !pairing.data && !pairing.isPending) pairing.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, linked]);

  // The moment the EA redeems the code, refresh the desk so the UI flips to
  // live data without the user having to do anything.
  useEffect(() => {
    if (status.data?.linked && !linked) onChanged();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.data?.linked]);

  if (!open) return null;

  const code = pairing.data?.pairingCode;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-lg border border-zinc-800 bg-zinc-950 shadow-2xl">
        <header className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-semibold text-zinc-100">MetaTrader 5 bridge</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-200 transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="p-4 space-y-4 text-[12px] text-zinc-300">
          {linked && status.data?.linked ? (
            <>
              <div className="rounded border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-1">
                <p className="text-emerald-300 font-medium">Terminal linked</p>
                <dl className="grid grid-cols-2 gap-1 font-mono text-[11px] text-zinc-400">
                  <span>Login</span>
                  <span className="text-zinc-200">{status.data.login}</span>
                  <span>Server</span>
                  <span className="text-zinc-200">{status.data.server}</span>
                  <span>Last sync</span>
                  <span className={status.data.stale ? "text-red-400" : "text-zinc-200"}>
                    {Math.round((status.data.lastSyncAgeMs ?? 0) / 1000)}s ago
                    {status.data.stale && " · STALE"}
                  </span>
                  <span>Queued commands</span>
                  <span className="text-zinc-200">{status.data.queuedCommands ?? 0}</span>
                </dl>
              </div>

              {status.data.stale && (
                <p className="text-[11px] text-amber-400 leading-relaxed">
                  The terminal has stopped syncing. The EA keeps managing open positions but will
                  not open anything new — that is the fail-safe direction. Check that MetaTrader is
                  running and that AutoTrading is enabled.
                </p>
              )}

              <button
                type="button"
                onClick={() => unpair.mutate()}
                className="w-full py-2 rounded border border-red-500/40 bg-red-500/10 text-[12px] font-medium text-red-300 hover:bg-red-500/20 transition-colors"
              >
                Unlink terminal
              </button>
            </>
          ) : (
            <>
              <ol className="space-y-3">
                <Step n={1}>
                  Copy <code className="text-zinc-200">artifacts/mt5-ea/NeurotradeBridge.mq5</code>{" "}
                  into your terminal&apos;s <code className="text-zinc-200">MQL5/Experts</code>{" "}
                  folder and compile it in MetaEditor.
                </Step>
                <Step n={2}>
                  In MetaTrader 5, open{" "}
                  <span className="text-zinc-200">Tools → Options → Expert Advisors</span>, tick{" "}
                  <span className="text-zinc-200">Allow WebRequest for listed URL</span> and add
                  this origin:
                  <code className="block mt-1 px-2 py-1 rounded bg-zinc-900 text-[11px] text-emerald-300 break-all">
                    {window.location.origin}
                  </code>
                </Step>
                <Step n={3}>
                  Attach the EA to any chart and paste this pairing code into its{" "}
                  <span className="text-zinc-200">PairingCode</span> input:
                  <div className="mt-2 flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 rounded bg-zinc-900 border border-zinc-800 font-mono text-base tracking-[0.3em] text-emerald-300 text-center">
                      {pairing.isPending ? "………" : (code ?? "— — — —")}
                    </code>
                    <button
                      type="button"
                      disabled={!code}
                      onClick={() => {
                        if (!code) return;
                        navigator.clipboard?.writeText(code).then(
                          () => {
                            setCopied(true);
                            window.setTimeout(() => setCopied(false), 1500);
                          },
                          () => setCopied(false),
                        );
                      }}
                      className="p-2 rounded border border-zinc-700 text-zinc-400 hover:text-zinc-100 transition-colors disabled:opacity-40"
                      aria-label="Copy pairing code"
                    >
                      {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="mt-1 text-[10px] text-zinc-500">
                    Valid for 10 minutes, single use.
                  </p>
                </Step>
              </ol>

              <div className="rounded border border-zinc-800 bg-zinc-900/50 p-3">
                <p className="text-[11px] text-zinc-400 leading-relaxed">
                  <span className="text-zinc-200 font-medium">No password required.</span> The EA
                  runs inside your terminal and places the orders itself; this platform never sees
                  your MT5 credentials. Start on a <span className="text-zinc-200">demo account</span>{" "}
                  — live trading stays disabled until you enable it explicitly.
                </p>
              </div>

              <p className="text-[11px] text-zinc-500 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                Waiting for the terminal to pair…
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="shrink-0 w-5 h-5 rounded-full bg-zinc-800 text-zinc-300 text-[11px] font-semibold flex items-center justify-center">
        {n}
      </span>
      <div className="flex-1 text-[11px] leading-relaxed text-zinc-400">{children}</div>
    </li>
  );
}
