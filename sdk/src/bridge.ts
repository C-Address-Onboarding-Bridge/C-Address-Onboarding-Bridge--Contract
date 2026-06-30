/**
 * @fileoverview Main SDK class for the C-Address Onboarding Bridge contract.
 *
 * {@link OnboardingBridgeSDK} wraps every public contract function in a
 * TypeScript method that handles account lookup, transaction building,
 * simulation, signing, submission, and automatic RPC retries.
 *
 * @module bridge
 */

import {
  BridgeConfig,
  FundCOptions,
  BatchFundCOptions,
  BatchProgressCallback,
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
  CostEstimate,
} from './types';

/**
 * Maximum number of `(target, amount)` pairs that can be included in a single
 * `batch_fund_c_address` contract call.  Matches the `MAX_BATCH_SIZE` constant
 * enforced on-chain (100).
 *
 * When {@link OnboardingBridgeSDK.batchFundCAddresses} is called with more
 * entries than this limit, it automatically splits the list into chunks of this
 * size and submits one transaction per chunk.
 */
export const BATCH_TX_LIMIT = 100;
import { assertAccountAddress, assertContractAddress } from './validate';
import { withRpcRetry } from './retry';
import {
  SorobanRpc,
  Contract,
  xdr,
  Address,
  Account,
  Keypair,
  nativeToScVal,
  scValToNative,
  TransactionBuilder,
  BASE_FEE,
} from '@stellar/stellar-sdk';

/**
 * TypeScript SDK for the C-Address Onboarding Bridge Soroban contract.
 *
 * Provides typed wrappers around every contract function.  Mutating methods
 * return a {@link TransactionResult} and never throw — errors are surfaced
 * through `result.status === 'failed'`.  Read-only query methods throw on
 * RPC or contract error so you can use standard `try/catch` patterns.
 *
 * All RPC calls are automatically retried on transient network failures using
 * exponential backoff with full jitter (see {@link withRpcRetry}).  The retry
 * policy is configurable via `BridgeConfig.retry`.
 *
 * @example
 * ```ts
 * import { OnboardingBridgeSDK } from '@stellar/c-address-onboarding-bridge-sdk';
 * import { Keypair, Networks } from '@stellar/stellar-sdk';
 *
 * const sdk = new OnboardingBridgeSDK({
 *   contractId: 'CA...',
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: Networks.TESTNET,
 * });
 *
 * const keypair = Keypair.fromSecret(process.env.SECRET!);
 * const result = await sdk.fundCAddress(
 *   { source: keypair.publicKey(), target: 'CC...', asset: 'CD...', amount: '1000000' },
 *   keypair,
 * );
 * if (result.status === 'failed') console.error(result.error);
 * ```
 */
export class OnboardingBridgeSDK {
  private config: BridgeConfig;
  private contract: Contract;
  private provider: SorobanRpc.Server;
  private networkPassphrase: string;

