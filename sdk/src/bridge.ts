import {
  BridgeConfig,
  FundCOptions,
  BatchFundCOptions,
  WithdrawFeesOptions,
  UpgradeOptions,
  ReclaimTokensOptions,
  TransactionResult,
  CrossChainFundOptions,
  RelayerManagementOptions,
  CreateCOptions,
  CreateCAddressResult,
  FundCAddressWithSwapOptions,
  PaginatedResult,
  PaginationOptions,
} from './types';
import { assertAccountAddress, assertContractAddress } from './validate';
import {
  SorobanRpc,
  Contract,
  xdr,
  Address,
  Account,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';

export class OnboardingBridgeSDK {
  private config: BridgeConfig;
  private contract: Contract;
  private provider: SorobanRpc.Server;
  private networkPassphrase: string;

  constructor(config: BridgeConfig) {
    assertContractAddress(config.contractId, 'contractId');
    this.config = config;
    this.contract = new Contract(config.contractId);
    this.provider = new SorobanRpc.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Fund a C-address from a source account.
   * The source must have authorized the token transfer to the bridge contract.
   */
  async fundCAddress(
    options: FundCOptions,
    sourceKeypair: any,
  ): Promise<TransactionResult> {
    try {
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
            ...this.toScVals([
              options.source,
              options.target,
              options.asset,
              options.amount,
            ]),
          ),
        )
        .setTimeout(30)
        .build();

      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(sourceKeypair);

      const response = await this.provider.sendTransaction(preparedTx);

      return {
        hash: response.hash,
        status: response.status === 'ERROR' ? 'failed' : 'pending',
      };
    } catch (error: any) {
      return {
        hash: '',
        status: 'failed',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Fund a C-address by swapping the source asset into a different target asset first.
   *
   * Calls `fund_c_address_with_swap` on the bridge contract which:
   * 1. Pulls `sourceAmount` of `sourceAsset` from `source`.
   * 2. Routes it through the DEX pools in `swapRoute`.
   * 3. Deducts the fee in `targetAsset` and forwards the net to `target`.
   *
   * @example
   * ```ts
   * const result = await sdk.fundCAddressWithSwap(
   *   {
   *     source: keypair.publicKey(),
   *     target: 'CC...',
   *     sourceAsset: USDC_CONTRACT,
   *     targetAsset: XLM_CONTRACT,
   *     sourceAmount: '10000000', // 1 USDC
   *     minTargetAmount: '9000000', // 0.9 XLM (10% max slippage)
   *     swapRoute: [USDC_XLM_POOL],
   *   },
   *   keypair,
   * );
   * ```
   */
  async fundCAddressWithSwap(
    options: FundCAddressWithSwapOptions,
    sourceKeypair: any,
  ): Promise<TransactionResult> {
    try {
      assertAccountAddress(options.source, 'source');
      assertContractAddress(options.target, 'target');
      assertContractAddress(options.sourceAsset, 'sourceAsset');
      assertContractAddress(options.targetAsset, 'targetAsset');
      options.swapRoute.forEach((p, i) => assertContractAddress(p, `swapRoute[${i}]`));

      const sourceAccount = await this.provider.getAccount(options.source);

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'fund_c_address_with_swap',
            ...this.toScVals([
              options.source,
              options.target,
              options.sourceAsset,
              options.targetAsset,
              options.sourceAmount,
              options.minTargetAmount,
              options.swapRoute,
            ]),
          ),
        )
        .setTimeout(30)
        .build();

      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(sourceKeypair);

      const response = await this.provider.sendTransaction(preparedTx);

      return {
        hash: response.hash,
        status: response.status === 'ERROR' ? 'failed' : 'pending',
      };
    } catch (error: any) {
      return {
        hash: '',
        status: 'failed',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Batch fund multiple C-addresses from a single source in one transaction.
   */
  async batchFundCAddresses(
    options: BatchFundCOptions,
    sourceKeypair: any,
  ): Promise<TransactionResult> {
    try {
      assertAccountAddress(options.source, 'source');
      options.targets.forEach((t, i) => assertContractAddress(t, `targets[${i}]`));
      assertContractAddress(options.asset, 'asset');
      const sourceAccount = await this.provider.getAccount(options.source);

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'batch_fund_c_address',
            ...this.toScVals([
              options.source,
              options.targets,
              options.amounts,
              options.asset,
            ]),
          ),
        )
        .setTimeout(30)
        .build();

      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(sourceKeypair);

      const response = await this.provider.sendTransaction(preparedTx);

      return {
        hash: response.hash,
        status: response.status === 'ERROR' ? 'failed' : 'pending',
      };
    } catch (error: any) {
      return {
        hash: '',
        status: 'failed',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Withdraw accumulated fees from the bridge contract.
   * Only the fee collector can call this.
   */
  async withdrawFees(
    options: WithdrawFeesOptions,
    feeCollectorKeypair: any,
  ): Promise<TransactionResult> {
    try {
      assertContractAddress(options.asset, 'asset');
      const feeCollectorAccount = await this.provider.getAccount(
        feeCollectorKeypair.publicKey(),
      );

      const tx = new TransactionBuilder(feeCollectorAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'withdraw_fees',
            ...this.toScVals([options.asset, options.amount]),
          ),
        )
        .setTimeout(30)
        .build();

      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(feeCollectorKeypair);

      const response = await this.provider.sendTransaction(preparedTx);

      return {
        hash: response.hash,
        status: response.status === 'ERROR' ? 'failed' : 'pending',
      };
    } catch (error: any) {
      return {
        hash: '',
        status: 'failed',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Reclaim tokens accidentally sent to the contract (admin only).
   */
  async reclaimTokens(
    options: ReclaimTokensOptions,
    adminKeypair: any,
  ): Promise<TransactionResult> {
    try {
      assertContractAddress(options.asset, 'asset');
      assertAccountAddress(options.to, 'to');
      const adminAccount = await this.provider.getAccount(
        adminKeypair.publicKey(),
      );

      const tx = new TransactionBuilder(adminAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'reclaim_tokens',
            ...this.toScVals([options.asset, options.amount, options.to]),
          ),
        )
        .setTimeout(30)
        .build();

      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(adminKeypair);

      const response = await this.provider.sendTransaction(preparedTx);

      return {
        hash: response.hash,
        status: response.status === 'ERROR' ? 'failed' : 'pending',
      };
    } catch (error: any) {
      return {
        hash: '',
        status: 'failed',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Get the current fee in basis points.
   */
  async getFee(): Promise<number> {
    const result = await this.provider
      .simulateTransaction(
        this.buildSimulationTx('query_fee_bps', []),
      );

    if ('error' in result && result.error) {
      throw new Error(`Failed to get fee: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    return scVal ? Number(scValToNative(scVal)) : 0;
  }

  /**
   * Get the fee collector address.
   */
  async getFeeCollector(): Promise<string> {
    const result = await this.provider
      .simulateTransaction(
        this.buildSimulationTx('query_fee_collector', []),
      );

    if ('error' in result && result.error) {
      throw new Error(`Failed to get fee collector: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    return scVal ? scValToNative(scVal).toString() : '';
  }

  /**
   * Get the admin address.
   */
  async getAdmin(): Promise<string> {
    const result = await this.provider
      .simulateTransaction(
        this.buildSimulationTx('query_admin', []),
      );

    if ('error' in result && result.error) {
      throw new Error(`Failed to get admin: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    return scVal ? scValToNative(scVal).toString() : '';
  }

  /**
   * Query the balance of a C-address for a given asset.
   */
  async getCAddressBalance(
    cAddress: string,
    asset: string,
  ): Promise<string> {
    assertContractAddress(cAddress, 'cAddress');
    assertContractAddress(asset, 'asset');
    const result = await this.provider
      .simulateTransaction(
        this.buildSimulationTx('query_balance', [cAddress, asset]),
      );

    if ('error' in result && result.error) {
      throw new Error(`Failed to get balance: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    return scVal ? scValToNative(scVal).toString() : '0';
  }

  /**
   * Get the fee balance held by the contract for a given asset.
   */
  async getFeeBalance(asset: string): Promise<string> {
    assertContractAddress(asset, 'asset');
    const result = await this.provider
      .simulateTransaction(
        this.buildSimulationTx('query_fee_balance', [asset]),
      );

    if ('error' in result && result.error) {
      throw new Error(`Failed to get fee balance: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    return scVal ? scValToNative(scVal).toString() : '0';
  }

  /**
   * Get all token balances held by the contract for the given assets.
   * Returns a map of asset address → balance string.
   */
  async getAllBalances(assets: string[]): Promise<Record<string, string>> {
    assets.forEach((a, i) => assertContractAddress(a, `assets[${i}]`));
    const result = await this.provider
      .simulateTransaction(
        this.buildSimulationTx('query_all_balances', [assets]),
      );

    if ('error' in result && result.error) {
      throw new Error(`Failed to get all balances: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    if (!scVal) return {};

    const native = scValToNative(scVal) as Map<string, bigint>;
    const out: Record<string, string> = {};
    native.forEach((value, key) => {
      out[key] = value.toString();
    });
    return out;
  }

  /**
   * Check if the bridge contract is initialized.
   */
  async isInitialized(): Promise<boolean> {
    const result = await this.provider
      .simulateTransaction(
        this.buildSimulationTx('query_is_initialized', []),
      );

    if ('error' in result && result.error) {
      throw new Error(`Failed to check initialization: ${result.error}`);
    }

    const scVal = (result as any).results?.[0]?.retval;
    return scVal ? Boolean(scValToNative(scVal)) : false;
  }

  /**
   * Set the fee in basis points (admin only).
   */
  async setFee(
    newFeeBps: number,
    adminKeypair: any,
  ): Promise<TransactionResult> {
    try {
      const adminAccount = await this.provider.getAccount(
        adminKeypair.publicKey(),
      );

      const tx = new TransactionBuilder(adminAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'set_fee_bps',
            ...this.toScVals([newFeeBps]),
          ),
        )
        .setTimeout(30)
        .build();

      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(adminKeypair);

      const response = await this.provider.sendTransaction(preparedTx);

      return {
        hash: response.hash,
        status: response.status === 'ERROR' ? 'failed' : 'pending',
      };
    } catch (error: any) {
      return {
        hash: '',
        status: 'failed',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Set the fee collector address (admin only).
   */
  async setFeeCollector(
    newFeeCollector: string,
    adminKeypair: any,
  ): Promise<TransactionResult> {
    try {
      assertAccountAddress(newFeeCollector, 'newFeeCollector');
      const adminAccount = await this.provider.getAccount(
        adminKeypair.publicKey(),
      );

      const tx = new TransactionBuilder(adminAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'set_fee_collector',
            ...this.toScVals([newFeeCollector]),
          ),
        )
        .setTimeout(30)
        .build();

      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(adminKeypair);

      const response = await this.provider.sendTransaction(preparedTx);

      return {
        hash: response.hash,
        status: response.status === 'ERROR' ? 'failed' : 'pending',
      };
    } catch (error: any) {
      return {
        hash: '',
        status: 'failed',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Set the admin address (admin only).
   */
  async setAdmin(
    newAdmin: string,
    adminKeypair: any,
  ): Promise<TransactionResult> {
    try {
      assertAccountAddress(newAdmin, 'newAdmin');
      const adminAccount = await this.provider.getAccount(
        adminKeypair.publicKey(),
      );

      const tx = new TransactionBuilder(adminAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'set_admin',
            ...this.toScVals([newAdmin]),
          ),
        )
        .setTimeout(30)
        .build();

      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(adminKeypair);

      const response = await this.provider.sendTransaction(preparedTx);

      return {
        hash: response.hash,
        status: response.status === 'ERROR' ? 'failed' : 'pending',
      };
    } catch (error: any) {
      return {
        hash: '',
        status: 'failed',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * Upgrade the contract to a new wasm implementation (admin only).
   * The new_wasm_hash must reference wasm already uploaded to the network.
   * Preserves all instance storage (admin, fee settings, etc.).
   */
  async upgrade(
    options: UpgradeOptions,
    adminKeypair: any,
  ): Promise<TransactionResult> {
    try {
      const adminAccount = await this.provider.getAccount(
        adminKeypair.publicKey(),
      );

      const wasmHashBytes = Buffer.from(options.newWasmHash, 'hex');
      const wasmHashScVal = xdr.ScVal.scvBytes(wasmHashBytes);

      const tx = new TransactionBuilder(adminAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call('upgrade', wasmHashScVal),
        )
        .setTimeout(30)
        .build();

      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(adminKeypair);

      const response = await this.provider.sendTransaction(preparedTx);

      return {
        hash: response.hash,
        status: response.status === 'ERROR' ? 'failed' : 'pending',
      };
    } catch (error: any) {
      return {
        hash: '',
        status: 'failed',
        error: error.message || 'Unknown error',
      };
    }
  }

  // --- Cross-chain methods ---

  /**
   * Fund a C-address from a cross-chain event (called by the relayer service).
   * Requires at least `threshold` valid relayer signatures over the canonical payload hash.
   */
  async fundCrosschain(
    options: CrossChainFundOptions,
    relayerKeypair: any,
  ): Promise<TransactionResult> {
    try {
      const relayerAccount = await this.provider.getAccount(relayerKeypair.publicKey());

      const sigsScVal = xdr.ScVal.scvVec(
        options.sigs.map((s) => {
          const pubkeyBytes = Buffer.from(s.pubkey, 'hex');
          const sigBytes = Buffer.from(s.signature, 'hex');
          return xdr.ScVal.scvMap([
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('pubkey'), val: xdr.ScVal.scvBytes(pubkeyBytes) }),
            new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol('signature'), val: xdr.ScVal.scvBytes(sigBytes) }),
          ]);
        }),
      );

      const txHashBytes = Buffer.from(options.txHash.replace('0x', ''), 'hex');

      const tx = new TransactionBuilder(relayerAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'fund_c_address_crosschain',
            nativeToScVal(options.chainId, { type: 'u32' }),
            xdr.ScVal.scvBytes(txHashBytes),
            new Address(options.target).toScVal(),
            new Address(options.asset).toScVal(),
            nativeToScVal(BigInt(options.amount), { type: 'i128' }),
            sigsScVal,
          ),
        )
        .setTimeout(30)
        .build();

      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(relayerKeypair);
      const response = await this.provider.sendTransaction(preparedTx);

      return { hash: response.hash, status: response.status === 'ERROR' ? 'failed' : 'pending' };
    } catch (error: any) {
      return { hash: '', status: 'failed', error: error.message || 'Unknown error' };
    }
  }

  /** Register an Ed25519 relayer pubkey (admin only). */
  async addRelayer(options: RelayerManagementOptions, adminKeypair: any): Promise<TransactionResult> {
    try {
      const adminAccount = await this.provider.getAccount(adminKeypair.publicKey());
      const tx = new TransactionBuilder(adminAccount, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
        .addOperation(this.contract.call('add_relayer', xdr.ScVal.scvBytes(Buffer.from(options.pubkey, 'hex'))))
        .setTimeout(30)
        .build();
      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(adminKeypair);
      const response = await this.provider.sendTransaction(preparedTx);
      return { hash: response.hash, status: response.status === 'ERROR' ? 'failed' : 'pending' };
    } catch (error: any) {
      return { hash: '', status: 'failed', error: error.message || 'Unknown error' };
    }
  }

  /** Remove an Ed25519 relayer pubkey (admin only). */
  async removeRelayer(options: RelayerManagementOptions, adminKeypair: any): Promise<TransactionResult> {
    try {
      const adminAccount = await this.provider.getAccount(adminKeypair.publicKey());
      const tx = new TransactionBuilder(adminAccount, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
        .addOperation(this.contract.call('remove_relayer', xdr.ScVal.scvBytes(Buffer.from(options.pubkey, 'hex'))))
        .setTimeout(30)
        .build();
      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(adminKeypair);
      const response = await this.provider.sendTransaction(preparedTx);
      return { hash: response.hash, status: response.status === 'ERROR' ? 'failed' : 'pending' };
    } catch (error: any) {
      return { hash: '', status: 'failed', error: error.message || 'Unknown error' };
    }
  }

  /** Set the M-of-N relayer threshold (admin only). Must not exceed total relayer count. */
  async setRelayerThreshold(threshold: number, adminKeypair: any): Promise<TransactionResult> {
    try {
      const adminAccount = await this.provider.getAccount(adminKeypair.publicKey());
      const tx = new TransactionBuilder(adminAccount, { fee: BASE_FEE, networkPassphrase: this.networkPassphrase })
        .addOperation(this.contract.call('set_relayer_threshold', nativeToScVal(threshold, { type: 'u32' })))
        .setTimeout(30)
        .build();
      const preparedTx = await this.provider.prepareTransaction(tx);
      preparedTx.sign(adminKeypair);
      const response = await this.provider.sendTransaction(preparedTx);
      return { hash: response.hash, status: response.status === 'ERROR' ? 'failed' : 'pending' };
    } catch (error: any) {
      return { hash: '', status: 'failed', error: error.message || 'Unknown error' };
    }
  }

  /** Query the current relayer threshold (M in M-of-N). */
  async queryRelayerThreshold(): Promise<number> {
    const result = await this.provider.simulateTransaction(
      this.buildSimulationTx('query_relayer_threshold', []),
    );
    if ('error' in result && result.error) {
      throw new Error(`Failed to query relayer threshold: ${result.error}`);
    }
    const scVal = (result as any).results?.[0]?.retval;
    return scVal ? Number(scValToNative(scVal)) : 0;
  }

  /**
   * Create a new C-address (smart contract account) using Soroban's create_contract.
   * Optionally funds the C-address immediately after creation.
   */
  async createCAddress(
    options: CreateCOptions,
  ): Promise<CreateCAddressResult> {
    const deployerKeypair = options.deployerKeypair;
    const deployerAccount = await this.provider.getAccount(
      deployerKeypair.publicKey(),
    );

    const saltBytes = options.salt
      ? Buffer.from(options.salt, 'hex')
      : Buffer.from(
          Array.from({ length: 32 }, () =>
            Math.floor(Math.random() * 256),
          ),
        );
    const saltScVal = xdr.ScVal.scvBytes(saltBytes);

    const deployerAddress = new Address(deployerKeypair.publicKey());

    const txBuilder = new TransactionBuilder(deployerAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });

    txBuilder.addOperation(
      this.contract.call(
        'create_contract',
        deployerAddress.toScVal(),
        saltScVal,
      ),
    );

    const deployTx = txBuilder.setTimeout(30).build();
    const preparedDeployTx = await this.provider.prepareTransaction(deployTx);
    preparedDeployTx.sign(deployerKeypair);

    const deployResponse = await this.provider.sendTransaction(preparedDeployTx);
    if (deployResponse.status === 'ERROR') {
      throw new Error(`Failed to create C-address: ${deployResponse.status}`);
    }

    let txResult = await this.provider.getTransaction(deployResponse.hash);
    while (txResult.status === 'NOT_FOUND') {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      txResult = await this.provider.getTransaction(deployResponse.hash);
    }

    if (txResult.status !== 'SUCCESS') {
      throw new Error(`C-address creation failed: ${txResult.status}`);
    }

    const returnVal = (txResult as any).returnValue;
    const cAddress: string = returnVal
      ? scValToNative(returnVal).toString()
      : '';

    if (options.initialFunds && cAddress) {
      const fundAccount = await this.provider.getAccount(
        deployerKeypair.publicKey(),
      );
      const fundTx = new TransactionBuilder(fundAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.networkPassphrase,
      })
        .addOperation(
          this.contract.call(
            'fund_c_address',
            ...this.toScVals([
              deployerKeypair.publicKey(),
              cAddress,
              options.initialFunds.asset,
              options.initialFunds.amount,
            ]),
          ),
        )
        .setTimeout(30)
        .build();

      const preparedFundTx = await this.provider.prepareTransaction(fundTx);
      preparedFundTx.sign(deployerKeypair);
      await this.provider.sendTransaction(preparedFundTx);
    }

    return {
      cAddress,
      txHash: deployResponse.hash,
    };
  }

  /** Query whether a given Ed25519 pubkey (hex) is a registered relayer. */
  async queryIsRelayer(pubkeyHex: string): Promise<boolean> {
    const result = await this.provider.simulateTransaction(
      this.buildSimulationTx('query_is_relayer', [Buffer.from(pubkeyHex, 'hex')]),
    );
    if ('error' in result && result.error) {
      throw new Error(`Failed to query relayer: ${result.error}`);
    }
    const scVal = (result as any).results?.[0]?.retval;
    return scVal ? Boolean(scValToNative(scVal)) : false;
  }

  // ---------------------------------------------------------------------------
  // Pagination helpers
  // ---------------------------------------------------------------------------

  /**
   * Encode a numeric offset as an opaque base64 cursor token.
   * @internal
   */
  private encodeCursor(offset: number): string {
    return Buffer.from(String(offset)).toString('base64');
  }

  /**
   * Decode a base64 cursor back to a numeric offset.
   * Returns 0 for an undefined/invalid cursor.
   * @internal
   */
  private decodeCursor(cursor?: string): number {
    if (!cursor) return 0;
    const n = parseInt(Buffer.from(cursor, 'base64').toString('utf8'), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  /**
   * Slice a full list into a paginated page.
   * @internal
   */
  private paginate<T>(items: T[], offset: number, limit: number): PaginatedResult<T> {
    const page = items.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < items.length;
    return {
      items: page,
      cursor: hasMore ? this.encodeCursor(nextOffset) : undefined,
      hasMore,
    };
  }

  /**
   * Return a paginated list of whitelisted asset contract addresses.
   *
   * Soroban contracts return full vectors; pagination is applied client-side.
   *
   * @example
   * ```ts
   * let page = await sdk.getWhitelistedAssets();
   * while (page.hasMore) {
   *   page = await sdk.getWhitelistedAssets(page.cursor);
   * }
   * ```
   */
  async getWhitelistedAssets(
    cursor?: string,
    limit = 20,
  ): Promise<PaginatedResult<string>> {
    const result = await this.provider.simulateTransaction(
      this.buildSimulationTx('query_whitelisted_assets', []),
    );
    if ('error' in result && result.error) {
      throw new Error(`Failed to query whitelisted assets: ${result.error}`);
    }
    const scVal = (result as any).results?.[0]?.retval;
    const all: string[] = scVal
      ? (scValToNative(scVal) as Address[]).map((a) => a.toString())
      : [];
    return this.paginate(all, this.decodeCursor(cursor), limit);
  }

  /**
   * Return a paginated list of fee-exempt addresses.
   *
   * Fee-exempt addresses are stored individually in contract storage under
   * `DataKey::FeeExempt(address)`. The SDK queries the full list via
   * `query_fee_exempt_addresses` and paginates client-side.
   */
  async getFeeExemptAddresses(
    cursor?: string,
    limit = 20,
  ): Promise<PaginatedResult<string>> {
    const result = await this.provider.simulateTransaction(
      this.buildSimulationTx('query_fee_exempt_addresses', []),
    );
    if ('error' in result && result.error) {
      throw new Error(`Failed to query fee-exempt addresses: ${result.error}`);
    }
    const scVal = (result as any).results?.[0]?.retval;
    const all: string[] = scVal
      ? (scValToNative(scVal) as Address[]).map((a) => a.toString())
      : [];
    return this.paginate(all, this.decodeCursor(cursor), limit);
  }

  /**
   * Return a paginated list of addresses on the blocklist.
   */
  async getBlocklistedAddresses(
    cursor?: string,
    limit = 20,
  ): Promise<PaginatedResult<string>> {
    const result = await this.provider.simulateTransaction(
      this.buildSimulationTx('query_blocklist', []),
    );
    if ('error' in result && result.error) {
      throw new Error(`Failed to query blocklist: ${result.error}`);
    }
    const scVal = (result as any).results?.[0]?.retval;
    const all: string[] = scVal
      ? (scValToNative(scVal) as Address[]).map((a) => a.toString())
      : [];
    return this.paginate(all, this.decodeCursor(cursor), limit);
  }

  /**
   * Return a paginated list of addresses on the allowlist.
   */
  async getAllowlistedAddresses(
    cursor?: string,
    limit = 20,
  ): Promise<PaginatedResult<string>> {
    const result = await this.provider.simulateTransaction(
      this.buildSimulationTx('query_allowlist', []),
    );
    if ('error' in result && result.error) {
      throw new Error(`Failed to query allowlist: ${result.error}`);
    }
    const scVal = (result as any).results?.[0]?.retval;
    const all: string[] = scVal
      ? (scValToNative(scVal) as Address[]).map((a) => a.toString())
      : [];
    return this.paginate(all, this.decodeCursor(cursor), limit);
  }

  /**
   * Convert JavaScript values to Soroban SCVals.
   */
  private toScVals(args: any[]): xdr.ScVal[] {
    return args.map((arg) => {
      if (arg === null || arg === undefined) {
        return xdr.ScVal.scvVoid();
      }

      if (Array.isArray(arg)) {
        return xdr.ScVal.scvVec(
          arg.map((item) => this.toSingleScVal(item)),
        );
      }

      return this.toSingleScVal(arg);
    });
  }

  private toSingleScVal(arg: any): xdr.ScVal {
    if (typeof arg === 'string') {
      if (arg.startsWith('C') || arg.startsWith('G')) {
        return new Address(arg).toScVal();
      }
      if (/^\d+$/.test(arg)) {
        return nativeToScVal(BigInt(arg), { type: 'i128' });
      }
      return nativeToScVal(arg, { type: 'string' });
    }
    if (typeof arg === 'number') {
      return nativeToScVal(arg, { type: 'i128' });
    }
    if (typeof arg === 'bigint') {
      return nativeToScVal(arg, { type: 'i128' });
    }
    if (arg instanceof Address) {
      return arg.toScVal();
    }
    return nativeToScVal(arg);
  }

  private buildSimulationTx(method: string, args: any[]) {
    const source = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const account = new Account(source, '0');
    return new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...this.toScVals(args)))
      .setTimeout(30)
      .build();
  }
}
