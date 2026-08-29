import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronDown, CheckCircle2, RefreshCw, User, Zap, FlaskConical } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useGetAccounts, useSwitchAccount, useGetAccount } from "@workspace/api-client-react";
import { ApiError } from "@workspace/api-client-react";

interface DerivAccount {
  id: number;
  loginId: string;
  currency: string;
  balance: number;
  isVirtual: boolean;
  isActive?: boolean;
  email?: string | null;
}

export function AccountSwitcher() {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();

  const { data: accounts, isLoading } = useGetAccounts({
    query: {
      refetchInterval: 15_000,
      retry: (count: number, err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return false;
        return count < 2;
      },
    },
  } as any);

  const { data: activeAccount } = useGetAccount({
    query: {
      retry: (count: number, err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return false;
        return count < 1;
      },
    },
  } as any);

  const switchMutation = useSwitchAccount();

  // Only show if there are 2+ accounts (nothing useful to switch between otherwise)
  if (isLoading || !accounts || accounts.length < 2) return null;

  const handleSwitch = (loginId: string) => {
    if (loginId === activeAccount?.loginId) { setOpen(false); return; }
    switchMutation.mutate({ data: { loginId } }, {
      onSuccess: (switched) => {
        toast.success(
          `Switched to ${switched.isVirtual ? "Demo" : "Real"} account ${switched.loginId}`,
          { duration: 3000 }
        );
        setOpen(false);
        // Invalidate everything — balance, journal, engine state all depend on the account
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

  const active = accounts.find(a => a.isActive) ?? accounts[0];

  return (
    <div className="relative">
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg bg-secondary/50 hover:bg-secondary border border-border hover:border-primary/30 transition-all text-left"
        disabled={switchMutation.isPending}
      >
        <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${active?.isVirtual ? "bg-amber-500/20 border border-amber-500/40" : "bg-green-500/20 border border-green-500/40"}`}>
          {active?.isVirtual
            ? <FlaskConical className="w-3 h-3 text-amber-400" />
            : <Zap className="w-3 h-3 text-green-400" />
          }
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs font-semibold truncate">{active?.loginId ?? "—"}</span>
            <span className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded ${active?.isVirtual ? "bg-amber-500/20 text-amber-400" : "bg-green-500/20 text-green-400"}`}>
              {active?.isVirtual ? "Demo" : "Real"}
            </span>
          </div>
          <div className="text-[10px] text-muted-foreground font-mono truncate">
            {active ? `${active.currency} ${Number(active.balance).toFixed(2)}` : "—"}
          </div>
        </div>
        {switchMutation.isPending
          ? <RefreshCw className="w-3.5 h-3.5 text-muted-foreground animate-spin flex-shrink-0" />
          : <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground flex-shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
        }
      </button>

      {/* Dropdown */}
      <AnimatePresence>
        {open && (
          <>
            {/* Backdrop */}
            <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />

            <motion.div
              initial={{ opacity: 0, y: -6, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.97 }}
              transition={{ duration: 0.15 }}
              className="absolute bottom-full left-0 right-0 mb-2 z-40 bg-card border border-border rounded-xl shadow-2xl overflow-hidden"
            >
              <div className="px-3 py-2 border-b border-border">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <User className="w-3 h-3" /> Switch Account
                </p>
              </div>

              <div className="p-1.5 space-y-0.5 max-h-64 overflow-y-auto">
                {accounts.map((acc: DerivAccount) => {
                  const isSelected = acc.loginId === active?.loginId;
                  const isSwitching = switchMutation.isPending && !isSelected;
                  return (
                    <button
                      key={acc.loginId}
                      onClick={() => handleSwitch(acc.loginId)}
                      disabled={switchMutation.isPending}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg transition-all text-left ${
                        isSelected
                          ? "bg-primary/10 border border-primary/20"
                          : "hover:bg-secondary/80 border border-transparent hover:border-border"
                      }`}
                    >
                      {/* Account type icon */}
                      <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${
                        acc.isVirtual
                          ? "bg-amber-500/15 border border-amber-500/30"
                          : "bg-green-500/15 border border-green-500/30"
                      }`}>
                        {acc.isVirtual
                          ? <FlaskConical className="w-3.5 h-3.5 text-amber-400" />
                          : <Zap className="w-3.5 h-3.5 text-green-400" />
                        }
                      </div>

                      {/* Account info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono text-xs font-semibold">{acc.loginId}</span>
                          <span className={`text-[9px] font-bold uppercase px-1 py-0.5 rounded ${
                            acc.isVirtual
                              ? "bg-amber-500/20 text-amber-400"
                              : "bg-green-500/20 text-green-400"
                          }`}>
                            {acc.isVirtual ? "Demo" : "Real"}
                          </span>
                        </div>
                        <div className="text-[10px] text-muted-foreground font-mono">
                          {acc.currency} {Number(acc.balance).toFixed(2)}
                        </div>
                      </div>

                      {/* Active indicator */}
                      {isSelected && (
                        <CheckCircle2 className="w-4 h-4 text-primary flex-shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>

              <div className="px-3 py-2 border-t border-border">
                <p className="text-[10px] text-muted-foreground">
                  Switching accounts reconnects the AI engine to the selected account.
                </p>
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
