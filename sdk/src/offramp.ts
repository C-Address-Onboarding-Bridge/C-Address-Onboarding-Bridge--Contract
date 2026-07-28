/**
 * @fileoverview Off-ramp and on-ramp integration helpers.
 *
 * {@link OffRampIntegration} builds widget URLs for MoonPay, Transak, Ramp
 * Network, and Banxa so users can buy or sell crypto directly to/from a
 * Stellar C-address or G-address.  It also provides CEX deposit memo helpers
 * for routing centralized-exchange withdrawals through the bridge.
 *
 * @module offramp
 */

import {
  OffRampConfig,
  OffRampProvider,
  OnRampUrlParams,
  OffRampUrlParams,
  ProviderConfig,
  ProviderComparison,
} from './types';
import { assertAccountAddress, assertContractAddress } from './validate';

/**
 * Builds on-ramp and off-ramp widget URLs for multiple fiat-to-crypto
 * (and crypto-to-fiat) providers, and provides CEX deposit memo helpers.
 *
 * Construct once with your API keys and reuse across the application.
 * All URL-building methods are synchronous — no network call is made.
 *
 * Supported providers: **MoonPay**, **Transak**, **Ramp Network**, **Banxa**.
 *
 * @example
 * ```ts
 * import { OffRampIntegration } from '@stellar/c-address-onboarding-bridge-sdk';
 *
 * const offramp = new OffRampIntegration({
 *   moonpayApiKey: process.env.MOONPAY_KEY,
 *   transakApiKey: process.env.TRANSAK_KEY,
 *   testMode: process.env.NODE_ENV !== 'production',
 * });
 *
 * // On-ramp: user pays $100 USD, receives XLM at their C-address
 * const url = offramp.getOnRampUrl({
 *   provider: 'moonpay',
 *   amount: '100',
 *   fiatCurrency: 'USD',
 *   asset: 'XLM',
 *   cAddress: 'CC...',
 * });
 * window.open(url);
 * ```
 */
export class OffRampIntegration {
  private config: OffRampConfig;

  /**
   * Create a new OffRampIntegration instance.
   *
   * @param config - API keys for the providers you intend to use, and an
   *                 optional `testMode` flag to route traffic to sandbox URLs.
   */
  constructor(config: OffRampConfig) {
    this.config = config;
  }

  /**
   * Build a widget URL for purchasing crypto with fiat (on-ramp).
   *
   * Redirects the user to the selected provider's checkout page where they pay
   * with a credit card or bank transfer and receive `params.asset` at
   * `params.cAddress` on Stellar.
   *
   * @param params - Provider, fiat amount, fiat currency, crypto asset, and
   *                 destination C-address.
   *
   * @returns A fully-formed URL string ready for `window.open()` or a webview.
   *
   * @throws {Error} If `params.provider` is not one of the supported values.
   *
   * @example
   * ```ts
   * const url = offramp.getOnRampUrl({
   *   provider: 'transak',
   *   amount: '50',
   *   fiatCurrency: 'EUR',
   *   asset: 'USDC',
   *   cAddress: 'CC...',
   * });
   * ```
   */
  getOnRampUrl(params: OnRampUrlParams): string {
    assertContractAddress(params.cAddress, 'cAddress');
    switch (params.provider) {
      case 'moonpay':
        return this.getMoonpayOnRampUrl(params);
      case 'transak':
        return this.getTransakOnRampUrl(params);
      case 'ramp':
        return this.getRampOnRampUrl(params);
      case 'banxa':
        return this.getBanxaOnRampUrl(params);
      default:
        throw new Error(`Unsupported provider: ${params.provider}`);
    }
  }

  /**
   * Build a widget URL for selling crypto for fiat (off-ramp).
   *
   * Redirects the user to the selected provider's sell page where they send
   * `params.asset` from `params.gAddress` and receive fiat currency.
   *
   * @param params - Provider, crypto amount, crypto asset, fiat currency, and
   *                 source G-address.
   *
   * @returns A fully-formed URL string.
   *
   * @throws {Error} If `params.provider` is not one of the supported values.
   *
   * @example
   * ```ts
   * const url = offramp.getOffRampUrl({
   *   provider: 'moonpay',
   *   amount: '10',
   *   asset: 'XLM',
   *   fiatCurrency: 'USD',
   *   gAddress: 'G...',
   * });
   * ```
   */
  getOffRampUrl(params: OffRampUrlParams): string {
    assertAccountAddress(params.gAddress, 'gAddress');
    switch (params.provider) {
      case 'moonpay':
        return this.getMoonpayOffRampUrl(params);
      case 'transak':
        return this.getTransakOffRampUrl(params);
      case 'ramp':
        return this.getRampOffRampUrl(params);
      case 'banxa':
        return this.getBanxaOffRampUrl(params);
      default:
        throw new Error(`Unsupported provider: ${params.provider}`);
    }
  }

