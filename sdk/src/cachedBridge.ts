/**
 * Cached SDK wrapper for the OnboardingBridge contract.
 *
 * This wrapper caches a small set of expensive read-only view methods and
 * invalidates them automatically when any state-changing transaction succeeds.
 */
import {
  BridgeConfig,
  TransactionResult,
} from './types';
import { assertAccountAddress, assertContractAddress } from './validate';
import { withRpcRetry } from './retry';
import {
  SorobanRpc,
  Contract,
  xdr,
  Keypair,
  scValToNative,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';
import { ICacheProvider, InMemoryCache } from './cache';
import { toScVals, buildSimulationTx as buildSharedSimTx } from './encoding';

export type CacheKey =
  | 'getFee'
  | 'getFeeCollector'
  | 'getAdmin'
  | 'isInitialized';

export interface CacheOptions {
  provider?: ICacheProvider;
  ttlMs?: Partial<Record<CacheKey, number>>;
}

const DEFAULT_TTL_MS: Record<CacheKey, number> = {
  getFee: 5 * 60 * 1000,
  getFeeCollector: 24 * 60 * 60 * 1000,
  getAdmin: 24 * 60 * 60 * 1000,
  isInitialized: 5 * 60 * 1000,
};

const CACHE_KEYS: CacheKey[] = [
  'getFee',
  'getFeeCollector',
  'getAdmin',
  'isInitialized',
];

/**
 * CachedContractClient caches a small set of view methods while delegating
 * all transaction logic to the underlying OnboardingBridge SDK implementation.
 */
export class CachedContractClient {
  private sdk: any;
  private cache: ICacheProvider;
  private ttls: Record<CacheKey, number>;

  constructor(config: BridgeConfig, options: CacheOptions = {}) {
    this.cache = options.provider ?? new InMemoryCache();
    this.ttls = { ...DEFAULT_TTL_MS, ...(options.ttlMs ?? {}) };

    this.sdk = new ContractClient(config, this.cache, this.ttls);
  }

  /**
   * Cached wrappers for the supported read-only SDK methods.
   */
  async getFee(): Promise<number> {
    return this.sdk.getFee();
  }

  async getFeeCollector(): Promise<string> {
    return this.sdk.getFeeCollector();
  }

  async getAdmin(): Promise<string> {
    return this.sdk.getAdmin();
  }

  async isInitialized(): Promise<boolean> {
    return this.sdk.isInitialized();
  }

  /**
   * Returns the wrapped ContractClient with a curated subset of transaction
   * methods: fundCAddress, fundCAddressWithSwap, withdrawFees, setFee,
   * setFeeCollector, setAdmin, and upgrade.
   *
   * For the full set of SDK methods (batch operations, cross-chain, relayers,
   * paginated queries, etc.), use
   * {@link OnboardingBridgeSDK} directly.
   */
  get client() {
    return this.sdk;
  }

  /**
   * Invalidate cached values by key or clear the entire cache.
   */
  async invalidateCache(keys?: CacheKey | CacheKey[]): Promise<void> {
    if (!keys) {
      await this.cache.clear();
      return;
    }

    const keysToDelete = Array.isArray(keys) ? keys : [keys];
    await Promise.all(keysToDelete.map((key) => this.cache.delete(key)));
  }
}

class ContractClient {
  private config: BridgeConfig;
  private cache: ICacheProvider;
  private ttls: Record<CacheKey, number>;
  private sdk: any;
  private contract: Contract;
  private provider: SorobanRpc.Server;
  private networkPassphrase: string;

  constructor(config: BridgeConfig, cache: ICacheProvider, ttls: Record<CacheKey, number>) {
    assertContractAddress(config.contractId, 'contractId');
    this.config = config;
    this.cache = cache;
    this.ttls = ttls;
    this.contract = new Contract(config.contractId);
    this.provider = withRpcRetry(
      new SorobanRpc.Server(config.rpcUrl),
      config.retry,
    );
    this.networkPassphrase = config.networkPassphrase;
  }

  async getFee(): Promise<number> {
    const cacheKey: CacheKey = 'getFee';
    const cached = await this.cache.get<number>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const result = await this.provider.simulateTransaction(
      this.buildSimulationTx('query_fee_bps', []),
    );
    if ('error' in result && result.error) {
      throw new Error(`Failed to get fee: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    const fee = scVal ? Number(scValToNative(scVal)) : 0;
    await this.cache.set(cacheKey, fee, this.ttls[cacheKey]);
    return fee;
  }

  async getFeeCollector(): Promise<string> {
    const cacheKey: CacheKey = 'getFeeCollector';
    const cached = await this.cache.get<string>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const result = await this.provider.simulateTransaction(
      this.buildSimulationTx('query_fee_collector', []),
    );
    if ('error' in result && result.error) {
      throw new Error(`Failed to get fee collector: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    const feeCollector = scVal ? scValToNative(scVal).toString() : '';
    await this.cache.set(cacheKey, feeCollector, this.ttls[cacheKey]);
    return feeCollector;
  }

  async getAdmin(): Promise<string> {
    const cacheKey: CacheKey = 'getAdmin';
    const cached = await this.cache.get<string>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const result = await this.provider.simulateTransaction(
      this.buildSimulationTx('query_admin', []),
    );
    if ('error' in result && result.error) {
      throw new Error(`Failed to get admin: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    const admin = scVal ? scValToNative(scVal).toString() : '';
    await this.cache.set(cacheKey, admin, this.ttls[cacheKey]);
    return admin;
  }

  async isInitialized(): Promise<boolean> {
    const cacheKey: CacheKey = 'isInitialized';
    const cached = await this.cache.get<boolean>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const result = await this.provider.simulateTransaction(
      this.buildSimulationTx('query_is_initialized', []),
    );
    if ('error' in result && result.error) {
      throw new Error(`Failed to check initialization: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    const initialized = scVal ? Boolean(scValToNative(scVal)) : false;
    await this.cache.set(cacheKey, initialized, this.ttls[cacheKey]);
    return initialized;
  }

  private async submitMutation(
    method: string,
    transactionBuilder: TransactionBuilder,
    signer: Keypair,
  ): Promise<TransactionResult> {
    const account = await this.provider.getAccount(signer.publicKey());
    const tx = transactionBuilder
      .setTimeout(this.config.timeout ?? 30)
      .build();
    const preparedTx = await this.provider.prepareTransaction(tx);
    preparedTx.sign(signer);
    const response = await this.provider.sendTransaction(preparedTx);

    if (response.status !== 'ERROR') {
      await Promise.all(CACHE_KEYS.map((key) => this.cache.delete(key)));
      void this.invalidateAfterConfirmation(response.hash);
    }

    return {
      hash: response.hash,
      status: response.status === 'ERROR' ? 'failed' : 'pending',
    };
  }

  private async invalidateAfterConfirmation(hash: string): Promise<void> {
    try {
      let result = await this.provider.getTransaction(hash);
      while (result.status === 'NOT_FOUND') {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        result = await this.provider.getTransaction(hash);
      }
      await Promise.all(CACHE_KEYS.map((key) => this.cache.delete(key)));
    } catch {
      // Cache was already invalidated on submission; confirmation invalidation
      // is best-effort and must not surface as an unhandled background error.
    }
  }

  async fundCAddress(options: any, sourceKeypair: Keypair): Promise<TransactionResult> {
    assertAccountAddress(options.source, 'source');
    assertContractAddress(options.target, 'target');
    assertContractAddress(options.asset, 'asset');

    const sourceAccount = await this.provider.getAccount(options.source);
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'fund_c_address',
          ...toScVals([options.source, options.target, options.asset, options.amount]),
        ),
      );

    return this.submitMutation('fundCAddress', tx, sourceKeypair);
  }

  async fundCAddressWithSwap(options: any, sourceKeypair: Keypair): Promise<TransactionResult> {
    assertAccountAddress(options.source, 'source');
    assertContractAddress(options.target, 'target');
    assertContractAddress(options.sourceAsset, 'sourceAsset');
    assertContractAddress(options.targetAsset, 'targetAsset');
    options.swapRoute.forEach((p: string, i: number) => assertContractAddress(p, `swapRoute[${i}]`));

    const sourceAccount = await this.provider.getAccount(options.source);
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call(
          'fund_c_address_with_swap',
          ...toScVals([
            options.source,
            options.target,
            options.sourceAsset,
            options.targetAsset,
            options.sourceAmount,
            options.minTargetAmount,
            options.swapRoute,
          ]),
        ),
      );

    return this.submitMutation('fundCAddressWithSwap', tx, sourceKeypair);
  }

  async withdrawFees(options: any, sourceKeypair: Keypair): Promise<TransactionResult> {
    assertContractAddress(options.asset, 'asset');
    const sourceAccount = await this.provider.getAccount(sourceKeypair.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call('withdraw_fees', ...this.toScVals([options.asset, options.amount]),
          options.nonce === undefined ? xdr.ScVal.scvVoid() : nativeToScVal(BigInt(options.nonce), { type: 'u64' })),
      );

    return this.submitMutation('withdrawFees', tx, sourceKeypair);
  }

  async setFee(newFeeBps: number, adminKeypair: Keypair): Promise<TransactionResult> {
    const adminAccount = await this.provider.getAccount(adminKeypair.publicKey());
    const tx = new TransactionBuilder(adminAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call('set_fee_bps', ...toScVals([newFeeBps])),
      );

    return this.submitMutation('setFee', tx, adminKeypair);
  }

  async setFeeCollector(newFeeCollector: string, adminKeypair: Keypair): Promise<TransactionResult> {
    assertAccountAddress(newFeeCollector, 'newFeeCollector');
    const adminAccount = await this.provider.getAccount(adminKeypair.publicKey());
    const tx = new TransactionBuilder(adminAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call('set_fee_collector', ...toScVals([newFeeCollector])),
      );

    return this.submitMutation('setFeeCollector', tx, adminKeypair);
  }

  async setAdmin(newAdmin: string, adminKeypair: Keypair): Promise<TransactionResult> {
    assertAccountAddress(newAdmin, 'newAdmin');
    const adminAccount = await this.provider.getAccount(adminKeypair.publicKey());
    const tx = new TransactionBuilder(adminAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        this.contract.call('set_admin', ...toScVals([newAdmin])),
      );

    return this.submitMutation('setAdmin', tx, adminKeypair);
  }

  async upgrade(options: any, adminKeypair: Keypair): Promise<TransactionResult> {
    if (!/^[0-9a-f]{64}$/i.test(options.newWasmHash)) {
      throw new Error('newWasmHash must be a 64-character hex string (32 bytes)');
    }
    const adminAccount = await this.provider.getAccount(adminKeypair.publicKey());
    const wasmHashBytes = Buffer.from(options.newWasmHash, 'hex');
    const wasmHashScVal = xdr.ScVal.scvBytes(wasmHashBytes);
    const nonceScVal = options.nonce === undefined
      ? xdr.ScVal.scvVoid()
      : nativeToScVal(BigInt(options.nonce), { type: 'u64' });

    const tx = new TransactionBuilder(adminAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call('upgrade', wasmHashScVal, nonceScVal));

    return this.submitMutation('upgrade', tx, adminKeypair);
  }

  private buildSimulationTx(method: string, args: any[]) {
    return buildSharedSimTx(this.contract, method, args, this.networkPassphrase, this.config.timeout ?? 30);
  }
}
