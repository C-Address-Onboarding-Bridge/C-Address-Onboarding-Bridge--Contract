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
  Networks,
} from '@stellar/stellar-sdk';

export class OnboardingBridgeSDK {
  private config: BridgeConfig;
  private contract: Contract;
  private provider: SorobanRpc.Server;
  private networkPassphrase: string;

  constructor(config: BridgeConfig) {
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
   * Batch fund multiple C-addresses from a single source in one transaction.
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
   * Withdraw accumulated fees from the bridge contract.
   * Only the fee collector can call this.
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
