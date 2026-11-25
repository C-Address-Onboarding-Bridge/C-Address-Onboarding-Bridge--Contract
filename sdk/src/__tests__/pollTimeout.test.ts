import { OnboardingBridgeSDK } from "../bridge";
import {
  rpc,
} from "@stellar/stellar-sdk";

jest.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: jest.fn(),
  },
  Contract: jest.fn().mockImplementation(() => ({
    call: jest.fn().mockReturnValue({}),
  })),
  TransactionBuilder: jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue({}),
  })),
  Account: jest.fn().mockImplementation(() => ({})),
  xdr: {
    ScVal: {
      scvVoid: jest.fn().mockReturnValue({}),
      scvVec: jest.fn().mockReturnValue({}),
      scvBytes: jest.fn().mockReturnValue({}),
      scvMap: jest.fn().mockReturnValue({}),
      scvSymbol: jest.fn().mockReturnValue({}),
    },
    ScMapEntry: jest.fn().mockImplementation(() => ({})),
    LedgerKey: {
      account: jest.fn().mockReturnValue({}),
    },
    LedgerKeyAccount: jest.fn().mockImplementation(() => ({})),
  },
  Keypair: {
    fromPublicKey: jest.fn().mockReturnValue({
      xdrAccountId: jest.fn().mockReturnValue({}),
    }),
  },
  Address: jest.fn().mockImplementation(() => ({
    toScVal: jest.fn().mockReturnValue({}),
  })),
  nativeToScVal: jest.fn().mockReturnValue({}),
  scValToNative: jest.fn(),
  BASE_FEE: "100",
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
  StrKey: {
    isValidEd25519PublicKey: jest.fn(
      (addr: string) => addr?.startsWith("G") && addr.length === 56,
    ),
    isValidContract: jest.fn(
      (addr: string) => addr?.startsWith("C") && addr.length === 56,
    ),
  },
}));

const CONFIG = {
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  timeout: 5,
  retry: { baseDelayMs: 0, maxDelayMs: 0 },
};

const MOCK_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const MOCK_ASSET = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

describe("transaction polling timeout", () => {
  afterEach(() => jest.useRealTimers());

  it("commitFundAndWait resolves to failed when getTransaction is always NOT_FOUND", async () => {
    jest.useFakeTimers();
    const mockProvider: any = {
      getAccount: jest.fn().mockResolvedValue({}),
      prepareTransaction: jest.fn().mockResolvedValue({ sign: jest.fn() }),
      sendTransaction: jest
        .fn()
        .mockResolvedValue({ hash: "mock_tx_hash", status: "PENDING" }),
      getTransaction: jest.fn().mockResolvedValue({ status: "NOT_FOUND" }),
      simulateTransaction: jest.fn().mockResolvedValue({}),
      getLedgerEntries: jest.fn().mockResolvedValue({ entries: [], latestLedger: 1 }),
    };
    (rpc.Server as jest.Mock).mockImplementation(() => mockProvider);
    const sdk = new OnboardingBridgeSDK(CONFIG);
    const keypair: any = { publicKey: () => MOCK_ADDRESS, sign: jest.fn() };

    const promise = sdk.commitFundAndWait(
      {
        source: MOCK_ADDRESS,
        target: MOCK_ASSET,
        asset: MOCK_ASSET,
        amountHash: "ab".repeat(32),
        deadline: 123456,
      },
      keypair,
    );

    await jest.advanceTimersByTimeAsync(60_000);
    const result: any = await promise;

    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/not found after 15s \(expired or dropped\)/);
    // bounded: initial poll + 15 retries
    expect(mockProvider.getTransaction).toHaveBeenCalledTimes(16);
  });
});
