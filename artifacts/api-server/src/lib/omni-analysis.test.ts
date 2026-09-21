import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OMNI_CONTRACT_TYPES,
  OMNI_UTILITY_FLOOR,
  OmniModel,
  measureOmniHistory,
  omniContracts,
  omniStake,
  omniWins,
  priceOmniOpportunity,
  rankOmniOpportunities,
  type OmniContractType,
  type OmniPrediction,
  type OmniRisk,
} from "./omni-analysis";
import {
  omniConfigKey,
  omniConfigSchema,
  omniConnectedConfigSchema,
  omniStartSchema,
} from "./omni-config";
import { getFallbackPayout } from "./payouts";

const risk: OmniRisk = {
  baseStake: 1,
  debt: 0,
  markupPercent: 10,
  balance: 1000,
  maxStake: 100,
  lossBudget: 100,
};
const market = { symbol: "R_10", displayName: "Volatility 10" };
function prediction(
  type: OmniContractType,
  p: number,
  barrier?: number,
): OmniPrediction {
  const contract = omniContracts([type]).find((c) => c.barrier === barrier)!;
  return {
    contract,
    probability: p,
    rawProbability: p,
    uncertainty: 0.003,
    lossAfterLoss: 1 - p,
    samples: 500,
    expertWeights: [0.2, 0.2, 0.2, 0.2, 0.2],
  };
}
function samples(count: number, bias = false) {
  let seed = 74241;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  let price = 100;
  return Array.from({ length: count }, () => {
    price += rand() > 0.5 ? 0.01 : -0.01;
    return {
      price,
      digit: bias && rand() < 0.55 ? 7 : Math.floor(rand() * 10),
    };
  });
}

describe("Omni contract sovereignty", () => {
  it("enumerates all 42 supported one-tick variants, with no impossible barriers", () => {
    const all = omniContracts(OMNI_CONTRACT_TYPES);
    assert.equal(all.length, 42);
    assert.equal(new Set(all.map((c) => c.id)).size, 42);
    assert.equal(all.filter((c) => c.contractType === "DIGITOVER").length, 9);
    assert.equal(all.filter((c) => c.contractType === "DIGITUNDER").length, 9);
    assert.ok(
      !all.some((c) => c.id === "DIGITOVER:9" || c.id === "DIGITUNDER:0"),
    );
  });
  it("keeps every requested combination closed, including during recovery", () => {
    for (const enabled of [
      ["DIGITOVER", "DIGITUNDER", "DIGITMATCH"],
      ["DIGITDIFF"],
      ["CALL", "DIGITODD"],
      ["PUT"],
    ] as OmniContractType[][]) {
      const model = new OmniModel(enabled, 19);
      for (const sample of samples(450, true)) model.update(sample);
      for (const debt of [0, 1, 5, 30]) {
        const ranked = rankOmniOpportunities(
          model
            .predict()
            .map((p) => priceOmniOpportunity(p, market, { ...risk, debt })),
          enabled,
        );
        assert.ok(ranked.length > 0);
        assert.ok(
          ranked.every((c) => enabled.includes(c.contract.contractType)),
        );
      }
    }
  });
  it("strictly validates empty/unknown/duplicate contracts and non-finite funding", () => {
    const config = {
      enabledContracts: ["DIGITMATCH"],
      stake: 1,
      stopLoss: 5,
      takeProfit: 10,
      marketMode: "switching",
      executionMode: "paper",
    };
    assert.ok(omniConfigSchema.safeParse(config).success);
    for (const patch of [
      { enabledContracts: [] },
      { enabledContracts: ["ACCU"] },
      { enabledContracts: ["DIGITMATCH", "DIGITMATCH"] },
      { stake: NaN },
      { stake: Infinity },
      { stake: "1" },
      { stake: 0.349 },
      { stake: 0.351 },
      { stopLoss: 0 },
      { stopLoss: 0.5 },
      { takeProfit: -1 },
      { marketMode: "anything" },
      { executionMode: "auto" },
      { probabilities: [1] },
      { recoveryContracts: ["DIGITDIFF"] },
    ])
      assert.equal(
        omniConfigSchema.safeParse({ ...config, ...patch }).success,
        false,
        JSON.stringify(patch),
      );
  });
  it("allows only connected-account scans and deployments through the public API schemas", () => {
    const config = omniConfigSchema.parse({
      enabledContracts: ["DIGITOVER", "DIGITMATCH"],
      stake: 1,
      stopLoss: 10,
      takeProfit: 10,
      marketMode: "switching",
      executionMode: "live",
    });
    const deployment = {
      config,
      scanId: "123e4567-e89b-42d3-a456-426614174000",
      symbol: "R_10",
      acknowledgeLiveRisk: true,
    };
    assert.ok(omniConnectedConfigSchema.safeParse(config).success);
    assert.ok(omniStartSchema.safeParse(deployment).success);
    for (const executionMode of ["paper", "auto", undefined]) {
      assert.equal(
        omniConnectedConfigSchema.safeParse({ ...config, executionMode })
          .success,
        false,
      );
      assert.equal(
        omniStartSchema.safeParse({
          ...deployment,
          config: { ...config, executionMode },
        }).success,
        false,
      );
    }
  });
  it("binds scan tokens to risk and contracts while allowing the post-scan lock/switch choice", () => {
    const config = omniConfigSchema.parse({
      enabledContracts: ["DIGITOVER", "DIGITMATCH"],
      stake: 1,
      stopLoss: 10,
      takeProfit: 10,
      marketMode: "switching",
      executionMode: "live",
    });
    const key = omniConfigKey(config);
    assert.equal(omniConfigKey({ ...config, marketMode: "locked" }), key);
    assert.equal(
      omniConfigKey({
        ...config,
        enabledContracts: [...config.enabledContracts].reverse(),
      }),
      key,
    );
    for (const patch of [
      { stake: 2 },
      { stopLoss: 20 },
      { takeProfit: 20 },
      { enabledContracts: ["DIGITDIFF"] as const },
      { executionMode: "paper" as const },
    ]) {
      assert.notEqual(
        omniConfigKey(omniConfigSchema.parse({ ...config, ...patch })),
        key,
      );
    }
  });
  it("uses the exact contract payoff and treats unchanged prices as loss on BOTH directions", () => {
    for (const c of omniContracts(OMNI_CONTRACT_TYPES)) {
      for (let d = 0; d < 10; d++) {
        const result = omniWins(
          c,
          { price: 100, digit: 1 },
          { price: 100, digit: d },
        );
        if (c.contractType === "CALL" || c.contractType === "PUT")
          assert.equal(result, false);
        if (c.contractType === "DIGITOVER")
          assert.equal(result, d > c.barrier!);
        if (c.contractType === "DIGITUNDER")
          assert.equal(result, d < c.barrier!);
        if (c.contractType === "DIGITMATCH")
          assert.equal(result, d === c.barrier);
        if (c.contractType === "DIGITDIFF")
          assert.equal(result, d !== c.barrier);
      }
    }
  });
});

