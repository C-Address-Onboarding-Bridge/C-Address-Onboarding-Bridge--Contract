import { OffRampIntegration } from '../offramp';
import { OffRampProvider, OnRampUrlParams, OffRampUrlParams } from '../types';

const TARGET_C_ADDRESS = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const SOURCE_G_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

describe('OffRampIntegration', () => {
  describe('getOnRampUrl - unified interface for all providers', () => {
    const providers: OffRampProvider[] = ['moonpay', 'transak', 'ramp', 'banxa'];
    const baseParams: Omit<OnRampUrlParams, 'provider'> = {
      amount: '100',
      fiatCurrency: 'USD',
      asset: 'XLM',
      cAddress: TARGET_C_ADDRESS,
    };

    providers.forEach((provider) => {
      it(`generates ${provider} on-ramp URL in production mode`, () => {
        const config: Record<OffRampProvider, string> = {
          moonpay: 'moonpay_key',
          transak: 'transak_key',
          ramp: 'ramp_key',
          banxa: 'banxa_key',
        };
        const offramp = new OffRampIntegration({ [provider + 'ApiKey']: config[provider], testMode: false });
        
        const url = offramp.getOnRampUrl({ ...baseParams, provider });
        
        expect(url).toBeTruthy();
        expect(url).toContain(TARGET_C_ADDRESS);
      });

      it(`generates ${provider} on-ramp URL in test mode`, () => {
        const config: Record<OffRampProvider, string> = {
          moonpay: 'moonpay_test_key',
          transak: 'transak_test_key',
          ramp: 'ramp_test_key',
          banxa: 'banxa_test_key',
        };
        const offramp = new OffRampIntegration({ [provider + 'ApiKey']: config[provider], testMode: true });
        
        const url = offramp.getOnRampUrl({ ...baseParams, provider });
        
        expect(url).toBeTruthy();
      });
    });

    it('throws for unsupported provider', () => {
      const offramp = new OffRampIntegration({});
      expect(() => offramp.getOnRampUrl({ ...baseParams, provider: 'unsupported' as any }))
        .toThrow('Unsupported provider');
    });
  });

  describe('getOffRampUrl - unified interface for all providers', () => {
    const providers: OffRampProvider[] = ['moonpay', 'transak', 'ramp', 'banxa'];
    const baseParams: Omit<OffRampUrlParams, 'provider'> = {
      amount: '100',
      fiatCurrency: 'USD',
      asset: 'XLM',
      gAddress: SOURCE_G_ADDRESS,
    };

    providers.forEach((provider) => {
      it(`generates ${provider} off-ramp URL in production mode`, () => {
        const config: Record<OffRampProvider, string> = {
          moonpay: 'moonpay_key',
          transak: 'transak_key',
          ramp: 'ramp_key',
          banxa: 'banxa_key',
        };
        const offramp = new OffRampIntegration({ [provider + 'ApiKey']: config[provider], testMode: false });
        
        const url = offramp.getOffRampUrl({ ...baseParams, provider });
        
        expect(url).toBeTruthy();
        expect(url).toContain(SOURCE_G_ADDRESS);
      });
    });

    it('throws for unsupported provider', () => {
      const offramp = new OffRampIntegration({});
      expect(() => offramp.getOffRampUrl({ ...baseParams, provider: 'unsupported' as any }))
        .toThrow('Unsupported provider');
    });
  });

  describe('Moonpay URL generation', () => {
    it('generates correct on-ramp URL with all params', () => {
      const offramp = new OffRampIntegration({ moonpayApiKey: 'mp_key', testMode: false });
      
      const url = offramp.getOnRampUrl({
        provider: 'moonpay',
        amount: '250.50',
        fiatCurrency: 'EUR',
        asset: 'USDC',
        cAddress: TARGET_C_ADDRESS,
      });

      expect(url).toContain('https://buy.moonpay.com');
      expect(url).toContain('apiKey=mp_key');
      expect(url).toContain('currencyCode=USDC');
      expect(url).toContain('baseCurrencyAmount=250.50');
      expect(url).toContain('baseCurrencyCode=EUR');
      expect(url).toContain(encodeURIComponent(TARGET_C_ADDRESS));
      expect(url).toContain('showWalletAddressForm=false');
    });

    it('generates correct off-ramp URL with all params', () => {
      const offramp = new OffRampIntegration({ moonpayApiKey: 'mp_key', testMode: false });
      
      const url = offramp.getOffRampUrl({
        provider: 'moonpay',
        amount: '500',
        asset: 'XLM',
        fiatCurrency: 'USD',
        gAddress: SOURCE_G_ADDRESS,
      });

      expect(url).toContain('https://sell.moonpay.com');
      expect(url).toContain('apiKey=mp_key');
      expect(url).toContain('cryptoCurrencyCode=XLM');
      expect(url).toContain('baseCurrencyCode=USD');
      expect(url).toContain('walletAddress=' + encodeURIComponent(SOURCE_G_ADDRESS));
      expect(url).toContain('refundWalletAddress=' + encodeURIComponent(SOURCE_G_ADDRESS));
    });

    it('uses staging URLs in test mode', () => {
      const offramp = new OffRampIntegration({ moonpayApiKey: 'test_key', testMode: true });
      
      const onRampUrl = offramp.getOnRampUrl({
        provider: 'moonpay',
        amount: '100',
        fiatCurrency: 'USD',
        asset: 'XLM',
        cAddress: TARGET_C_ADDRESS,
      });
      const offRampUrl = offramp.getOffRampUrl({
        provider: 'moonpay',
        amount: '100',
        asset: 'XLM',
        fiatCurrency: 'USD',
        gAddress: SOURCE_G_ADDRESS,
      });

      expect(onRampUrl).toContain('https://buy-staging.moonpay.com');
      expect(offRampUrl).toContain('https://sell-staging.moonpay.com');
    });
  });

  describe('Transak URL generation', () => {
    it('generates correct on-ramp URL with all params', () => {
      const offramp = new OffRampIntegration({ transakApiKey: 'tk_key', testMode: false });
      
      const url = offramp.getOnRampUrl({
        provider: 'transak',
        amount: '200',
        fiatCurrency: 'GBP',
        asset: 'USDC',
        cAddress: TARGET_C_ADDRESS,
      });

      expect(url).toContain('https://global.transak.com');
      expect(url).toContain('apiKey=tk_key');
      expect(url).toContain('defaultCryptoCurrency=USDC');
      expect(url).toContain('defaultFiatAmount=200');
      expect(url).toContain('fiatCurrency=GBP');
      expect(url).toContain('network=stellar');
      expect(url).toContain('walletAddress=' + encodeURIComponent(TARGET_C_ADDRESS));
    });

    it('generates correct off-ramp URL with isSellMode', () => {
      const offramp = new OffRampIntegration({ transakApiKey: 'tk_key', testMode: false });
      
      const url = offramp.getOffRampUrl({
        provider: 'transak',
        amount: '300',
        asset: 'XLM',
        fiatCurrency: 'EUR',
        gAddress: SOURCE_G_ADDRESS,
      });

      expect(url).toContain('https://global.transak.com');
      expect(url).toContain('isSellMode=true');
      expect(url).toContain('defaultCryptoCurrency=XLM');
      expect(url).toContain('walletAddress=' + encodeURIComponent(SOURCE_G_ADDRESS));
    });

    it('uses staging URLs in test mode', () => {
      const offramp = new OffRampIntegration({ transakApiKey: 'test_key', testMode: true });
      
      const onRampUrl = offramp.getOnRampUrl({
        provider: 'transak',
        amount: '100',
        fiatCurrency: 'USD',
        asset: 'XLM',
        cAddress: TARGET_C_ADDRESS,
      });
      const offRampUrl = offramp.getOffRampUrl({
        provider: 'transak',
        amount: '100',
        asset: 'XLM',
        fiatCurrency: 'USD',
        gAddress: SOURCE_G_ADDRESS,
      });

      expect(onRampUrl).toContain('https://global-staging.transak.com');
      expect(offRampUrl).toContain('https://global-staging.transak.com');
    });
  });

  describe('Ramp Network URL generation', () => {
    it('generates correct on-ramp URL with hostApiKey', () => {
      const offramp = new OffRampIntegration({ rampApiKey: 'ramp_key', testMode: false });
      
      const url = offramp.getOnRampUrl({
        provider: 'ramp',
        amount: '500',
        fiatCurrency: 'EUR',
        asset: 'USDC',
        cAddress: TARGET_C_ADDRESS,
      });

      expect(url).toContain('https://buy.ramp.network');
      expect(url).toContain('hostApiKey=ramp_key');
      expect(url).toContain('userAddress=' + encodeURIComponent(TARGET_C_ADDRESS));
      expect(url).toContain('assetCode=USDC_stellar');
      expect(url).toContain('fiatCurrency=EUR');
      expect(url).toContain('fiatAmount=500');
    });

    it('generates correct off-ramp URL', () => {
      const offramp = new OffRampIntegration({ rampApiKey: 'ramp_key', testMode: false });
      
      const url = offramp.getOffRampUrl({
        provider: 'ramp',
        amount: '1000',
        asset: 'XLM',
        fiatCurrency: 'USD',
        gAddress: SOURCE_G_ADDRESS,
      });

      expect(url).toContain('https://sell.ramp.network');
      expect(url).toContain('userAddress=' + encodeURIComponent(SOURCE_G_ADDRESS));
      expect(url).toContain('assetCode=XLM_stellar');
    });

    it('works without api key', () => {
      const offramp = new OffRampIntegration({ testMode: false });
      
      const url = offramp.getOnRampUrl({
        provider: 'ramp',
        amount: '100',
        fiatCurrency: 'USD',
        asset: 'XLM',
        cAddress: TARGET_C_ADDRESS,
      });

      expect(url).toContain('https://buy.ramp.network');
      expect(url).not.toContain('hostApiKey=');
    });
  });

  describe('Banxa URL generation', () => {
    it('generates correct on-ramp URL', () => {
      const offramp = new OffRampIntegration({ banxaApiKey: 'banxa_key', testMode: false });
      
      const url = offramp.getOnRampUrl({
        provider: 'banxa',
        amount: '750',
        fiatCurrency: 'AUD',
        asset: 'XLM',
        cAddress: TARGET_C_ADDRESS,
      });

      expect(url).toContain('https://app.banxa.com');
      expect(url).toContain('apiKey=banxa_key');
      expect(url).toContain('walletAddress=' + encodeURIComponent(TARGET_C_ADDRESS));
      expect(url).toContain('blockchain=stellar');
      expect(url).toContain('cryptoCurrency=XLM');
      expect(url).toContain('fiatType=AUD');
      expect(url).toContain('fiatAmount=750');
    });

    it('generates correct off-ramp URL with isSellMode', () => {
      const offramp = new OffRampIntegration({ banxaApiKey: 'banxa_key', testMode: false });
      
      const url = offramp.getOffRampUrl({
        provider: 'banxa',
        amount: '2000',
        asset: 'USDC',
        fiatCurrency: 'USD',
        gAddress: SOURCE_G_ADDRESS,
      });

      expect(url).toContain('https://app.banxa.com');
      expect(url).toContain('isSellMode=true');
      expect(url).toContain('walletAddress=' + encodeURIComponent(SOURCE_G_ADDRESS));
      expect(url).toContain('cryptoCurrency=USDC');
    });
  });

  describe('Provider configuration and comparison', () => {
    it('returns correct config for each provider', () => {
      const offramp = new OffRampIntegration({});
      
      const moonpayConfig = offramp.getProviderConfig('moonpay');
      expect(moonpayConfig.provider).toBe('moonpay');
      expect(moonpayConfig.supportedAssets).toContain('XLM');
      expect(moonpayConfig.supportedAssets).toContain('USDC');
      expect(moonpayConfig.feePercentage).toBe('4.5');
      expect(moonpayConfig.testModeAvailable).toBe(true);

      const transakConfig = offramp.getProviderConfig('transak');
      expect(transakConfig.provider).toBe('transak');
      expect(transakConfig.supportedAssets).toContain('MATIC');
      expect(transakConfig.testModeAvailable).toBe(true);

      const rampConfig = offramp.getProviderConfig('ramp');
      expect(rampConfig.provider).toBe('ramp');
      expect(rampConfig.feePercentage).toBe('2.9');
      expect(rampConfig.testModeAvailable).toBe(false);

      const banxaConfig = offramp.getProviderConfig('banxa');
      expect(banxaConfig.provider).toBe('banxa');
      expect(banxaConfig.feePercentage).toBe('3.5');
      expect(banxaConfig.testModeAvailable).toBe(false);
    });

    it('compares providers for a given transaction', () => {
      const offramp = new OffRampIntegration({});
      
      const comparison = offramp.compareProviders('1000', 'XLM', 'USD');
      
      expect(comparison.moonpay).toBeDefined();
      expect(comparison.transak).toBeDefined();
      expect(comparison.ramp).toBeDefined();
      expect(comparison.banxa).toBeDefined();
      
      expect(comparison.moonpay?.feeAmount).toBe('45.00');
      expect(comparison.transak?.feeAmount).toBe('39.00');
      expect(comparison.ramp?.feeAmount).toBe('29.00');
      expect(comparison.banxa?.feeAmount).toBe('35.00');
    });

    it('filters providers by supported asset', () => {
      const offramp = new OffRampIntegration({});
      
      // MATIC is only supported by Transak
      const comparison = offramp.compareProviders('1000', 'MATIC', 'USD');
      
      expect(comparison.transak).toBeDefined();
      expect(comparison.moonpay).toBeUndefined();
      expect(comparison.ramp).toBeUndefined();
      expect(comparison.banxa).toBeUndefined();
    });

    it('filters providers by supported fiat currency', () => {
      const offramp = new OffRampIntegration({});
      
      // INR is only supported by Transak
      const comparison = offramp.compareProviders('1000', 'XLM', 'INR');
      
      expect(comparison.transak).toBeDefined();
      expect(comparison.moonpay).toBeUndefined();
      expect(comparison.ramp).toBeUndefined();
      expect(comparison.banxa).toBeUndefined();
    });

    it('returns empty when no provider supports asset/fiat combo', () => {
      const offramp = new OffRampIntegration({});
      
      const comparison = offramp.compareProviders('1000', 'DOGE', 'XYZ');
      
      expect(Object.keys(comparison)).toHaveLength(0);
    });
  });

  describe('CEX memo encoding/decoding roundtrip', () => {
    it('encodes and decodes C-address correctly', () => {
      const offramp = new OffRampIntegration({});
      const testAddresses = [
        'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
        'CBQXVWQEBH2QYGWNQWQWDJW5QZJZ',
        'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
      ];

      for (const addr of testAddresses) {
        const memo = offramp.generateCEXDepositMemo(addr);
        const decoded = offramp.decodeCEXDepositMemo(memo);
        expect(decoded).toBe(addr);
      }
    });

    it('encodes and decodes G-address correctly (edge case)', () => {
      const offramp = new OffRampIntegration({});
      const addr = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
      
      const memo = offramp.generateCEXDepositMemo(addr);
      const decoded = offramp.decodeCEXDepositMemo(memo);
      
      expect(decoded).toBe(addr);
    });

    it('handles special characters in address', () => {
      const offramp = new OffRampIntegration({});
      // C-addresses are base32 encoded, typically no special chars
      // but test the prefix handling
      const addr = 'CABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
      
      const memo = offramp.generateCEXDepositMemo(addr);
      expect(memo).toBe(`bridge:${addr}`);
      
      const decoded = offramp.decodeCEXDepositMemo(memo);
      expect(decoded).toBe(addr);
    });

    it('returns null for various invalid memo formats', () => {
      const offramp = new OffRampIntegration({});
      
      expect(offramp.decodeCEXDepositMemo('')).toBeNull();
      // 'bridge:' returns empty string (not null) since slice('bridge:'.length) returns ''
      expect(offramp.decodeCEXDepositMemo('bridge:')).toBe('');
      expect(offramp.decodeCEXDepositMemo('bridge')).toBeNull();
      expect(offramp.decodeCEXDepositMemo('bridg:addr')).toBeNull();
      expect(offramp.decodeCEXDepositMemo('bridge:addr:extra')).toBe('addr:extra');
      expect(offramp.decodeCEXDepositMemo('nobridge:addr')).toBeNull();
      expect(offramp.decodeCEXDepositMemo('BRIDGE:ADDR')).toBeNull(); // case sensitive
    });

    it('handles roundtrip with all supported providers config', () => {
      const offramp = new OffRampIntegration({
        moonpayApiKey: 'mp',
        transakApiKey: 'tk',
        rampApiKey: 'ramp',
        banxaApiKey: 'banxa',
        testMode: true,
      });
      
      const addr = TARGET_C_ADDRESS;
      const memo = offramp.generateCEXDepositMemo(addr);
      const decoded = offramp.decodeCEXDepositMemo(memo);
      
      expect(decoded).toBe(addr);
    });
  });

  describe('Error handling', () => {
    it('getOnRampUrl works without api keys (uses empty string)', () => {
      const offramp = new OffRampIntegration({ testMode: false });
      
      const url = offramp.getOnRampUrl({
        provider: 'moonpay',
        amount: '100',
        fiatCurrency: 'USD',
        asset: 'XLM',
        cAddress: TARGET_C_ADDRESS,
      });
      
      expect(url).toContain('apiKey=');
    });

    it('getOffRampUrl works without api keys', () => {
      const offramp = new OffRampIntegration({ testMode: false });
      
      const url = offramp.getOffRampUrl({
        provider: 'moonpay',
        amount: '100',
        asset: 'XLM',
        fiatCurrency: 'USD',
        gAddress: SOURCE_G_ADDRESS,
      });
      
      expect(url).toContain('apiKey=');
    });

    it('getProviderConfig returns config for all providers even without keys', () => {
      const offramp = new OffRampIntegration({});
      
      ['moonpay', 'transak', 'ramp', 'banxa'].forEach((p) => {
        const config = offramp.getProviderConfig(p as OffRampProvider);
        expect(config.provider).toBe(p);
        expect(config.supportedAssets).toBeInstanceOf(Array);
        expect(config.supportedAssets.length).toBeGreaterThan(0);
      });
    });

    it('compareProviders handles edge cases', () => {
      const offramp = new OffRampIntegration({});
      
      // Zero amount
      let comparison = offramp.compareProviders('0', 'XLM', 'USD');
      expect(comparison.moonpay?.feeAmount).toBe('0.00');
      
      // Very large amount - floating point precision may vary
      comparison = offramp.compareProviders('999999999', 'XLM', 'USD');
      expect(parseFloat(comparison.moonpay?.feeAmount || '0')).toBeCloseTo(44999999.96, 1);
      
      // Decimal amount
      comparison = offramp.compareProviders('100.50', 'XLM', 'USD');
      expect(comparison.moonpay?.feeAmount).toBe('4.52');
    });
  });

  describe('Deprecated methods still work', () => {
    it('getMoonpayUrl (deprecated) generates correct URL', () => {
      const offramp = new OffRampIntegration({ moonpayApiKey: 'test', testMode: false });
      
      const url = offramp.getMoonpayUrl({
        targetCAddress: TARGET_C_ADDRESS,
        amount: '100',
        currency: 'xlm',
        assetCode: 'xlm',
      });

      expect(url).toContain('https://buy.moonpay.com');
      expect(url).toContain('apiKey=test');
      expect(url).toContain('currencyCode=xlm');
    });

    it('getTransakUrl (deprecated) generates correct URL', () => {
      const offramp = new OffRampIntegration({ transakApiKey: 'test', testMode: false });
      
      const url = offramp.getTransakUrl({
        targetCAddress: TARGET_C_ADDRESS,
        amount: '100',
        currency: 'xlm',
        fiatCurrency: 'EUR',
      });

      expect(url).toContain('https://global.transak.com');
      expect(url).toContain('defaultCryptoCurrency=xlm');
      expect(url).toContain('fiatCurrency=EUR');
    });
  });
});
