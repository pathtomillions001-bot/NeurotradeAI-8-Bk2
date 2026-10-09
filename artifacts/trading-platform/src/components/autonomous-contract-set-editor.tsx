/**
 * Contract-set editor for the autonomous engine's Settings page.
 *
 * Same model as the Nexus Hedge Forge: pick any contracts, up to 8 per set.
 * Over/Under/Matches/Differs take a digit, and Matches/Differs also take auto.
 * Used once for normal trades and once for recovery trades.
 */

import { useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AUTONOMOUS_CONTRACT_MENU,
  AUTONOMOUS_SET_MAX,
  specKey,
  specLabel,
  type AutonomousContractSpec,
  type AutonomousContractType,
} from "@/lib/autonomous-contracts";

interface Props {
  title: string;
  description: string;
  specs: AutonomousContractSpec[];
  onChange: (next: AutonomousContractSpec[]) => void;
  /** Test hook. */
  testId?: string;
}

export function AutonomousContractSetEditor({ title, description, specs, onChange, testId }: Props) {
  const [pickType, setPickType] = useState<AutonomousContractType>("DIGITOVER");
  const [pickDigit, setPickDigit] = useState(1);
  const [auto, setAuto] = useState(true);

  const menu = AUTONOMOUS_CONTRACT_MENU.find((m) => m.type === pickType) ?? AUTONOMOUS_CONTRACT_MENU[0];
  const showDigit = menu.needsDigit && !(menu.allowsAuto && auto);

  const add = () => {
    if (specs.length >= AUTONOMOUS_SET_MAX) {
      toast.error(`At most ${AUTONOMOUS_SET_MAX} contracts per set — the ranker needs candidates, not noise`);
      return;
    }
    let digit = -1;
    if (menu.needsDigit) {
      if (menu.allowsAuto && auto) {
        digit = -1;
      } else {
        if (!Number.isInteger(pickDigit) || pickDigit < menu.digitMin || pickDigit > menu.digitMax) {
          toast.error(`${menu.label}: ${menu.digitLabel ?? "digit"} must be ${menu.digitMin}–${menu.digitMax}`);
          return;
        }
        digit = pickDigit;
      }
    }
    const next: AutonomousContractSpec = { type: pickType, digit };
    if (specs.some((s) => specKey(s) === specKey(next))) {
      toast.info(`${specLabel(next)} is already in the ${title.toLowerCase()}`);
      return;
    }
    onChange([...specs, next]);
  };

  return (
    <div className="space-y-2.5" data-testid={testId}>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</div>
      </div>

      <div className="flex flex-wrap gap-1.5 min-h-7">
        {specs.length === 0 && (
          <span className="text-xs text-amber-400">Add at least one contract — the engine cannot trade an empty set.</span>
        )}
        {specs.map((spec) => (
          <span
            key={specKey(spec)}
            className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-0.5 text-xs font-medium text-primary"
          >
            {specLabel(spec)}
            <button
              type="button"
              aria-label={`Remove ${specLabel(spec)}`}
              onClick={() => onChange(specs.filter((s) => specKey(s) !== specKey(spec)))}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label={`${title} contract type`}
          value={pickType}
          onChange={(e) => {
            const t = e.target.value as AutonomousContractType;
            setPickType(t);
            const m = AUTONOMOUS_CONTRACT_MENU.find((x) => x.type === t);
            if (m?.needsDigit) setPickDigit(m.digitMin);
          }}
          className="h-9 rounded-md border border-input bg-secondary/50 px-2 text-sm"
        >
          {AUTONOMOUS_CONTRACT_MENU.map((m) => (
            <option key={m.type} value={m.type}>{m.label}</option>
          ))}
        </select>

        {menu.allowsAuto && (
          <button
            type="button"
            onClick={() => setAuto((v) => !v)}
            aria-pressed={auto}
            title="Auto: the engine picks the digit from the live tape (hottest for Matches, coldest for Differs)"
            className={`h-9 rounded-md border px-3 text-xs font-medium transition-colors ${
              auto ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-secondary/40 text-muted-foreground hover:text-foreground"
            }`}
          >
            Auto digit
          </button>
        )}

        {showDigit && (
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-muted-foreground">{menu.digitLabel ?? "Digit"}</span>
            <Input
              type="number"
              aria-label={`${title} ${menu.label} digit`}
              min={menu.digitMin}
              max={menu.digitMax}
              value={pickDigit}
              onChange={(e) => setPickDigit(Number(e.target.value))}
              className="w-20 h-9 text-right font-mono text-sm bg-secondary/50"
            />
          </div>
        )}

        <Button type="button" size="sm" variant="secondary" onClick={add} className="h-9">
          Add
        </Button>
      </div>
      {menu.needsDigit && (
        <p className="text-[11px] text-muted-foreground/80">
          {menu.type === "DIGITOVER" ? "Over barrier 0–8." : menu.type === "DIGITUNDER" ? "Under barrier 1–9." : "Digit 0–9."}
          {menu.allowsAuto ? " Auto lets the engine pick the digit from the live tape." : ""}
        </p>
      )}
    </div>
  );
}
