import { Contract, Networks } from "@stellar/stellar-sdk";
import { OnboardingBridgeSDK } from "../bridge";
import { withRpcRetry } from "../retry";

const CONTRACT_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";
const ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function makeSdk(provider: any, onRpcCall: jest.Mock) {
  const sdk = Object.create(OnboardingBridgeSDK.prototype) as any;
  sdk.hooks = { onRpcCall };
  sdk.config = {};
  sdk.networkPassphrase = Networks.TESTNET;
  sdk.contract = new Contract(CONTRACT_ID);
  sdk.provider = provider;
  return sdk as OnboardingBridgeSDK;
}

describe("onRpcCall coverage for read paths", () => {
  it("queryPendingUpgrade fires onRpcCall", async () => {
    const onRpcCall = jest.fn();
    const provider = { simulateTransaction: jest.fn().mockResolvedValue({}) };
    await makeSdk(provider, onRpcCall).queryPendingUpgrade();
    expect(onRpcCall).toHaveBeenCalled();
  });

  it("queryTimelocked fires onRpcCall", async () => {
    const onRpcCall = jest.fn();
    const provider = { simulateTransaction: jest.fn().mockResolvedValue({}) };
    await makeSdk(provider, onRpcCall).queryTimelocked(1);
    expect(onRpcCall).toHaveBeenCalled();
  });

  it("estimateCost fires onRpcCall for simulate and getFeeStats", async () => {
    const onRpcCall = jest.fn();
    const provider = {
      simulateTransaction: jest.fn().mockResolvedValue({ minResourceFee: "100" }),
      getFeeStats: jest.fn().mockResolvedValue({ sorobanInclusionFee: { p50: "100" } }),
      getAccount: jest.fn().mockResolvedValue({ balance: "0", subentryCount: 0 }),
    };
    try {
      await makeSdk(provider, onRpcCall).estimateCost({
        source: ACCOUNT,
        target: CONTRACT_ID,
        asset: CONTRACT_ID,
        amount: "1",
      } as any);
    } catch {
      // later steps may need more provider surface; hooks must already have fired
    }
    expect(onRpcCall).toHaveBeenCalled();
    expect(provider.getFeeStats).toHaveBeenCalled();
    const methods = onRpcCall.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(methods.join()).toContain("getFeeStats");
  });
});

describe("withRpcRetry", () => {
  it("retries getFeeStats", async () => {
    const getFeeStats = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("503"), { status: 503 }))
      .mockResolvedValue({ ok: true });
    const proxy: any = withRpcRetry({ getFeeStats } as any, { baseDelayMs: 1 } as any);
    await expect(proxy.getFeeStats()).resolves.toEqual({ ok: true });
    expect(getFeeStats).toHaveBeenCalledTimes(2);
  });
});
