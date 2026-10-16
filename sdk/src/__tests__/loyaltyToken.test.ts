import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { OnboardingBridgeSDK } from "../bridge";

const TOKEN_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

describe("queryLoyaltyToken ScVal decoding", () => {
  it("decodes the contract's address/i128 scvVec into the public object", async () => {
    const sdk = Object.create(OnboardingBridgeSDK.prototype) as any;
    const retval = xdr.ScVal.scvVec([
      nativeToScVal(TOKEN_ID, { type: "address" }),
      nativeToScVal(10n, { type: "i128" }),
    ]);
    sdk.hooks = undefined;
    sdk.buildSimulationTx = () => ({});
    (sdk as any).provider = {
      simulateTransaction: async () => ({ results: [{ retval }] }),
    };

    await expect(sdk.queryLoyaltyToken()).resolves.toEqual({
      token: TOKEN_ID,
      amount_per_fund: "10",
    });
  });
});
