import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { clampStakeToBounds, isTwoDecimalCurrency, roundStake } from "./stake-bounds";

describe("stake shaping for the account's own currency", () => {
  it("knows which currencies take two decimals", () => {
    for (const ccy of ["USD", "eur", " GBP "]) assert.equal(isTwoDecimalCurrency(ccy), true);
    for (const ccy of ["BTC", "ETH", "USDT", "USDC"]) assert.equal(isTwoDecimalCurrency(ccy), false);
    // An absent currency is treated as USD, which is what the stored-row default is.
    assert.equal(isTwoDecimalCurrency(""), true);
  });

  it("rounds fiat stakes to cents", () => {
    assert.equal(roundStake(1.006, "USD"), 1.01);
    assert.equal(roundStake(0.354, "USD"), 0.35);
  });

  it("keeps the precision a crypto account needs", () => {
    assert.equal(roundStake(0.00001234, "BTC"), 0.00001234);
    assert.notEqual(
      roundStake(0.00001234, "BTC"),
      0,
      "a crypto minimum rounded to 2 decimals would become an invalid zero stake",
    );
  });

  it("clamps a stake up to the broker's minimum for this account", () => {
    assert.equal(
      clampStakeToBounds({ amount: 0.10, currency: "USD", minStake: 0.35, balance: 100, fallbackMin: 0.35 }),
      0.35,
    );
  });

  it("clamps a stake down to the broker's maximum", () => {
    assert.equal(
      clampStakeToBounds({ amount: 5000, currency: "USD", minStake: 0.35, maxStake: 500, balance: 9000, fallbackMin: 0.35 }),
      500,
    );
  });

  it("refuses a stake the balance cannot cover instead of sending a doomed proposal", () => {
    assert.equal(
      clampStakeToBounds({ amount: 400, currency: "USD", minStake: 0.35, balance: 100, fallbackMin: 0.35 }),
      null,
    );
    assert.equal(
      clampStakeToBounds({ amount: 400, currency: "USD", minStake: 500, balance: 100, fallbackMin: 0.35 }),
      null,
      "a minimum the balance cannot reach must hold, not buy",
    );
  });

  it("applies the fallback floor only when the broker reported none", () => {
    assert.equal(
      clampStakeToBounds({ amount: 0.5, currency: "USD", balance: 100, fallbackMin: 0.35 }),
      0.5,
    );
    assert.equal(
      clampStakeToBounds({ amount: 0.1, currency: "USD", balance: 100, fallbackMin: 0.35 }),
      0.35,
    );
  });

  it("never invents a USD floor for a currency that does not use one", () => {
    assert.equal(
      clampStakeToBounds({ amount: 0.00002, currency: "BTC", balance: 1, fallbackMin: 0 }),
      0.00002,
    );
    assert.equal(clampStakeToBounds({ amount: NaN, currency: "USD", balance: 100, fallbackMin: 0.35 }), null);
    assert.equal(clampStakeToBounds({ amount: 0, currency: "USD", balance: 100, fallbackMin: 0.35 }), null);
  });
});
