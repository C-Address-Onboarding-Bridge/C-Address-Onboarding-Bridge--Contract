import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { OnboardingBridgeSDK } from "../bridge";

const TEST_CALLER = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const TEST_ASSET = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("SDK read wrappers with real ScVal decoding (#887)", () => {
  let sdk: any;

  beforeEach(() => {
    sdk = Object.create(OnboardingBridgeSDK.prototype);
    sdk.hooks = undefined;
    sdk.buildSimulationTx = jest.fn(() => ({}));
  });

  describe("getNonce", () => {
    it("decodes u64 ScVal into bigint nonce", async () => {
      const retval = nativeToScVal(42n, { type: "u64" });
      sdk.provider = {
        simulateTransaction: async () => ({ results: [{ retval }] }),
      };

      const nonce = await sdk.getNonce(TEST_CALLER);
      expect(nonce).toBe(42n);
      expect(sdk.buildSimulationTx).toHaveBeenCalledWith("query_nonce", expect.any(Array));
    });

    it("throws if caller is not a valid account address", async () => {
      await expect(sdk.getNonce("invalid-address")).rejects.toThrow();
    });
  });

  describe("calculateFee", () => {
    it("decodes (i128, i128) tuple ScVal into named CalculatedFee object", async () => {
      const retval = xdr.ScVal.scvVec([
        nativeToScVal(500n, { type: "i128" }),
        nativeToScVal(99500n, { type: "i128" }),
      ]);
      sdk.provider = {
        simulateTransaction: async () => ({ results: [{ retval }] }),
      };

      const result = await sdk.calculateFee(100000n);
      expect(result).toEqual({
        fee: 500n,
        netAmount: 99500n,
      });
      expect(sdk.buildSimulationTx).toHaveBeenCalledWith("query_calculate_fee", [
        { value: 100000n, type: "i128" },
      ]);
    });

    it("throws on RPC simulation error", async () => {
      sdk.provider = {
        simulateTransaction: async () => ({ error: "Simulation failed" }),
      };
      await expect(sdk.calculateFee(100000n)).rejects.toThrow("Failed to calculate fee: Simulation failed");
    });
  });

  describe("getEffectiveFee", () => {
    it("decodes (u32, i128, i128) tuple ScVal into named EffectiveFee object", async () => {
      const retval = xdr.ScVal.scvVec([
        nativeToScVal(75, { type: "u32" }),
        nativeToScVal(750n, { type: "i128" }),
        nativeToScVal(99250n, { type: "i128" }),
      ]);
      sdk.provider = {
        simulateTransaction: async () => ({ results: [{ retval }] }),
      };

      const result = await sdk.getEffectiveFee(TEST_CALLER, TEST_ASSET, 100000n);
      expect(result).toEqual({
        feeBps: 75,
        fee: 750n,
        netAmount: 99250n,
      });
      expect(sdk.buildSimulationTx).toHaveBeenCalledWith("query_effective_fee", expect.any(Array));
    });

    it("validates caller and asset addresses", async () => {
      await expect(sdk.getEffectiveFee("invalid", TEST_ASSET, 1000n)).rejects.toThrow();
      await expect(sdk.getEffectiveFee(TEST_CALLER, "invalid", 1000n)).rejects.toThrow();
    });
  });

  describe("getTotalBridged", () => {
    it("decodes i128 ScVal into bigint total bridged", async () => {
      const retval = nativeToScVal(50000000000n, { type: "i128" });
      sdk.provider = {
        simulateTransaction: async () => ({ results: [{ retval }] }),
      };

      const total = await sdk.getTotalBridged(TEST_ASSET);
      expect(total).toBe(50000000000n);
      expect(sdk.buildSimulationTx).toHaveBeenCalledWith("query_total_bridged", expect.any(Array));
    });

    it("validates contract asset address", async () => {
      await expect(sdk.getTotalBridged("invalid-asset")).rejects.toThrow();
    });
  });

  describe("getTotalFeesCollected", () => {
    it("decodes i128 ScVal into bigint total fees", async () => {
      const retval = nativeToScVal(250000000n, { type: "i128" });
      sdk.provider = {
        simulateTransaction: async () => ({ results: [{ retval }] }),
      };

      const totalFees = await sdk.getTotalFeesCollected(TEST_ASSET);
      expect(totalFees).toBe(250000000n);
      expect(sdk.buildSimulationTx).toHaveBeenCalledWith("query_total_fees_collected", expect.any(Array));
    });

    it("validates contract asset address", async () => {
      await expect(sdk.getTotalFeesCollected("invalid-asset")).rejects.toThrow();
    });
  });

  describe("getMinimumAmount", () => {
    it("decodes i128 ScVal into bigint minimum amount", async () => {
      const retval = nativeToScVal(1000000n, { type: "i128" });
      sdk.provider = {
        simulateTransaction: async () => ({ results: [{ retval }] }),
      };

      const minAmount = await sdk.getMinimumAmount();
      expect(minAmount).toBe(1000000n);
      expect(sdk.buildSimulationTx).toHaveBeenCalledWith("query_minimum_amount", []);
    });

    it("throws on simulation failure", async () => {
      sdk.provider = {
        simulateTransaction: async () => ({ error: "RPC timeout" }),
      };
      await expect(sdk.getMinimumAmount()).rejects.toThrow("Failed to get minimum amount: RPC timeout");
    });
  });
});
