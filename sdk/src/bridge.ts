import {
  BridgeConfig,
  FundCOptions,
  BatchFundCOptions,
  WithdrawFeesOptions,
  UpgradeOptions,
  TransactionResult,
} from './types';
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

/**
 * Client for building, simulating, signing, and submitting C-Address Onboarding Bridge contract calls.
 *
 * @example
 * const sdk = new OnboardingBridgeSDK({
 *   contractId: 'CA...',
 *   rpcUrl: 'https://soroban-testnet.stellar.org',
 *   networkPassphrase: Networks.TESTNET,
 * });
 */
export class OnboardingBridgeSDK {
  private config: BridgeConfig;
  private contract: Contract;
  private provider: SorobanRpc.Server;
  private networkPassphrase: string;

/**
 * Creates a bridge SDK client for one deployed contract and network.
 *
 * @param config - Contract ID, RPC endpoint, network passphrase, and optional timeout values used by every call.
 * @throws If the provided contract ID or RPC URL cannot be used by the Stellar SDK constructor.
 */
  constructor(config: BridgeConfig) {
    this.config = config;
    this.contract = new Contract(config.contractId);
    this.provider = new SorobanRpc.Server(config.rpcUrl);
    this.networkPassphrase = config.networkPassphrase;
  }

  /**
 * Funds a single C-address through the bridge contract.
 *
 * The source account signs the transaction and must be valid on the configured network. The contract calculates fees and emits funding events after successful execution.
 *
 * @param options - Source account, target C-address, asset contract address, and amount to route.
 * @param sourceKeypair - Signer for the source account. It must expose the Stellar SDK keypair signing API.
 * @returns Transaction hash and status. Failed submissions return status `failed` with an error message.
 * @throws This method normalizes caught errors into `TransactionResult`; constructor or SDK setup errors may still throw before submission.
 * @example
 * const result = await sdk.fundCAddress(
 *   { source: 'GA...', target: 'CC...', asset: 'CD...', amount: '10000000' },
 *   sourceKeypair,
 * );
 */
  async fundCAddress(
    options: FundCOptions,
    sourceKeypair: any,
  ): Promise<TransactionResult> {
    try {
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
 * Funds multiple target C-addresses in one bridge contract transaction.
 *
 * @param options - Source account, target C-address list, matching amount list, and shared asset contract address.
 * @param sourceKeypair - Signer for the source account funding the batch.
 * @returns Transaction hash and status for the submitted batch transaction.
 * @throws This method returns a failed `TransactionResult` for caught RPC, signing, or contract errors.
 * @example
 * await sdk.batchFundCAddresses({ source: 'GA...', targets: ['CC...'], amounts: ['10000000'], asset: 'CD...' }, sourceKeypair);
 */
  async batchFundCAddresses(
    options: BatchFundCOptions,
    sourceKeypair: any,
  ): Promise<TransactionResult> {
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
 * Withdraws accumulated bridge fees for one asset.
 *
 * @param options - Asset contract address and amount to withdraw.
 * @param feeCollectorKeypair - Authorized fee collector signer.
 * @returns Transaction hash and status for the withdrawal transaction.
 * @throws This method returns a failed `TransactionResult` for caught authorization, RPC, or contract errors.
 * @example
 * await sdk.withdrawFees({ asset: 'CD...', amount: '5000000' }, feeCollectorKeypair);
 */
  async withdrawFees(
    options: WithdrawFeesOptions,
    feeCollectorKeypair: any,
  ): Promise<TransactionResult> {
    try {
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
 * Reads the configured bridge fee in basis points.
 *
 * @returns Current fee basis points, where 100 basis points equals 1%.
 * @throws If Soroban simulation fails or returns no value.
 * @example
 * const feeBps = await sdk.getFee();
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
 * Reads the fee collector address configured on the bridge contract.
 *
 * @returns Fee collector Stellar/Soroban address as a string.
 * @throws If Soroban simulation fails or returns no value.
 * @example
 * const collector = await sdk.getFeeCollector();
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
 * Reads the current bridge administrator address.
 *
 * @returns Admin address as a string.
 * @throws If Soroban simulation fails or returns no value.
 * @example
 * const admin = await sdk.getAdmin();
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
 * Reads a token balance for a C-address through the bridge contract query path.
 *
 * @param cAddress - C-address whose balance should be queried.
 * @param asset - Asset or token contract address to query.
 * @returns Balance as an integer string.
 * @throws If Soroban simulation fails or returns no value.
 * @example
 * const balance = await sdk.getCAddressBalance('CC...', 'CD...');
 */
  async getCAddressBalance(
    cAddress: string,
    asset: string,
  ): Promise<string> {
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
 * Updates the bridge fee basis points. Admin only.
 *
 * @param newFeeBps - New fee in basis points. The contract enforces its maximum.
 * @param adminKeypair - Current admin signer.
 * @returns Transaction hash and status for the admin update.
 * @throws This method returns a failed `TransactionResult` for caught authorization, validation, RPC, or contract errors.
 * @example
 * await sdk.setFee(50, adminKeypair);
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
 * Updates the address that can withdraw accumulated fees. Admin only.
 *
 * @param newFeeCollector - New fee collector address.
 * @param adminKeypair - Current admin signer.
 * @returns Transaction hash and status for the admin update.
 * @throws This method returns a failed `TransactionResult` for caught authorization, RPC, or contract errors.
 * @example
 * await sdk.setFeeCollector('G...', adminKeypair);
 */
  async setFeeCollector(
    newFeeCollector: string,
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
 * Transfers bridge administration to a new address. Admin only.
 *
 * @param newAdmin - Address that should become the new contract admin.
 * @param adminKeypair - Current admin signer authorizing the transfer.
 * @returns Transaction hash and status for the admin update.
 * @throws This method returns a failed `TransactionResult` for caught authorization, RPC, or contract errors.
 * @example
 * await sdk.setAdmin('G...', adminKeypair);
 */
  async setAdmin(
    newAdmin: string,
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
        status: response.status === 'PENDING' ? 'success' : 'pending',
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
 * Converts JavaScript arguments into Soroban `ScVal` values for contract invocation.
 *
 * @param args - JavaScript argument list to convert recursively.
 * @returns Soroban XDR values suitable for `Contract.call`.
 * @throws If an unsupported value cannot be converted by `nativeToScVal`.
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