  /**
   * Create a new SDK instance.
   *
   * Validates `config.contractId` immediately and throws if it is not a valid
   * Stellar C-address.  No network call is made during construction.
   *
   * @param config - SDK configuration: contract ID, RPC URL, network passphrase,
   *                 and optional timeout / retry settings.
   *
   * @throws {Error} If `config.contractId` is not a valid contract address.
   *
   * @example
   * ```ts
   * const sdk = new OnboardingBridgeSDK({
   *   contractId: 'CA...',
   *   rpcUrl: 'https://soroban-testnet.stellar.org',
   *   networkPassphrase: Networks.TESTNET,
   *   retry: { maxRetries: 5 },
   * });
   * ```
   */
  constructor(config: BridgeConfig) {
    assertContractAddress(config.contractId, 'contractId');
    this.config = config;
    this.contract = new Contract(config.contractId);
    // Wrap the provider so every RPC call automatically retries transient
    // failures (network/timeout/rate-limit) with exponential backoff + jitter.
    // Reads use an aggressive policy; writes use a conservative one (see retry.ts).
    this.provider = withRpcRetry(
      new SorobanRpc.Server(config.rpcUrl),
      config.retry,
    );
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
   * Fund a single C-address from a source G-address.
   *
   * Transfers `options.amount` of `options.asset` from `source` into the
   * bridge contract, deducts the protocol fee, and forwards the net amount to
   * `target`.  The source account must authorise the token transfer — this is
   * handled automatically by Soroban's `require_auth` mechanism when the
   * transaction is signed with `sourceKeypair`.
   *
   * @param options      - Transfer parameters: source, target, asset, amount.
   * @param sourceKeypair - Keypair of the source account.  Used to sign the
   *                        transaction.  Must correspond to `options.source`.
   *
   * @returns A {@link TransactionResult} with `status: 'pending'` on successful
   *          submission, or `status: 'failed'` with an `error` message.
   *          Poll `SorobanRpc.Server.getTransaction(result.hash)` to confirm
   *          finality before showing success to the user.
   *
   * @throws Never — errors are returned as `status: 'failed'`.
   *
   * @example
   * ```ts
   * const result = await sdk.fundCAddress(
   *   {
   *     source: keypair.publicKey(),
   *     target: 'CC...',
   *     asset:  'CD...usdc',
   *     amount: '10000000', // 1 USDC (7 decimal places)
   *   },
   *   keypair,
   * );
   *
   * if (result.status === 'failed') {
   *   console.error('Transfer failed:', result.error);
   * } else {
   *   console.log('Submitted tx:', result.hash);
   * }
   * ```
   */
  async fundCAddress(
    options: FundCOptions,
    sourceKeypair: Keypair,
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
   * Fund multiple C-addresses from a single source account, automatically
   * splitting large batches across multiple transactions.
   *
   * When the number of `options.targets` exceeds {@link BATCH_TX_LIMIT}, the
   * list is split into chunks of at most `BATCH_TX_LIMIT` entries and one
   * on-chain `batch_fund_c_address` transaction is submitted per chunk.  This
   * means a single call to `batchFundCAddresses` may submit **multiple**
   * transactions and returns an array of {@link TransactionResult} — one entry
   * per submitted transaction, in order.
   *
   * Within each chunk the contract pulls the sum of that chunk's amounts from
   * `source` upfront.  For targets that fail access control the corresponding
   * amount is refunded to `source` and a `BatchTransferFailed` event is emitted.
   * A `BatchCompleted` event is emitted at the end of each on-chain transaction.
   *
   * `options.targets` and `options.amounts` must be the same length.
   *
   * @param options       - Batch transfer parameters: source, targets, amounts, asset.
   * @param sourceKeypair - Keypair of the source account used to sign every transaction.
   * @param onProgress    - Optional callback invoked after each transaction is
   *                        submitted.  Receives the cumulative count of recipients
   *                        processed, the total recipient count, and the tx hash
   *                        (or `undefined` if submission failed before a hash was
   *                        returned).
   *
   * @returns An array of {@link TransactionResult}, one per submitted transaction.
   *          If the entire batch fits in a single transaction the array has one
   *          element.  On a per-chunk submission error the corresponding element
   *          has `status: 'failed'`; processing continues with the remaining chunks.
   *
   * @throws Never — errors are returned as `status: 'failed'` in the results array.
   *
   * @example
   * ```ts
   * // Small batch — fits in one tx
   * const [result] = await sdk.batchFundCAddresses(
   *   {
   *     source:  keypair.publicKey(),
   *     targets: ['CC...1', 'CC...2', 'CC...3'],
   *     amounts: ['5000000', '3000000', '2000000'],
   *     asset:   'CD...usdc',
   *   },
   *   keypair,
   * );
   *
   * // Large batch — auto-split with progress reporting
   * const results = await sdk.batchFundCAddresses(
   *   { source: keypair.publicKey(), targets: largeTargetList, amounts: largeAmountList, asset: 'CD...' },
   *   keypair,
   *   (completed, total, txHash) => {
   *     console.log(`Processed ${completed}/${total} recipients — tx: ${txHash}`);
   *   },
   * );
   * ```
   */
  async batchFundCAddresses(
    options: BatchFundCOptions,
    sourceKeypair: Keypair,
    onProgress?: BatchProgressCallback,
  ): Promise<TransactionResult[]> {
    // Validate inputs before splitting so we fail fast on bad input.
    try {
      assertAccountAddress(options.source, 'source');
      options.targets.forEach((t, i) => assertContractAddress(t, `targets[${i}]`));
      assertContractAddress(options.asset, 'asset');
    } catch (error: any) {
      return [{ hash: '', status: 'failed', error: error.message || 'Unknown error' }];
    }

    const total = options.targets.length;
    const results: TransactionResult[] = [];
    let completed = 0;

    // Split targets/amounts into chunks of at most BATCH_TX_LIMIT.
    for (let offset = 0; offset < total; offset += BATCH_TX_LIMIT) {
      const chunkTargets = options.targets.slice(offset, offset + BATCH_TX_LIMIT);
      const chunkAmounts = options.amounts.slice(offset, offset + BATCH_TX_LIMIT);

      let result: TransactionResult;
      try {
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
                chunkTargets,
                chunkAmounts,
                options.asset,
              ]),
            ),
          )
          .setTimeout(30)
          .build();

        const preparedTx = await this.provider.prepareTransaction(tx);
        preparedTx.sign(sourceKeypair);

        const response = await this.provider.sendTransaction(preparedTx);

        result = {
          hash: response.hash,
          status: response.status === 'ERROR' ? 'failed' : 'pending',
        };
      } catch (error: any) {
        result = {
          hash: '',
          status: 'failed',
          error: error.message || 'Unknown error',
        };
      }