  /**
   * Get the static capability configuration for a provider.
   *
   * Returns supported assets, fiat currencies, countries, amount limits, fee
   * percentage, and test-mode availability.  Useful for rendering provider
   * selection UI or filtering by user's country and preferred currency.
   *
   * @param provider - The provider to look up.
   *
   * @returns A {@link ProviderConfig} object with the provider's capabilities.
   *
   * @example
   * ```ts
   * const config = offramp.getProviderConfig('moonpay');
   * console.log(config.supportedCountries); // ['US', 'GB', ...]
   * console.log(config.feePercentage);      // '4.5'
   * ```
   */
  getProviderConfig(provider: OffRampProvider): ProviderConfig {
    const configs: Record<OffRampProvider, ProviderConfig> = {
      moonpay: {
        provider: 'moonpay',
        supportedAssets: ['XLM', 'USDC', 'ETH', 'BTC'],
        supportedFiatCurrencies: [
          'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'SGD', 'HKD', 'JPY',
        ],
        supportedCountries: [
          'US', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'CH',
          'SE', 'NO', 'DK', 'FI', 'PL', 'AU', 'NZ', 'CA', 'SG', 'HK',
          'JP', 'KR', 'BR', 'MX',
        ],
        minAmount: '20',
        maxAmount: '50000',
        feePercentage: '4.5',
        testModeAvailable: true,
      },
      transak: {
        provider: 'transak',
        supportedAssets: ['XLM', 'USDC', 'ETH', 'BTC', 'MATIC', 'SOL'],
        supportedFiatCurrencies: [
          'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'INR', 'MXN', 'BRL',
        ],
        supportedCountries: [
          'US', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'AT', 'CH', 'SE',
          'AU', 'CA', 'IN', 'MX', 'BR', 'SG', 'HK', 'AE', 'SA',
        ],
        minAmount: '25',
        maxAmount: '100000',
        feePercentage: '3.9',
        testModeAvailable: true,
      },
      ramp: {
        provider: 'ramp',
        supportedAssets: ['XLM', 'USDC', 'ETH', 'BTC', 'DAI', 'USDT'],
        supportedFiatCurrencies: [
          'USD', 'EUR', 'GBP', 'SEK', 'NOK', 'DKK', 'CHF', 'PLN', 'CZK',
        ],
        supportedCountries: [
          'US', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'BE', 'AT', 'CH',
          'SE', 'NO', 'DK', 'FI', 'PL', 'CZ', 'SK', 'HU', 'RO',
        ],
        minAmount: '15',
        maxAmount: '20000',
        feePercentage: '2.9',
        testModeAvailable: false,
      },
      banxa: {
        provider: 'banxa',
        supportedAssets: ['XLM', 'USDC', 'ETH', 'BTC', 'ADA', 'DOGE'],
        supportedFiatCurrencies: [
          'USD', 'EUR', 'GBP', 'AUD', 'CAD', 'NZD', 'SGD', 'ZAR',
        ],
        supportedCountries: [
          'US', 'GB', 'DE', 'FR', 'AU', 'NZ', 'CA', 'SG', 'ZA', 'NL',
          'BE', 'AT', 'IT', 'ES', 'IE',
        ],
        minAmount: '10',
        maxAmount: '75000',
        feePercentage: '3.5',
        testModeAvailable: false,
      },
    };

    return configs[provider];
  }

