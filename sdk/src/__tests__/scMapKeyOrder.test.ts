import { OnboardingBridgeSDK } from '../bridge';
import type { MetaFundParams, FeeTier } from '../types';

// Deliberately does NOT mock `@stellar/stellar-sdk` — these tests decode real
// XDR to verify the host-required invariant that `ScMap` entries are sorted
// by key. See #676: a `#[contracttype]` struct is encoded as an `ScMap`, and
// Soroban's canonical XDR encoding requires those keys to be sorted; the host
// rejects any map whose keys are out of order.

const CONFIG = {
  contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
};

const MOCK_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const MOCK_ASSET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

function mapKeyOrder(scVal: any): string[] {
  return scVal.map().map((entry: any) => entry.key().sym().toString());
}

describe('ScMap key ordering (canonical XDR)', () => {
  let sdk: OnboardingBridgeSDK;

  beforeEach(() => {
    sdk = new OnboardingBridgeSDK(CONFIG);
  });

  it('encodes MetaFundParams with sorted map keys', () => {
    const params: MetaFundParams = {
      source: MOCK_ADDRESS,
      target: MOCK_ASSET,
      asset: MOCK_ASSET,
      amount: '1000',
      nonce: 1,
      deadline: 9999999999,
    };

    const scVal = (sdk as any).metaFundParamsToScVal(params);
    const keys = mapKeyOrder(scVal);

    expect(keys).toEqual(['amount', 'asset', 'deadline', 'nonce', 'source', 'target']);
    // Sorted order is required for any valid ScMap encoding.
    expect(keys).toEqual([...keys].sort());
  });

  it('encodes FeeTier with sorted map keys', () => {
    const tier: FeeTier = {
      fee_bps: 25,
      max_volume: '1000000',
      min_volume: '0',
    };

    const scVal = (sdk as any).feeTierToScVal(tier);
    const keys = mapKeyOrder(scVal);

    expect(keys).toEqual(['fee_bps', 'max_volume', 'min_volume']);
    expect(keys).toEqual([...keys].sort());
  });
});
