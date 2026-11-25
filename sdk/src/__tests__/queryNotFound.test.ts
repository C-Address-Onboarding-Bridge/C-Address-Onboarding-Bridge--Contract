import { Contract, scValToNative, Networks } from "@stellar/stellar-sdk";
import { OnboardingBridgeSDK } from "../bridge";

const CONTRACT_ID = "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526";

function makeSdk(simulate: jest.Mock) {
  const sdk = Object.create(OnboardingBridgeSDK.prototype) as any;
  sdk.hooks = { onRpcCall: jest.fn() }; // avoids the return-in-finally in withRpcHook when no hook is set
  sdk.config = {};
  sdk.networkPassphrase = Networks.TESTNET;
  sdk.contract = new Contract(CONTRACT_ID);
  sdk.provider = { simulateTransaction: simulate };
  sdk.buildSimulationTxWithScVals = (method: string, args: any[]) => ({ method, args });
  return sdk as OnboardingBridgeSDK;
}

describe("queryTimelocked", () => {
  it("encodes the full u64 for ids above 2^53", async () => {
    const simulate = jest.fn().mockResolvedValue({});
    await makeSdk(simulate).queryTimelocked(2n ** 60n);
    const tx = simulate.mock.calls[0][0];
    const op: any = tx.operations[0];
    const arg = op.func.invokeContract().args()[0];
    expect(scValToNative(arg)).toBe(2n ** 60n);
  });

  it("resolves null for TimelockNotFound (#19)", async () => {
    const simulate = jest.fn().mockResolvedValue({ error: "HostError: Error(Contract, #19)" });
    await expect(makeSdk(simulate).queryTimelocked(1)).resolves.toBeNull();
  });

  it("rethrows other errors", async () => {
    const simulate = jest.fn().mockResolvedValue({ error: "HostError: Error(Contract, #10)" });
    await expect(makeSdk(simulate).queryTimelocked(1)).rejects.toThrow(
      "Failed to query timelocked entry",
    );
  });
});

describe("queryCommitment", () => {
  it("resolves null for CommitmentNotFound (#30)", async () => {
    const simulate = jest.fn().mockResolvedValue({ error: "HostError: Error(Contract, #30)" });
    await expect(makeSdk(simulate).queryCommitment(1)).resolves.toBeNull();
  });

  it("rethrows other errors", async () => {
    const simulate = jest.fn().mockResolvedValue({ error: "HostError: Error(Contract, #19)" });
    await expect(makeSdk(simulate).queryCommitment(1)).rejects.toThrow("Failed to get commitment");
  });
});