  /**
   * Compare all providers for a given transaction and return fee/settlement data.
   *
   * Filters to providers that support both `asset` and `fiatCurrency`, then
   * calculates the fee amount, net amount, and approximate settlement time for
   * each.  Useful for rendering a "best rate" comparison UI.
   *
   * @param amount       - Gross fiat amount as a decimal string (e.g. `'100'`).
   * @param asset        - Crypto asset code (e.g. `'XLM'`, `'USDC'`).
   * @param fiatCurrency - ISO 4217 fiat currency code (default `'USD'`).
   *
   * @returns A partial record mapping each supported provider to a
   *          {@link ProviderComparison} object.  Providers that do not support
   *          the asset or currency are omitted.
   *
   * @example
   * ```ts
   * const results = offramp.compareProviders('100', 'XLM', 'USD');
   * // { moonpay: { feeAmount: '4.50', netAmount: '95.50', settlementTime: 2 }, ... }
   * ```
   */
  compareProviders(
    amount: string,
    asset: string,
    fiatCurrency: string = 'USD',
  ): Partial<Record<OffRampProvider, ProviderComparison>> {
    const amountNum = parseFloat(amount);
    const result: Partial<Record<OffRampProvider, ProviderComparison>> = {};

    const providers: OffRampProvider[] = ['moonpay', 'transak', 'ramp', 'banxa'];

    for (const provider of providers) {
      const config = this.getProviderConfig(provider);

      // Check if provider supports this asset
      if (!config.supportedAssets.includes(asset)) {
        continue;
      }

      // Check if provider supports this fiat currency
      if (!config.supportedFiatCurrencies.includes(fiatCurrency)) {
        continue;
      }

      // Calculate fees
      const feePercentage = parseFloat(config.feePercentage);
      const feeAmount = (amountNum * feePercentage) / 100;
      const netAmount = amountNum - feeAmount;

      // Settlement times vary by provider and method
      const settlementTimes: Record<OffRampProvider, number> = {
        moonpay: 2,
        transak: 3,
        ramp: 1,
        banxa: 4,
      };

      result[provider] = {
        feeAmount: feeAmount.toFixed(2),
        feePercentage: config.feePercentage,
        netAmount: netAmount.toFixed(2),
        settlementTime: settlementTimes[provider],
      };
    }

    return result;
  }

  private getMoonpayOnRampUrl(params: OnRampUrlParams): string {
    const baseUrl = this.config.testMode
      ? 'https://buy-staging.moonpay.com'
      : 'https://buy.moonpay.com';

    const url = new URL(baseUrl);
    url.searchParams.set('apiKey', this.config.moonpayApiKey || '');
    url.searchParams.set('currencyCode', params.asset);
    url.searchParams.set('baseCurrencyAmount', params.amount);
    url.searchParams.set('baseCurrencyCode', params.fiatCurrency);
    url.searchParams.set('walletAddress', params.cAddress);
    url.searchParams.set('showWalletAddressForm', 'false');

    return url.toString();
  }

  private getMoonpayOffRampUrl(params: OffRampUrlParams): string {
    const baseUrl = this.config.testMode
      ? 'https://sell-staging.moonpay.com'
      : 'https://sell.moonpay.com';

    const url = new URL(baseUrl);
    url.searchParams.set('apiKey', this.config.moonpayApiKey || '');
    url.searchParams.set('cryptoCurrencyCode', params.asset);
    url.searchParams.set('baseCurrencyCode', params.fiatCurrency);
    url.searchParams.set('walletAddress', params.gAddress);
    url.searchParams.set('refundWalletAddress', params.gAddress);

    return url.toString();
  }

  /**
   * @deprecated Use getOnRampUrl() instead
   * Generate a Moonpay purchase URL to fund a C-address via credit card.
   */
  getMoonpayUrl(params: {
    targetCAddress: string;
    amount: string;
    currency: string;
    assetCode?: string;
  }): string {
    return this.getMoonpayOnRampUrl({
      provider: 'moonpay',
      amount: params.amount,
      asset: params.assetCode || 'XLM',
      fiatCurrency: params.currency,
      cAddress: params.targetCAddress,
    });
  }

  private getTransakOnRampUrl(params: OnRampUrlParams): string {
    const baseUrl = this.config.testMode
      ? 'https://global-staging.transak.com'
      : 'https://global.transak.com';

    const url = new URL(baseUrl);
    url.searchParams.set('apiKey', this.config.transakApiKey || '');
    url.searchParams.set('defaultCryptoCurrency', params.asset);
    url.searchParams.set('walletAddress', params.cAddress);
    url.searchParams.set('defaultFiatAmount', params.amount);
    url.searchParams.set('fiatCurrency', params.fiatCurrency);
    url.searchParams.set('network', 'stellar');

    return url.toString();
  }

  private getTransakOffRampUrl(params: OffRampUrlParams): string {
    const baseUrl = this.config.testMode
      ? 'https://global-staging.transak.com'
      : 'https://global.transak.com';

    const url = new URL(baseUrl);
    url.searchParams.set('apiKey', this.config.transakApiKey || '');
    url.searchParams.set('defaultCryptoCurrency', params.asset);
    url.searchParams.set('walletAddress', params.gAddress);
    url.searchParams.set('fiatCurrency', params.fiatCurrency);
    url.searchParams.set('network', 'stellar');
    url.searchParams.set('isSellMode', 'true');

    return url.toString();
  }

