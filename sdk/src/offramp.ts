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

import { createHmac } from 'crypto';
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
 * Sign a MoonPay widget URL server-side.
 *
 * MoonPay requires any URL that pre-fills `walletAddress` to carry a
 * `signature` query parameter: the HMAC-SHA256 of the URL's query string,
 * keyed by your MoonPay secret key.
 *
 * **SECURITY:** the `secretKey` must never be shipped to browsers or embedded
 * in client bundles.  Call this helper only from a trusted server (or a
 * serverless function) and hand the resulting signed URL to the client.
 *
 * @param url       - The unsigned widget URL (with or without a `signature`).
 * @param secretKey - Your MoonPay secret key. Server-side only.
 *
 * @returns The URL with a `signature` query parameter appended.
 *
 * @example
 * ```ts
 * // server-side only
 * const signed = signUrl(unsignedUrl, process.env.MOONPAY_SECRET_KEY!);
 * ```
 */
export function signUrl(url: string, secretKey: string): string {
  const queryIndex = url.indexOf('?');
  const query = queryIndex === -1 ? '' : url.slice(queryIndex + 1);
  const signature = createHmac('sha256', secretKey).update(query).digest('base64');
  const separator = queryIndex === -1 ? '?' : '&';
  return `${url}${separator}signature=${encodeURIComponent(signature)}`;
}

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
   * When `params.signer` is provided it is invoked with the built URL so the
   * caller can attach a server-side signature (see {@link signUrl}).  This is
   * required for MoonPay URLs that pre-fill `walletAddress`.
   *
   * @param params - Provider, fiat amount, fiat currency, crypto asset,
   *                 destination C-address, and an optional `signer` callback.
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
    let url: string;
    switch (params.provider) {
      case 'moonpay':
        url = this.getMoonpayOnRampUrl(params);
        break;
      case 'transak':
        url = this.getTransakOnRampUrl(params);
        break;
      case 'ramp':
        url = this.getRampOnRampUrl(params);
        break;
      case 'banxa':
        url = this.getBanxaOnRampUrl(params);
        break;
      default:
        throw new Error(`Unsupported provider: ${params.provider}`);
    }
    return params.signer ? params.signer(url) : url;
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
   *          {@link ProviderComparison}.
   */
  compareProviders(
    amount: string,
    asset: string,
    fiatCurrency: string = 'USD'
  ): Partial<Record<OffRampProvider, ProviderComparison>> {
    const providers: OffRampProvider[] = ['moonpay', 'transak', 'ramp', 'banxa'];
    const result: Partial<Record<OffRampProvider, ProviderComparison>> = {};

    for (const provider of providers) {
      const config = this.getProviderConfig(provider);
      if (
        !config.supportedAssets.includes(asset) ||
        !config.supportedFiatCurrencies.includes(fiatCurrency)
      ) {
        continue;
      }

      const gross = parseFloat(amount);
      const fee = (gross * parseFloat(config.feePercentage)) / 100;
      const net = gross - fee;

      result[provider] = {
        provider,
        feePercentage: config.feePercentage,
        feeAmount: fee.toFixed(2),
        netAmount: net.toFixed(2),
        estimatedTime: provider === 'moonpay' ? '5-10 min' : '10-30 min',
      };
    }

    return result;
  }

  /**
   * Build a MoonPay on-ramp URL.
   *
   * @internal
   */
  private getMoonpayOnRampUrl(params: OnRampUrlParams): string {
    const base = this.config.testMode
      ? 'https://buy-sandbox.moonpay.com'
      : 'https://buy.moonpay.com';
    const query = new URLSearchParams({
      apiKey: this.config.moonpayApiKey ?? '',
      currencyCode: params.asset.toLowerCase(),
      walletAddress: params.cAddress,
      baseCurrencyAmount: params.amount,
      baseCurrencyCode: params.fiatCurrency.toLowerCase(),
    });
    return `${base}?${query.toString()}`;
  }

  /**
   * Build a MoonPay off-ramp URL.
   *
   * @internal
   */
  private getMoonpayOffRampUrl(params: OffRampUrlParams): string {
    const base = this.config.testMode
      ? 'https://sell-sandbox.moonpay.com'
      : 'https://sell.moonpay.com';
    const query = new URLSearchParams({
      apiKey: this.config.moonpayApiKey ?? '',
      currencyCode: params.asset.toLowerCase(),
      walletAddress: params.gAddress,
      baseCurrencyAmount: params.amount,
      baseCurrencyCode: params.fiatCurrency.toLowerCase(),
    });
    return `${base}?${query.toString()}`;
  }

  /**
   * Build a Transak on-ramp URL.
   *
   * @internal
   */
  private getTransakOnRampUrl(params: OnRampUrlParams): string {
    const base = this.config.testMode
      ? 'https://global-stg.transak.com'
      : 'https://global.transak.com';
    const query = new URLSearchParams({
      apiKey: this.config.transakApiKey ?? '',
      cryptoCurrencyCode: params.asset,
      walletAddress: params.cAddress,
      fiatAmount: params.amount,
      fiatCurrency: params.fiatCurrency,
    });
    return `${base}?${query.toString()}`;
  }

  /**
   * Build a Transak off-ramp URL.
   *
   * @internal
   */
  private getTransakOffRampUrl(params: OffRampUrlParams): string {
    const base = this.config.testMode
      ? 'https://global-stg.transak.com'
      : 'https://global.transak.com';
    const query = new URLSearchParams({
      apiKey: this.config.transakApiKey ?? '',
      cryptoCurrencyCode: params.asset,
      walletAddress: params.gAddress,
      fiatAmount: params.amount,
      fiatCurrency: params.fiatCurrency,
      isOffRamp: 'true',
    });
    return `${base}?${query.toString()}`;
  }

  /**
   * Build a Ramp Network on-ramp URL.
   *
   * @internal
   */
  private getRampOnRampUrl(params: OnRampUrlParams): string {
    const base = 'https://app.ramp.network';
    const query = new URLSearchParams({
      hostApiKey: this.config.rampApiKey ?? '',
      userAddress: params.cAddress,
      swapAsset: params.asset,
      fiatValue: params.amount,
      fiatCurrency: params.fiatCurrency,
    });
    return `${base}?${query.toString()}`;
  }

  /**
   * Build a Ramp Network off-ramp URL.
   *
   * @internal
   */
  private getRampOffRampUrl(params: OffRampUrlParams): string {
    const base = 'https://app.ramp.network';
    const query = new URLSearchParams({
      hostApiKey: this.config.rampApiKey ?? '',
      userAddress: params.gAddress,
      swapAsset: params.asset,
      fiatValue: params.amount,
      fiatCurrency: params.fiatCurrency,
      offramp: 'true',
    });
    return `${base}?${query.toString()}`;
  }

  /**
   * Build a Banxa on-ramp URL.
   *
   * @internal
   */
  private getBanxaOnRampUrl(params: OnRampUrlParams): string {
    const base = this.config.testMode
      ? 'https://checkout.banxa-sandbox.com'
      : 'https://checkout.banxa.com';
    const query = new URLSearchParams({
      apiKey: this.config.banxaApiKey ?? '',
      coinType: params.asset,
      walletAddress: params.cAddress,
      fiatAmount: params.amount,
      fiatType: params.fiatCurrency,
    });
    return `${base}?${query.toString()}`;
  }

  /**
   * Build a Banxa off-ramp URL.
   *
   * @internal
   */
  private getBanxaOffRampUrl(params: OffRampUrlParams): string {
    const base = this.config.testMode
      ? 'https://checkout.banxa-sandbox.com'
      : 'https://checkout.banxa.com';
    const query = new URLSearchParams({
      apiKey: this.config.banxaApiKey ?? '',
      coinType: params.asset,
      walletAddress: params.gAddress,
      fiatAmount: params.amount,
      fiatType: params.fiatCurrency,
      orderType: 'sell',
    });
    return `${base}?${query.toString()}`;
  }
}
