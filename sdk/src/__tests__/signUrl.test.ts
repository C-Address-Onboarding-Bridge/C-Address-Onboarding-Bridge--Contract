import { createHmac } from 'crypto';
import { signUrl } from '../index';

describe('MoonPay signUrl (#872)', () => {
  const secretKey = 'sk_test_moonpay_dummy_key';
  const originalUrl =
    'https://buy.moonpay.com?apiKey=pk_test_123&currencyCode=xlm&walletAddress=CCW7Y656T55Q324KUXK3X67UXK3X67UXK3X67UXK3X67UXK3X67UXK3X';

  it('matches MoonPay reference algorithm including leading ? in HMAC', () => {
    // Reference algorithm documented by MoonPay:
    const expectedSignature = createHmac('sha256', secretKey)
      .update(new URL(originalUrl).search)
      .digest('base64');

    const signedUrl = signUrl(originalUrl, secretKey);
    const parsed = new URL(signedUrl);

    expect(parsed.searchParams.get('signature')).toBe(expectedSignature);
  });

  it('correctly replaces existing signature when re-signing an already-signed URL', () => {
    const expectedSignature = createHmac('sha256', secretKey)
      .update(new URL(originalUrl).search)
      .digest('base64');

    const signedOnce = signUrl(originalUrl, secretKey);
    const signedTwice = signUrl(signedOnce, secretKey);

    const parsed = new URL(signedTwice);
    expect(parsed.searchParams.getAll('signature')).toHaveLength(1);
    expect(parsed.searchParams.get('signature')).toBe(expectedSignature);
  });

  it('preserves existing query parameters when adding signature', () => {
    const signedUrl = signUrl(originalUrl, secretKey);
    const parsed = new URL(signedUrl);

    expect(parsed.searchParams.get('apiKey')).toBe('pk_test_123');
    expect(parsed.searchParams.get('currencyCode')).toBe('xlm');
    expect(parsed.searchParams.get('walletAddress')).toBe(
      'CCW7Y656T55Q324KUXK3X67UXK3X67UXK3X67UXK3X67UXK3X67UXK3X'
    );
  });
});
