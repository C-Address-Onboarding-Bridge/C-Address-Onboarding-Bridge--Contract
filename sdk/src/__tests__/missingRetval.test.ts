import { OnboardingBridgeSDK } from "../bridge";

const ADDR = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

function makeSdk(response: unknown) {
  const sdk = Object.create(OnboardingBridgeSDK.prototype) as any;
  sdk.hooks = undefined;
  sdk.buildSimulationTx = () => ({});
  sdk.provider = { simulateTransaction: async () => response };
  return sdk;
}

describe("read wrappers reject a simulation with no retval", () => {
  const sdk = makeSdk({ results: [] });

  it.each([
    ["getFee", () => sdk.getFee(), "query_fee_bps"],
    ["getAdmin", () => sdk.getAdmin(), "query_admin"],
    ["isBlocked", () => sdk.isBlocked(ADDR), "query_is_blocked"],
    ["getFeeBalance", () => sdk.getFeeBalance(ADDR), "query_accrued_fees"],
  ])("%s throws", async (_n, call, method) => {
    await expect(call()).rejects.toThrow(`${method} returned no value`);
  });
});
