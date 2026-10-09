/**
 * Autonomous ledger — claim-unique matching of trade rows to Deriv transactions (pure).
 *
 * The shared reconciler matches a no-id row to the first transaction that fits
 * (symbol, family, stake, time). That is not unique: one transaction can settle
 * two rows, and a row can settle against a different trade. For autonomous
 * rows this module only accepts a pair when it is unambiguous in both
 * directions, and never reuses a contract id already attached to any row.
 */

export interface ReconRow {
  id: number;
  symbol: string;
  contractType: string;
  stake: string;
  derivContractId: string | null;
  createdAt: Date;
}

export interface DerivTx {
  contract_id?: unknown;
  contract_type?: unknown;
  underlying_symbol?: unknown;
  buy_price?: unknown;
  sell_price?: unknown;
  purchase_time?: unknown;
  sell_time?: unknown;
}

const PURCHASE_TOLERANCE_SEC = 300;
const STAKE_TOLERANCE = 0.02;

export function contractFamily(ct: string): string[] {
  // Deriv journals RISE/FALL; our rows may store CALL/PUT (and vice versa).
  if (ct === "RISE" || ct === "CALL") return ["RISE", "CALL"];
  if (ct === "FALL" || ct === "PUT") return ["FALL", "PUT"];
  return [ct];
}

/** Would this transaction plausibly be the trade this row recorded? */
export function fuzzyFits(row: ReconRow, tx: DerivTx): boolean {
  if (tx.underlying_symbol && row.symbol && String(tx.underlying_symbol) !== row.symbol) return false;
  if (tx.contract_type && !contractFamily(row.contractType).includes(String(tx.contract_type))) return false;
  if (Math.abs(Number(tx.buy_price ?? 0) - Number(row.stake)) > STAKE_TOLERANCE) return false;
  const purchaseSec = Number(tx.purchase_time ?? 0);
  const createdSec = Math.floor(row.createdAt.getTime() / 1000);
  if (purchaseSec && Math.abs(purchaseSec - createdSec) > PURCHASE_TOLERANCE_SEC) return false;
  return true;
}

/**
 * Returns rowId → transaction for every row that may be settled now.
 *
 *  - A row with a contract id matches ONLY that exact contract id.
 *  - A row without one matches only when it is the sole fitting row for the
 *    transaction AND the transaction is the sole fitting transaction for the row.
 *  - Contract ids already attached to any row (`claimedContractIds`) are never
 *    matched to a no-id row.
 */
export function matchAutonomousRows(
  rows: ReconRow[],
  transactions: DerivTx[],
  claimedContractIds: Set<string>,
): Map<number, DerivTx> {
  const result = new Map<number, DerivTx>();
  const txId = (tx: DerivTx) => (tx.contract_id != null ? String(tx.contract_id) : null);
  const exactUsed = new Set<string>();

  for (const row of rows) {
    if (!row.derivContractId) continue;
    const tx = transactions.find((t) => txId(t) === row.derivContractId);
    if (tx) {
      result.set(row.id, tx);
      exactUsed.add(row.derivContractId);
    }
  }

  const freeTx = transactions.filter((tx) => {
    const id = txId(tx);
    return id !== null && !claimedContractIds.has(id) && !exactUsed.has(id);
  });
  const looseRows = rows.filter((row) => !row.derivContractId && !result.has(row.id));

  for (const row of looseRows) {
    const rowCandidates = freeTx.filter((tx) => fuzzyFits(row, tx));
    if (rowCandidates.length !== 1) continue;
    const tx = rowCandidates[0];
    const txRowCandidates = looseRows.filter((other) => fuzzyFits(other, tx));
    if (txRowCandidates.length !== 1) continue;
    result.set(row.id, tx);
  }
  return result;
}

/** Deriv profit-table profit for a settled transaction (sell − buy, cents). */
export function settledProfit(tx: DerivTx): { buy: number; sell: number; profit: number; won: boolean } {
  const buy = Number(tx.buy_price ?? 0);
  const sell = Number(tx.sell_price ?? 0);
  const profit = Math.round((sell - buy) * 100) / 100;
  return { buy, sell, profit, won: profit > 0 };
}

/**
 * After an ambiguous buy: the single broker contract (open in the portfolio, or
 * already settled in the profit table) that is this row's trade. Returns null
 * unless exactly one unclaimed contract fits.
 */
export function pickUniquePurchase(
  row: ReconRow,
  candidates: Array<DerivTx & { contract_id?: unknown }>,
  claimedContractIds: Set<string>,
): (DerivTx & { contract_id?: unknown }) | null {
  const fits = candidates.filter((tx) => {
    if (tx.contract_id == null) return false;
    if (claimedContractIds.has(String(tx.contract_id))) return false;
    return fuzzyFits(row, tx);
  });
  // Deduplicate the same contract seen in both the portfolio and the profit table.
  const unique = new Map<string, DerivTx & { contract_id?: unknown }>();
  for (const tx of fits) unique.set(String(tx.contract_id), tx);
  return unique.size === 1 ? [...unique.values()][0] : null;
}

/** Normalise a portfolio entry into the profit-table shape used by fuzzyFits. */
export function portfolioAsTransaction(contract: any): DerivTx {
  return {
    contract_id: contract?.contract_id,
    contract_type: contract?.contract_type,
    underlying_symbol: contract?.underlying_symbol ?? contract?.symbol,
    buy_price: contract?.buy_price,
    purchase_time: contract?.purchase_time,
  };
}
