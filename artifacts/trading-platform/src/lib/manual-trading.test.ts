import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { QueryClient } from "@tanstack/react-query";
import {
  getExecuteTradeMutationOptions,
  type TradeInput,
} from "@workspace/api-client-react";

const order: TradeInput = {
  symbol: "R_10",
  contractType: "DIGITOVER",
  direction: "up",
  stake: 1,
  duration: 1,
  durationUnit: "t",
  barrier: 3,
};

afterEach(() => mock.restoreAll());

describe("manual purchase client", () => {
  it("sends one POST with one order object", async () => {
    const request = mock.method(globalThis, "fetch", async (url, init) => {
      assert.equal(url, "/api/trades");
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), order);
      return Response.json({ id: 123, ...order, status: "won", profit: 0.63 });
    });
    const client = new QueryClient();
    try {
      const mutation = client.getMutationCache().build(client, getExecuteTradeMutationOptions());
      const result = await mutation.execute({ data: order });
      assert.equal(result.id, 123);
      assert.equal(request.mock.callCount(), 1);
    } finally {
      client.clear();
    }
  });

  for (const failure of ["network", "server"] as const) {
    it(`never repeats a ${failure}-failed purchase, even with retry defaults`, async () => {
      const request = mock.method(globalThis, "fetch", async () => {
        if (failure === "network") throw new Error("Response was lost");
        return Response.json({ error: "Purchase result unavailable" }, { status: 503 });
      });
      const client = new QueryClient({
        defaultOptions: { mutations: { retry: 3, retryDelay: 0 } },
      });
      try {
        const options = getExecuteTradeMutationOptions({ mutation: { retry: 3 } });
        assert.equal(options.retry, false);
        const mutation = client.getMutationCache().build(client, options);
        await assert.rejects(mutation.execute({ data: order }));
        assert.equal(request.mock.callCount(), 1);
      } finally {
        client.clear();
      }
    });
  }
});
