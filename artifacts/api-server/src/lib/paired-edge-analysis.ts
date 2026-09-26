/**
 * Paired Edge scanner.
 *
 * The normal rails are the exact partition Over 4 (digits 5..9) + Under 5
 * (digits 0..4). They cannot both lose when they expire on the same tick. The
 * useful pre-deploy question is therefore which half currently carries the
 * stronger conditional probability, and whether that skew survives uncertainty,
 * serial dependence and regime drift. The generated DBot still accounts on the
 * realised NET P&L of both legs; an edge is evidence, never a payout guarantee.
 */

import { betaPosterior, betaQuantile, lagAutocorr } from "./specialist-analysis";

export interface PairedEdgeCandidate {
  symbol: string;
  displayName: string;
  favoredSide: "over4" | "under5";
  score: number;
  samples: number;
  effectiveSamples: number;
  overProbability: number;
  underProbability: number;
  edgeMagnitude: number;
  edgeLowerBound: number;
  zScore: number;
  markovProbability: number;
  markovEdge: number;
  stationarityZ: number;
  chiSquare: number;
  entropy: number;
  confidence: "strong" | "measured" | "weak";
  suitable: boolean;
  reason: string;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

function effectiveN(bits: number[]): number {
  if (bits.length < 10) return bits.length;
  const rho = clamp(lagAutocorr(bits, 1), -0.9, 0.9);
  return clamp(bits.length * (1 - rho) / (1 + rho), 8, bits.length);
}

/** Two-bin Pearson drift across contiguous blocks, Wilson-Hilferty z. */
function stationarity(bits: number[], blocks = 5): number {
  if (bits.length < blocks * 30) return 0;
  const size = Math.floor(bits.length / blocks);
  const p = bits.reduce((a, b) => a + b, 0) / bits.length;
  if (p <= 0 || p >= 1) return 9;
  let x2 = 0;
  for (let b = 0; b < blocks; b++) {
    const part = bits.slice(b * size, b === blocks - 1 ? bits.length : (b + 1) * size);
    const hit = part.reduce((a, x) => a + x, 0);
    const expected = part.length * p;
    x2 += (hit - expected) ** 2 / Math.max(1e-9, expected);
    x2 += (part.length - hit - part.length * (1 - p)) ** 2 / Math.max(1e-9, part.length * (1 - p));
  }
  const df = blocks - 1;
  return (Math.cbrt(x2 / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
}

function binaryEntropy(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

/**
 * Beta-Binomial marginal + order-1 Markov backoff. The marginal posterior is
 * autocorrelation-corrected; the live-context transition row is Dirichlet
 * smoothed and shrunk toward that marginal. Selection uses the conservative
 * 95% lower bound of |p-.5|, not the noisy point estimate.
 */
export function analysePairedEdge(
  symbol: string,
  displayName: string,
  digits: number[],
): PairedEdgeCandidate {
  const clean = digits.filter(d => Number.isInteger(d) && d >= 0 && d <= 9);
  const bits = clean.map(d => (d >= 5 ? 1 : 0));
  const n = bits.length;
  if (n < 120) {
    return {
      symbol, displayName, favoredSide: "over4", score: 0, samples: n,
      effectiveSamples: n, overProbability: 0.5, underProbability: 0.5,
      edgeMagnitude: 0, edgeLowerBound: 0, zScore: 0, markovProbability: 0.5,
      markovEdge: 0, stationarityZ: 0, chiSquare: 0, entropy: 1,
      confidence: "weak", suitable: false, reason: `Only ${n} digits; at least 120 are required.`,
    };
  }

  const ne = effectiveN(bits);
  const hits = bits.reduce((a, x) => a + x, 0) * (ne / n);
  const post = betaPosterior(hits, ne, 0.5, 20);
  const p = post.mean;
  const favoredOver = p >= 0.5;
  const favoredP = favoredOver ? p : 1 - p;
  const lower = favoredOver
    ? betaQuantile(0.05, post.alpha, post.beta)
    : 1 - betaQuantile(0.95, post.alpha, post.beta);
  const edgeLcb = Math.max(0, lower - 0.5);
  const z = Math.abs(p - 0.5) / Math.max(1e-9, post.sigma);

  const previous = bits[n - 2]!;
  let rowN = 0;
  let rowHigh = 0;
  for (let i = 1; i < n; i++) {
    if (bits[i - 1] === previous) {
      rowN++;
      rowHigh += bits[i]!;
    }
  }
  const markovHigh = (rowHigh + 12 * p) / (rowN + 12);
  const markovFavored = favoredOver ? markovHigh : 1 - markovHigh;
  const driftZ = stationarity(bits);
  const high = bits.reduce((a, x) => a + x, 0);
  const chi2 = ((high - n / 2) ** 2) / (n / 2) + ((n - high - n / 2) ** 2) / (n / 2);
  const entropy = binaryEntropy(p);

  // Conservative evidence + context agreement, penalised when block rates drift.
  const score = clamp(50 + edgeLcb * 900 + Math.max(0, markovFavored - 0.5) * 180 - Math.max(0, driftZ - 1.5) * 6, 0, 100);
  const suitable = edgeLcb >= 0.008 && z >= 1.65 && driftZ < 2.8 && markovFavored >= 0.5;
  const confidence = suitable && z >= 2.58 && edgeLcb >= 0.015 ? "strong" : suitable ? "measured" : "weak";
  const side = favoredOver ? "Over 4" : "Under 5";
  const reason = suitable
    ? `${side} leads with a one-sided 95% edge floor of ${(edgeLcb * 100).toFixed(2)}%; the current Markov context agrees and block drift is acceptable.`
    : `${side} is the point-estimate leader, but the conservative edge, Markov agreement, or stationarity gate is not yet strong enough.`;

  return {
    symbol, displayName, favoredSide: favoredOver ? "over4" : "under5",
    score: round(score, 2), samples: n, effectiveSamples: round(ne, 1),
    overProbability: round(p), underProbability: round(1 - p),
    edgeMagnitude: round(Math.abs(p - 0.5)), edgeLowerBound: round(edgeLcb),
    zScore: round(z, 3), markovProbability: round(markovFavored),
    markovEdge: round(markovFavored - 0.5), stationarityZ: round(driftZ, 3),
    chiSquare: round(chi2, 3), entropy: round(entropy, 4), confidence, suitable, reason,
  };
}

export function rankPairedEdges(candidates: PairedEdgeCandidate[]) {
  return [...candidates].sort((a, b) => Number(b.suitable) - Number(a.suitable) || b.score - a.score || b.samples - a.samples);
}
