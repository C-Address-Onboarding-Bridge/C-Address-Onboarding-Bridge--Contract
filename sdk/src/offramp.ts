import { OffRampConfig } from './types';

/**
 * Builds fiat on-ramp URLs and CEX routing memos for C-address funding flows.
 *
 * @example
 * const offramp = new OffRampIntegration({ moonpayApiKey, transakApiKey, testMode: true });
 */
export class OffRampIntegration {
  private config: OffRampConfig;

/**
 * Creates a provider URL and memo helper.
 *
 * @param config - Provider API keys and sandbox/test-mode setting.
 */
  constructor(config: OffRampConfig) {
    this.config = config;
  }

  /**
 * Builds a Moonpay purchase URL for funding a target C-address.
 *
 * @param params - Target C-address, purchase amount, crypto/fiat currency, and optional asset code.
 * @returns A Moonpay URL with query parameters populated from the integration config.
 * @throws If the runtime does not provide the standard `URL` API.
 * @example
 * const url = offramp.getMoonpayUrl({ targetCAddress: 'CC...', amount: '100', currency: 'USDC' });
 */
  getMoonpayUrl(params: {
    targetCAddress: string;
    amount: string;
    currency: string;
    assetCode?: string;
  }): string {
    const baseUrl = this.config.testMode
      ? 'https://buy-staging.moonpay.com'
      : 'https://buy.moonpay.com';

    const url = new URL(baseUrl);
    url.searchParams.set('apiKey', this.config.moonpayApiKey || '');
    url.searchParams.set('currency', params.currency);
    url.searchParams.set('baseCurrencyAmount', params.amount);
    if (params.assetCode) {
      url.searchParams.set('baseCurrencyCode', params.assetCode);
    }

    const walletAddress = params.targetCAddress;
    url.searchParams.set('walletAddress', walletAddress);

    return url.toString();
  }

  /**
 * Builds a Transak purchase URL for funding a target C-address.
 *
 * @param params - Target C-address, fiat amount, crypto currency, and optional fiat currency override.
 * @returns A Transak URL with wallet, amount, network, and API key parameters.
 * @throws If the runtime does not provide the standard `URL` API.
 * @example
 * const url = offramp.getTransakUrl({ targetCAddress: 'CC...', amount: '100', currency: 'USDC', fiatCurrency: 'USD' });
 */
  getTransakUrl(params: {
    targetCAddress: string;
    amount: string;
    currency: string;
    fiatCurrency?: string;
  }): string {
    const baseUrl = this.config.testMode
      ? 'https://global-staging.transak.com'
      : 'https://global.transak.com';

    const url = new URL(baseUrl);
    url.searchParams.set('apiKey', this.config.transakApiKey || '');
    url.searchParams.set('defaultCryptoCurrency', 'XLM');
    url.searchParams.set('walletAddress', params.targetCAddress);
    url.searchParams.set('defaultFiatAmount', params.amount);
    if (params.fiatCurrency) {
      url.searchParams.set('fiatCurrency', params.fiatCurrency);
    }
    url.searchParams.set('network', 'stellar');

    return url.toString();
  }

  /**
 * Encodes a C-address in the memo format used by CEX deposit routing.
 *
 * @param targetCAddress - C-address that should receive bridged funds.
 * @returns Memo string in `bridge:<target_c_address>` format.
 * @throws This method does not throw; callers should validate the C-address before display.
 * @example
 * const memo = offramp.generateCEXDepositMemo('CC...');
 */
  generateCEXDepositMemo(targetCAddress: string): string {
    return `bridge:${targetCAddress}`;
  }

  /**
 * Extracts the target C-address from a bridge CEX deposit memo.
 *
 * @param memo - Memo supplied by a user or exchange deposit flow.
 * @returns The decoded C-address, or `null` when the memo is not a bridge memo.
 * @throws This method does not throw.
 * @example
 * const target = offramp.decodeCEXDepositMemo('bridge:CC...');
 */
  decodeCEXDepositMemo(memo: string): string | null {
    if (!memo.startsWith('bridge:')) {
      return null;
    }
    return memo.slice('bridge:'.length);
  }
}