describe("Omni causal probability estimates", () => {
  it("produces the same forecast on a prefix regardless of a different unseen future", () => {
    const history = samples(650, true);
    const a = new OmniModel(OMNI_CONTRACT_TYPES, 19);
    const b = new OmniModel(OMNI_CONTRACT_TYPES, 19);
    for (const s of history.slice(0, 400)) {
      a.update(s);
      b.update(s);
    }
    const prefix = structuredClone(a.predict());
    for (const s of history.slice(400)) a.update(s);
    assert.deepEqual(b.predict(), prefix);
    for (const s of samples(250)) b.update(s);
    assert.notDeepEqual(a.predict(), b.predict());
  });
  it("preserves complementary digit probabilities, including Matches/Differs", () => {
    const model = new OmniModel(OMNI_CONTRACT_TYPES, 19);
    for (const s of samples(1200, true)) model.update(s);
    const p = new Map(
      model.predict().map((x) => [x.contract.id, x.probability]),
    );
    for (let d = 0; d < 10; d++)
      assert.ok(
        Math.abs(p.get(`DIGITMATCH:${d}`)! + p.get(`DIGITDIFF:${d}`)! - 1) <
          1e-9,
      );
    assert.ok(Math.abs(p.get("DIGITEVEN")! + p.get("DIGITODD")! - 1) < 1e-9);
    for (const forecast of model.predict()) {
      assert.ok(Number.isFinite(forecast.uncertainty));
      assert.ok(forecast.probability > 0 && forecast.probability < 1);
      assert.ok(
        Math.abs(forecast.expertWeights.reduce((a, b) => a + b, 0) - 1) < 1e-9,
      );
    }
  });
  it("models price ties rather than inflating either directional win rate", () => {
    const model = new OmniModel(["CALL", "PUT"], 19);
    for (let i = 0; i < 1000; i++) model.update({ price: 100, digit: 0 });
    assert.ok(model.predict().every((p) => p.probability < 0.2));
    assert.equal(
      model
        .predict()
        .map((p) => priceOmniOpportunity(p, market, risk))
        .some((c) => c.ready),
      false,
    );
  });
  it("refuses fair-rate negative-EV opportunities instead of promising recovery on noise", () => {
    for (const c of omniContracts(OMNI_CONTRACT_TYPES)) {
      const p = {
        ...prediction(c.contractType, c.fair, c.barrier),
        uncertainty: 0.01,
      };
      for (const debt of [0, 1, 20]) {
        const shot = priceOmniOpportunity(p, market, { ...risk, debt });
        assert.ok(shot.expectedValue < 0, c.id);
        assert.equal(shot.ready, false, c.id);
      }
    }
  });
  it("measures planted structure prequentially and labels replay funding exhaustion", () => {
    const result = measureOmniHistory(
      samples(1600, true),
      ["DIGITMATCH", "DIGITOVER"],
      risk,
      19,
    );
    assert.equal(result.model.count, 1600);
    assert.equal(result.metrics.ticks, 640);
    assert.ok(result.metrics.normalShots + result.metrics.recoveryShots > 0);
    assert.ok(Number.isFinite(result.metrics.profit));
    assert.ok(
      result.metrics.recoveryLossPairs <=
        result.metrics.recoveryShots - result.metrics.recoveryWins,
    );
    const tiny = measureOmniHistory(
      samples(1600),
      ["DIGITMATCH"],
      { ...risk, lossBudget: 0.34 },
      19,
    );
    assert.equal(tiny.metrics.stoppedByRisk, true);
    assert.equal(tiny.metrics.normalShots, 0);
  });
});

