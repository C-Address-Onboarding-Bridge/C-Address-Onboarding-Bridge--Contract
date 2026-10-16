import { OnboardingBridgeSDK } from '../bridge';

describe('OnboardingBridgeSDK constructor', () => {
  it('constructs with the installed Stellar SDK', () => {
    expect(
      () =>
        new OnboardingBridgeSDK({
          contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
          rpcUrl: 'https://soroban-testnet.stellar.org',
          networkPassphrase: 'Test SDF Network ; September 2015',
        }),
    ).not.toThrow();
  });
});
