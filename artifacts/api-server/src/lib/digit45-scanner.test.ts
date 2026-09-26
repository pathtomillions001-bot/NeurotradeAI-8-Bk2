import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateDigit45Market, rankDigit45Markets, wilsonUpper } from "./digit45-scanner";

const measure = (digits: number[]) => evaluateDigit45Market("R_100", "Volatility 100", digits, 123)!;

// Sparse both-digit hits on real-looking balanced background; newest 100
// contain fewer hits than the 20% uniform baseline.
const weak = [...Array.from({ length: 540 }, (_, i) => i % 4),
  ...Array.from({ length: 30 }, () => 4), ...Array.from({ length: 30 }, () => 5)];

// Shuffle deterministically to keep the recent window representative without
// introducing an artificial consecutive-hit cluster.
function spread(digits: number[]) {
  const fours = digits.filter(d => d === 4);
  const fives = digits.filter(d => d === 5);
  const rest = digits.filter(d => d !== 4 && d !== 5);
  return Array.from({ length: digits.length }, (_, i) => i % 20 === 4 && fours.length
    ? fours.shift()! : i % 20 === 14 && fives.length ? fives.shift()! : rest.shift() ?? 0);
}

describe("Digit 4/5 scanner (no execution)", () => {
  it("qualifies both digits only with sufficient samples, confidence and recent weakness", () => {
    const c = measure(spread(weak));
    assert.equal(c.samples, 600);
    assert.equal(c.digit4.count, 30);
    assert.equal(c.digit5.count, 30);
    assert.equal(c.eligible, true, c.reason);
    assert.ok(c.digit4.upper < 0.1 && c.digit5.upper < 0.1);
    assert.equal(c.combined.count, 60);
  });

  it("does not mistake a random-looking 10%/digit tape for a measured weakness", () => {
    const c = measure(Array.from({ length: 600 }, (_, i) => i % 10));
    assert.equal(c.digit4.rate, 0.1);
    assert.equal(c.digit5.rate, 0.1);
    assert.equal(c.eligible, false);
    assert.ok(c.digit4.upper > c.digit4.rate);
  });

  it("refuses sparse or non-broker-like digit inputs", () => {
    assert.match(measure(spread(weak).slice(0, 200)).reason, /at least 300/);
    assert.equal(measure(spread(weak).slice(0, 200)).eligible, false);
    assert.equal(evaluateDigit45Market("R_100", "Vol 100", [0, 11], 123), null);
    assert.equal(wilsonUpper(0, 0), 1);
  });

  it("rejects high recent 4/5 frequency even when the long window is weak", () => {
    const tape = [...Array.from({ length: 500 }, () => 0), ...Array.from({ length: 100 }, (_, i) => i % 3 === 0 ? 4 : 1)];
    const c = measure(tape);
    assert.ok(c.digit4.rate < 0.1);
    assert.equal(c.eligible, false);
    assert.match(c.reason, /latest 100/);
  });

  it("discounts evidence when the rare hits are highly clustered", () => {
    const dispersed = measure(spread(weak));
    const clustered = measure([...Array.from({ length: 30 }, () => 4), ...Array.from({ length: 30 }, () => 5),
      ...Array.from({ length: 540 }, () => 0)]);
    assert.equal(clustered.digit4.rate, dispersed.digit4.rate);
    assert.ok(clustered.effectiveSamples < dispersed.effectiveSamples);
    assert.ok(clustered.digit4.upper > dispersed.digit4.upper);
  });

  it("ranks eligible markets before unqualified watch-only candidates", () => {
    const good = measure(spread(weak));
    const bad = measure(Array.from({ length: 600 }, (_, i) => i % 10));
    bad.symbol = "R_10";
    assert.equal(rankDigit45Markets([bad, good])[0], good);
  });
});