  /**
   * @deprecated Use getOnRampUrl() instead
   * Generate a Transak purchase URL to fund a C-address via credit card.
   */
  getTransakUrl(params: {
    targetCAddress: string;
    amount: string;
    currency: string;
    fiatCurrency?: string;
  }): string {
    return this.getTransakOnRampUrl({
      provider: 'transak',
      amount: params.amount,
      asset: params.currency || 'XLM',
      fiatCurrency: params.fiatCurrency || 'USD',
      cAddress: params.targetCAddress,
    });
  }

  private getRampOnRampUrl(params: OnRampUrlParams): string {
    const baseUrl = 'https://buy.ramp.network';

    const url = new URL(baseUrl);
    url.searchParams.set('userAddress', params.cAddress);
    url.searchParams.set('assetCode', `${params.asset}_stellar`);
    url.searchParams.set('fiatCurrency', params.fiatCurrency);
    url.searchParams.set('fiatAmount', params.amount);
    if (this.config.rampApiKey) {
      url.searchParams.set('hostApiKey', this.config.rampApiKey);
    }

    return url.toString();
  }

  private getRampOffRampUrl(params: OffRampUrlParams): string {
    const baseUrl = 'https://sell.ramp.network';

    const url = new URL(baseUrl);
    url.searchParams.set('userAddress', params.gAddress);
    url.searchParams.set('assetCode', `${params.asset}_stellar`);
    url.searchParams.set('fiatCurrency', params.fiatCurrency);
    if (this.config.rampApiKey) {
      url.searchParams.set('hostApiKey', this.config.rampApiKey);
    }

    return url.toString();
  }

  private getBanxaOnRampUrl(params: OnRampUrlParams): string {
    const baseUrl = 'https://app.banxa.com';

    const url = new URL(baseUrl);
    url.searchParams.set('walletAddress', params.cAddress);
    url.searchParams.set('blockchain', 'stellar');
    url.searchParams.set('cryptoCurrency', params.asset);
    url.searchParams.set('fiatType', params.fiatCurrency);
    url.searchParams.set('fiatAmount', params.amount);
    if (this.config.banxaApiKey) {
      url.searchParams.set('apiKey', this.config.banxaApiKey);
    }

    return url.toString();
  }

  private getBanxaOffRampUrl(params: OffRampUrlParams): string {
    const baseUrl = 'https://app.banxa.com';

    const url = new URL(baseUrl);
    url.searchParams.set('walletAddress', params.gAddress);
    url.searchParams.set('blockchain', 'stellar');
    url.searchParams.set('cryptoCurrency', params.asset);
    url.searchParams.set('fiatType', params.fiatCurrency);
    url.searchParams.set('isSellMode', 'true');
    if (this.config.banxaApiKey) {
      url.searchParams.set('apiKey', this.config.banxaApiKey);
    }

    return url.toString();
  }

  /**
   * Generate a Stellar memo that encodes a target C-address for CEX routing.
   *
   * When a user withdraws from a centralized exchange to the bridge's G-address,
   * they must include this memo so the bridge can identify the intended
   * destination C-address.
   *
   * Memo format: `"bridge:<targetCAddress>"`
   *
   * @param targetCAddress - The C-address that should receive the bridged funds.
   *
   * @returns A memo string in the format `"bridge:<targetCAddress>"`.
   *
   * @example
   * ```ts
   * const memo = offramp.generateCEXDepositMemo('CC...');
   * // → 'bridge:CC...'
   * // User pastes this into their CEX withdrawal memo field
   * ```
   */
  generateCEXDepositMemo(targetCAddress: string): string {
    return `bridge:${targetCAddress}`;
  }

  /**
   * Decode a CEX deposit memo to extract the target C-address.
   *
   * Use this on the bridge relayer side when a Stellar payment arrives with a
   * memo to determine which C-address should receive the funds.
   *
   * @param memo - The raw memo string from the incoming Stellar payment.
   *
   * @returns The extracted C-address string, or `null` if the memo is not a
   *          valid bridge memo (i.e. does not start with `"bridge:"`).
   *
   * @example
   * ```ts
   * const target = offramp.decodeCEXDepositMemo('bridge:CC...');
   * // → 'CC...'
   *
   * const invalid = offramp.decodeCEXDepositMemo('some-other-memo');
   * // → null
   * ```
   */
  decodeCEXDepositMemo(memo: string): string | null {
    if (!memo.startsWith('bridge:')) {
      return null;
    }
    return memo.slice('bridge:'.length);
  }
}