      results.push(result);
      completed += chunkTargets.length;

      if (onProgress) {
        onProgress(
          completed,
          total,
          result.hash || undefined,
        );
      }
    }

    return results;
  }

  /**
   * Withdraw accumulated protocol fees from the bridge contract.
   *
   * Only the configured fee-collector address may call this method.  Fees
   * accumulate in the contract after every successful `fund_c_address` or
   * `batch_fund_c_address` call.
   *
   * @param options            - Asset and amount to withdraw.
   * @param feeCollectorKeypair - Keypair of the fee-collector account.
   *
   * @returns A {@link TransactionResult}.
   *
   * @throws Never — errors are returned as `status: 'failed'`.
   *
   * @example
   * ```ts
   * const balance = await sdk.getFeeBalance('CD...usdc');
   * const result  = await sdk.withdrawFees(
   *   { asset: 'CD...usdc', amount: balance },
   *   feeCollectorKeypair,
   * );
   * ```
   */
  async withdrawFees(
    options: WithdrawFeesOptions,
    feeCollectorKeypair: Keypair,
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
   * Reclaim tokens accidentally sent directly to the bridge contract address.
   *
   * Admin only.  This is an emergency recovery tool — it moves the contract's
   * raw token balance (minus any accrued fees for that asset) to `options.to`.
   *
   * @param options     - Asset, amount, and destination address.
   * @param adminKeypair - Keypair of the admin account.
   *
   * @returns A {@link TransactionResult}.
   *
   * @throws Never — errors are returned as `status: 'failed'`.
   *
   * @example
   * ```ts
   * await sdk.reclaimTokens(
   *   { asset: 'CD...', amount: '1000000', to: 'G...safeAddress' },
   *   adminKeypair,
   * );
   * ```
   */
  async reclaimTokens(
    options: ReclaimTokensOptions,
    adminKeypair: Keypair,
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
   * Get the current protocol fee in basis points (bps).
   *
   * 1 bps = 0.01%, so `50` means a 0.5% fee is deducted from each transfer.
   * The maximum allowed value is 1000 (10%).
   *
   * @returns The fee in basis points as a `number`.
   *
   * @throws {Error} On RPC failure or contract error.
   *
   * @example
   * ```ts
   * const feeBps = await sdk.getFee();
   * console.log(`Current fee: ${feeBps / 100}%`);
   * ```
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
   * Get the current fee-collector G-address.
   *
   * The fee collector is the only account authorised to call `withdrawFees`.
   *
   * @returns The fee-collector G-address as a string.
   *
   * @throws {Error} On RPC failure or contract error.
   *
   * @example
   * ```ts
   * const collector = await sdk.getFeeCollector();
   * console.log('Fee collector:', collector);
   * ```
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
   * Get the current admin G-address.
   *
   * The admin account is authorised to update fee rates, fee collector, admin
   * address, asset whitelist, access control lists, and to upgrade the contract.
   *
   * @returns The admin G-address as a string.
   *
   * @throws {Error} On RPC failure or contract error.
   *
   * @example
   * ```ts
   * const admin = await sdk.getAdmin();
   * console.log('Admin:', admin);
   * ```
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
   * Query the token balance of any address (G-address or C-address) for a
   * given asset, using the bridge contract's `query_balance` view function.
   *
   * @param cAddress - The address to query (G-address or C-address).
   * @param asset    - Token contract address to check the balance for.
   *
   * @returns The balance in the token's smallest unit as a decimal string.
   *
   * @throws {Error} If either address is invalid or on RPC failure.
   *
   * @example
   * ```ts
   * const balance = await sdk.getCAddressBalance('CC...', 'CD...usdc');
   * console.log('Balance:', balance); // e.g. '10000000' = 1 USDC
   * ```
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
   * Get the accumulated (uncollected) fee balance held by the contract for a
   * specific asset.
   *
   * Use this before calling `withdrawFees` to know the exact withdrawable amount.
   *
   * @param asset - Token contract address.
   *
   * @returns The accrued fee balance in the token's smallest unit as a string.
   *
   * @throws {Error} If `asset` is not a valid contract address or on RPC failure.
   *
   * @example
   * ```ts
   * const fees = await sdk.getFeeBalance('CD...usdc');
   * console.log('Uncollected fees:', fees);
   * ```
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
   * Get the contract's token balances for multiple assets in a single RPC call.
   *
   * Returns a plain object mapping each asset contract address to its balance
   * string.  Useful for dashboard or monitoring use-cases.
   *
   * @param assets - Array of token contract addresses to query.
   *
   * @returns A `Record<assetAddress, balanceString>`.
   *          Assets with a zero balance are included with value `'0'`.
   *
   * @throws {Error} If any address in `assets` is invalid or on RPC failure.
   *
   * @example
   * ```ts
   * const balances = await sdk.getAllBalances(['CD...usdc', 'CD...xlm']);
   * // { 'CD...usdc': '1200000', 'CD...xlm': '500000000' }
   * ```
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
   * Check whether the bridge contract has been initialized.
   *
   * The contract must be initialized (via `initialize`) before any funding
   * operations are permitted.  Use this after deployment to verify the contract
   * is ready for use.
   *
   * @returns `true` if the contract has been initialized, `false` otherwise.
   *
   * @throws {Error} On RPC failure.
   *
   * @example
   * ```ts
   * const ready = await sdk.isInitialized();
   * if (!ready) throw new Error('Contract not initialized yet');
   * ```
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
   * Update the protocol fee rate (admin only).
   *
   * The new fee takes effect on the next `fund_c_address` call.
   * Maximum allowed value is 1000 bps (10%).
   *
   * @param newFeeBps   - New fee in basis points (0–1000).
   * @param adminKeypair - Keypair of the admin account.
   *
   * @returns A {@link TransactionResult}.
   *
   * @throws Never — errors are returned as `status: 'failed'`.
   *
   * @example
   * ```ts
   * await sdk.setFee(75, adminKeypair); // set to 0.75%
   * ```
   */
  async setFee(
    newFeeBps: number,
    adminKeypair: Keypair,
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
   * Rotate the fee-collector address (admin only).
   *
   * The new fee collector immediately gains the right to call `withdrawFees`.
   * The old fee collector loses it.
   *
   * @param newFeeCollector - G-address of the new fee collector.
   * @param adminKeypair    - Keypair of the admin account.
   *
   * @returns A {@link TransactionResult}.
   *
   * @throws Never — errors are returned as `status: 'failed'`.
   *
   * @example
   * ```ts
   * await sdk.setFeeCollector('G...newCollector', adminKeypair);
   * ```
   */
  async setFeeCollector(
    newFeeCollector: string,
    adminKeypair: Keypair,
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
   * Transfer the admin role to a new G-address (admin only).
   *
   * After this call the old admin loses all privileged access.  Ensure the new
   * admin keypair is accessible before calling this — there is no recovery path
   * if the new admin key is lost.
   *
   * @param newAdmin     - G-address of the new admin.
   * @param adminKeypair - Keypair of the current admin account.
   *
   * @returns A {@link TransactionResult}.
   *
   * @throws Never — errors are returned as `status: 'failed'`.
   *
   * @example
   * ```ts
   * await sdk.setAdmin('G...newAdmin', adminKeypair);
   * ```
   */
  async setAdmin(
    newAdmin: string,
    adminKeypair: Keypair,
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
    adminKeypair: Keypair,
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
    relayerKeypair: Keypair,
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

  /** 
   * Register an Ed25519 relayer public key on the contract (admin only).
   *
   * Registered relayers are authorised to submit attestation signatures for
   * cross-chain events via `fundCrosschain`.  After adding, update the threshold
   * with `setRelayerThreshold` if needed.
   *
   * @param options      - Contains the 32-byte Ed25519 pubkey as a hex string.
   * @param adminKeypair - Keypair of the admin account.
   *
   * @returns A {@link TransactionResult}.
   *
   * @throws Never — errors are returned as `status: 'failed'`.
   */
  async addRelayer(options: RelayerManagementOptions, adminKeypair: Keypair): Promise<TransactionResult> {
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

  /**
   * Remove a previously registered Ed25519 relayer public key (admin only).
   *
   * The removed key can no longer contribute valid signatures for cross-chain
   * attestations.  Ensure the remaining relayer set still meets the threshold
   * or lower the threshold first.
   *
   * @param options      - Contains the 32-byte Ed25519 pubkey as a hex string.
   * @param adminKeypair - Keypair of the admin account.
   *
   * @returns A {@link TransactionResult}.
   *
   * @throws Never — errors are returned as `status: 'failed'`.
   */
  async removeRelayer(options: RelayerManagementOptions, adminKeypair: Keypair): Promise<TransactionResult> {
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

  /**
   * Set the M-of-N relayer threshold (admin only).
   *
   * Cross-chain attestations require at least `threshold` valid signatures from
   * registered relayers.  Must not exceed the total number of registered relayers.
   *
   * @param threshold    - Minimum number of valid relayer signatures required.
   * @param adminKeypair - Keypair of the admin account.
   *
   * @returns A {@link TransactionResult}.
   *
   * @throws Never — errors are returned as `status: 'failed'`.
   *
   * @example
   * ```ts
   * // Require 2-of-3 relayers
   * await sdk.setRelayerThreshold(2, adminKeypair);
   * ```
   */
  async setRelayerThreshold(threshold: number, adminKeypair: Keypair): Promise<TransactionResult> {
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

  /**
   * Query the current M-of-N relayer threshold.
   *
   * @returns The threshold as a `number` (M in M-of-N).
   *
   * @throws {Error} On RPC failure.
   */
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
   * Create a new Soroban smart-contract account (C-address).
   *
   * Calls the bridge contract's `create_contract` helper which deploys a new
   * account contract and derives its C-address from the deployer's address and
   * an optional salt.  If `options.initialFunds` is provided, a `fund_c_address`
   * call is made immediately after creation so the new account has a starting
   * balance.
   *
   * @param options - Deployer keypair, optional deterministic salt, and optional
   *                  initial funding parameters.
   *
   * @returns A {@link CreateCAddressResult} with the new C-address and creation tx hash.
   *
   * @throws {Error} If contract creation or the subsequent fund call fails.
   *
   * @example
   * ```ts
   * const { cAddress, txHash } = await sdk.createCAddress({
   *   deployerKeypair: keypair,
   *   initialFunds: { asset: 'CD...usdc', amount: '10000000' },
   * });
   * console.log('New C-address:', cAddress);
   * ```
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

  /**
   * Check whether a given Ed25519 public key is a registered relayer.
   *
   * @param pubkeyHex - 32-byte Ed25519 public key as a lowercase hex string.
   *
   * @returns `true` if the pubkey is registered, `false` otherwise.
   *
   * @throws {Error} On RPC failure.
   */
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
   * Only whitelisted assets can be used in `fundCAddress` and batch calls.
   * The full list is fetched from the contract and paginated client-side.
   *
   * @param cursor - Opaque cursor from a previous call.  Omit to start from page 1.
   * @param limit  - Maximum items per page.  Defaults to 20.
   *
   * @returns A {@link PaginatedResult} containing asset C-addresses for this page.
   *
   * @throws {Error} On RPC failure.
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
   * Fee-exempt addresses pay zero protocol fee on every transfer regardless of
   * the configured `fee_bps`.  The full list is fetched from the contract and
   * paginated client-side.
   *
   * @param cursor - Opaque cursor from a previous call.  Omit to start from page 1.
   * @param limit  - Maximum items per page.  Defaults to 20.
   *
   * @returns A {@link PaginatedResult} of address strings.
   *
   * @throws {Error} On RPC failure.
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
   *
   * Blocklisted addresses cannot receive funds via `fundCAddress` or batch calls.
   * Transfers to them are silently skipped (in batch) or rejected (single).
   *
   * @param cursor - Opaque cursor from a previous call.  Omit to start from page 1.
   * @param limit  - Maximum items per page.  Defaults to 20.
   *
   * @returns A {@link PaginatedResult} of address strings.
   *
   * @throws {Error} On RPC failure.
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
   *
   * When the contract is in allowlist mode, only allowlisted addresses can
   * receive funds.  Non-allowlisted targets in batch calls are skipped and
   * their amounts refunded to the source.
   *
   * @param cursor - Opaque cursor from a previous call.  Omit to start from page 1.
   * @param limit  - Maximum items per page.  Defaults to 20.
   *
   * @returns A {@link PaginatedResult} of address strings.
   *
   * @throws {Error} On RPC failure.
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
   * Convert an array of JavaScript values to Soroban `ScVal` XDR values.
   *
   * Handles strings (G-/C-addresses, numeric strings, plain strings), numbers,
   * bigints, `Address` instances, arrays (→ `scvVec`), and `null`/`undefined`
   * (→ `scvVoid`).
   *
   * @param args - Values to convert.
   * @returns Array of `xdr.ScVal` suitable for passing to `Contract.call`.
   * @internal
   * Estimate the transaction cost for a `fundCAddress` call without submitting
   * it to the network.
   *
   * Runs `simulateTransaction` under the hood and extracts the Soroban resource
   * fee, the base inclusion fee, and the minimum account balance required.
   *
   * @example
   * ```ts
   * const estimate = await sdk.estimateCost({
   *   source: keypair.publicKey(),
   *   target: 'CC...',
   *   asset: 'CD...',
   *   amount: '10000000',
   * });
   * console.log('Resource fee:', estimate.resourceFee, 'stroops');
   * console.log('Total fee:   ', estimate.fee, 'stroops');
   * ```
   */
  async estimateCost(options: FundCOptions): Promise<CostEstimate> {
    assertAccountAddress(options.source, 'source');
    assertContractAddress(options.target, 'target');
    assertContractAddress(options.asset, 'asset');

    const start = Date.now();

    // Build a simulation transaction from a well-known zero-sequence account
    // so we don't need the caller to have an on-chain account just to estimate.
    const dummySource = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
    const dummyAccount = new Account(dummySource, '0');

    const tx = new TransactionBuilder(dummyAccount, {
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

    const result = await this.provider.simulateTransaction(tx);
    const executionTimeMs = Date.now() - start;

    if ('error' in result && result.error) {
      throw new Error(`Cost estimation failed: ${result.error}`);
    }

    // Extract fees from simulation result
    // SorobanRpc.Api.SimulateTransactionSuccessResponse shape:
    //   minResourceFee: string   (resource fee in stroops)
    //   cost: { cpuInsns, memBytes }
    const simResult = result as any;

    const resourceFee: string =
      simResult.minResourceFee != null
        ? String(simResult.minResourceFee)
        : '0';

    // The inclusion (base) fee is BASE_FEE plus any surge pricing
    const inclusionFee = simResult.cost?.feeCharged != null
      ? String(simResult.cost.feeCharged)
      : BASE_FEE;

    // Total fee = inclusion + resource
    const totalFee = String(
      BigInt(inclusionFee) + BigInt(resourceFee),
    );

    // Minimum balance: Stellar base reserve is 0.5 XLM per entry.
    // For a basic funded account the minimum is 1 XLM (2 base reserves).
    // 1 XLM = 10_000_000 stroops.
    const minBalance = '10000000';

    return {
      fee: totalFee,
      minBalance,
      resourceFee,
      executionTimeMs,
    };
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