describe("Omni fixed recovery utility and cross-market ranking", () => {
  it("has no loss-run-dependent gate or timing parameter", () => {
    const p = prediction("DIGITEVEN", 0.8);
    const results = [1, 2, 5, 25].map((lossRun) =>
      priceOmniOpportunity(p, market, {
        ...risk,
        debt: 2,
        lossRun,
        recoveryStep: lossRun,
      } as OmniRisk),
    );
    assert.equal(OMNI_UTILITY_FLOOR, 0);
    assert.ok(results[0]!.ready);
    for (const value of results) assert.deepEqual(value, results[0]);
  });
  it("can choose a different contract AND market for recovery, even if the old market is viable", () => {
    const first = priceOmniOpportunity(prediction("CALL", 0.66), market, {
      ...risk,
      debt: 1,
    });
    const second = priceOmniOpportunity(
      prediction("DIGITMATCH", 0.82, 7),
      { symbol: "R_25", displayName: "Volatility 25" },
      { ...risk, debt: 1 },
    );
    assert.ok(first.ready && second.ready);
    const allowed: OmniContractType[] = ["CALL", "DIGITMATCH"];
    assert.equal(
      rankOmniOpportunities([first, second], allowed)[0]!.symbol,
      "R_25",
    );
    assert.equal(
      rankOmniOpportunities([first, second], allowed, "R_10")[0]!.symbol,
      "R_10",
    );
    assert.deepEqual(rankOmniOpportunities([first, second], ["CALL"]), [first]);
  });
  it("waits if no opportunity fits; it never falls back to a disabled contract", () => {
    const blocked = priceOmniOpportunity(prediction("DIGITODD", 0.5), market, {
      ...risk,
      debt: 1,
    });
    const disabled = priceOmniOpportunity(
      prediction("DIGITDIFF", 0.995, 5),
      market,
      { ...risk, debt: 1 },
    );
    assert.ok(disabled.ready);
    const ranked = rankOmniOpportunities([disabled, blocked], ["DIGITODD"]);
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0]!.ready, false);
  });
  it("prices loss clustering continuously instead of banning a side after a loss", () => {
    const low = priceOmniOpportunity(
      { ...prediction("CALL", 0.8), lossAfterLoss: 0.1 },
      market,
      { ...risk, debt: 1 },
    );
    const high = priceOmniOpportunity(
      { ...prediction("CALL", 0.8), lossAfterLoss: 0.8 },
      market,
      { ...risk, debt: 1 },
    );
    assert.ok(low.utility > high.utility);
    assert.ok(high.ready);
  });
  it("re-evaluates a worse payout and accounts for affordable partial recovery", () => {
    const p = prediction("DIGITEVEN", 0.6);
    assert.ok(priceOmniOpportunity(p, market, risk, 1.95, "live").ready);
    assert.equal(
      priceOmniOpportunity(p, market, risk, 1.4, "live").ready,
      false,
    );
    const partial = priceOmniOpportunity(
      prediction("DIGITDIFF", 0.99, 3),
      market,
      { ...risk, debt: 5, lossBudget: 2 },
    );
    assert.equal(partial.stake, 2);
    assert.ok(partial.debtCoverage > 0 && partial.debtCoverage < 1);
  });
});

describe("Omni debt sizing uses existing policy and absolute funding caps", () => {
  it("uses each candidate's payout rather than a ladder multiplier", () => {
    for (const c of omniContracts(OMNI_CONTRACT_TYPES)) {
      const payout = getFallbackPayout(c.contractType, c.barrier);
      const stake = omniStake({ ...risk, debt: 1 }, payout);
      assert.ok(stake * (payout - 1) >= 1.1 - 1e-9, c.id);
      assert.ok(stake <= Math.max(0.35, 1.1 / (payout - 1)) + 0.01001, c.id);
    }
  });
  it("never rounds above a cap or treats zero balance as unlimited", () => {
    assert.equal(omniStake({ ...risk, debt: 9, balance: 0 }, 1.95), 0);
    assert.equal(omniStake({ ...risk, debt: 9, maxStake: 0.34 }, 1.95), 0);
    assert.equal(omniStake({ ...risk, debt: 9, lossBudget: 0.34 }, 1.95), 0);
    assert.equal(omniStake({ ...risk, debt: 9, balance: 1.235 }, 1.95), 1.23);
    assert.equal(
      omniStake({ ...risk, debt: 9, lossBudget: 2.349 }, 1.95),
      2.34,
    );
    assert.equal(omniStake({ ...risk, balance: 0.9 }, 1.95), 0);
    for (const payout of [NaN, Infinity, 0, 1])
      assert.equal(omniStake(risk, payout), 0);
  });
});
