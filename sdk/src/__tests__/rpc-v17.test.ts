import { rpc } from '@stellar/stellar-sdk';
import { OnboardingBridgeSDK } from '../bridge';
import { EventSubscriber } from '../events';
import { CachedContractClient } from '../cachedBridge';

describe('@stellar/stellar-sdk v17 rpc namespace migration', () => {
  const rpcUrl = 'https://soroban-testnet.stellar.org';
  const contractId = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

  it('exposes rpc and rpc.Server on @stellar/stellar-sdk', () => {
    expect(rpc).toBeDefined();
    expect(rpc.Server).toBeDefined();
    expect(typeof rpc.Server).toBe('function');
  });

  it('instantiates OnboardingBridgeSDK with rpc.Server provider', () => {
    const sdk = new OnboardingBridgeSDK({
      contractId,
      rpcUrl,
      networkPassphrase: 'Test SDF Future Network ; October 2022',
    });
    expect(sdk).toBeDefined();
    expect((sdk as any).provider).toBeInstanceOf(rpc.Server);
    expect((sdk as any).provider.serverURL.toString()).toContain('soroban-testnet.stellar.org');
  });

  it('instantiates EventSubscriber with rpc.Server', () => {
    const subscriber = new EventSubscriber({
      contractId,
      rpcUrl,
    });
    expect(subscriber).toBeDefined();
    expect((subscriber as any).server).toBeInstanceOf(rpc.Server);
    expect((subscriber as any).server.serverURL.toString()).toContain('soroban-testnet.stellar.org');
  });

  it('instantiates CachedContractClient with rpc.Server', () => {
    const cachedClient = new CachedContractClient({
      contractId,
      rpcUrl,
      networkPassphrase: 'Test SDF Future Network ; October 2022',
    });
    expect(cachedClient).toBeDefined();
    expect((cachedClient.client as any).provider).toBeInstanceOf(rpc.Server);
  });
});
