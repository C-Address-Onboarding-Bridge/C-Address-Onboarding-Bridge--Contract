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
 * // On-ramp: user pays $100 USD, receives XLM at their G-address,
 * // then bridge the funds to the C-address with fundCAddress.
 * const url = offramp.getOnRampUrl({
 *   provider: 'moonpay',
 *   amount: '100',
 *   fiatCurrency: 'USD',
 *   asset: 'XLM',
 *   gAddress: 'G...',
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
   * `params.gAddress` on Stellar.
   *
   * Fiat on-ramp providers settle with classic Stellar payments, which can
   * only target G-addresses — a classic payment cannot be sent to a
   * C-address.  The supported flow is therefore: on-ramp to a G-address, then
   * bridge the received funds to the C-address with `fundCAddress`.
   *
   * When `params.signer` is provided it is invoked with the built URL so the
   * caller can attach a server-side signature (see {@link signUrl}).  This is
   * required for MoonPay URLs that pre-fill `walletAddress`.
   *
   * @param params - Provider, fiat amount, fiat currency, crypto asset,
   *                 destination G-address, and an optional `signer` callback.
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
   *   gAddress: 'G...',
   * });
   * ```
   */
  getOnRampUrl(params: OnRampUrlParams): string {
    assertAccountAddress(params.gAddress, 'gAddress');
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
        s

/* … truncated 6898 chars — edit only what you need near the top … */
