/**
 * Cross-check for computeMetaFundPayload / signMetaFund.
 *
 * Uses the real @stellar/stellar-sdk (no mocks). The expected values are the
 * same fixed vector asserted by the contract test
 * `test_meta_fund_payload_matches_sdk_vector`
 * (contracts/onboarding-bridge/src/tests.rs), so the TS helper and the
 * contract's payload construction must agree byte-for-byte.
 */
import { Keypair, Networks } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { computeMetaFundPayload, signMetaFund } from '../bridge';
import type { MetaFundParams } from '../types';

const CONTRACT_ID = 'CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526';
const PARAMS: MetaFundParams = {
  networkId: createHash('sha256').update(Networks.TESTNET).digest('hex'),
  source: 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57',
  target: 'CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ',
  asset: 'CABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGCK3',
  amount: '500',
  nonce: 7,
  deadline: 2_000_000,
};

const EXPECTED_HASH = 'fac2414dcdfa5435abbce2b83899586628a7e65bc3d4e482b56050e1080df43f';
const EXPECTED_PUBKEY = '2152f8d19b791d24453242e15f2eab6cb7cffa7b6a5ed30097960e069881db12';
const EXPECTED_SIGNATURE =
  '6e5d0d03a04f9f4baff800aae0cf7443aa5d307f99e21f3ee2ac9a257d1259fe' +
  'b3a3b5c7b6c3dfd6bce7762b01e1e20ebc02e1f05a3a9cea062d7db0513a7d04';

describe('computeMetaFundPayload', () => {
  it('matches the contract test vector byte-for-byte', () => {
    const hash = computeMetaFundPayload(PARAMS, CONTRACT_ID);
    expect(hash).toHaveLength(32);
    expect(hash.toString('hex')).toBe(EXPECTED_HASH);
  });

  it('accepts bigint and string numerics identically', () => {
    const a = computeMetaFundPayload({ ...PARAMS, amount: 500n, nonce: '7', deadline: 2_000_000n }, CONTRACT_ID);
    expect(a.toString('hex')).toBe(EXPECTED_HASH);
  });

  it('changes when any signed field changes', () => {
    const base = computeMetaFundPayload(PARAMS, CONTRACT_ID).toString('hex');
    expect(computeMetaFundPayload({ ...PARAMS, nonce: 8 }, CONTRACT_ID).toString('hex')).not.toBe(base);
    expect(computeMetaFundPayload({ ...PARAMS, amount: '501' }, CONTRACT_ID).toString('hex')).not.toBe(base);
    expect(computeMetaFundPayload(PARAMS, PARAMS.target).toString('hex')).not.toBe(base);
  });

  it('rejects out-of-range inputs', () => {
    expect(() => computeMetaFundPayload({ ...PARAMS, networkId: 'abcd' }, CONTRACT_ID)).toThrow(/networkId/);
    expect(() => computeMetaFundPayload({ ...PARAMS, amount: 0 }, CONTRACT_ID)).toThrow(/i128/);
    expect(() => computeMetaFundPayload({ ...PARAMS, amount: 1n << 127n }, CONTRACT_ID)).toThrow(/i128/);
    expect(() => computeMetaFundPayload({ ...PARAMS, nonce: 1n << 64n }, CONTRACT_ID)).toThrow(/u64/);
    expect(() => computeMetaFundPayload({ ...PARAMS, deadline: -1 }, CONTRACT_ID)).toThrow(/u64/);
  });
});

describe('signMetaFund', () => {
  const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x42));

  it('matches the contract test vector signature for seed 0x42', () => {
    const signed = signMetaFund(PARAMS, CONTRACT_ID, keypair);
    expect(signed.payloadHash).toBe(EXPECTED_HASH);
    expect(signed.pubkey).toBe(EXPECTED_PUBKEY);
    expect(signed.signature).toBe(EXPECTED_SIGNATURE);
  });

  it('produces a signature that verifies against the payload hash', () => {
    const signed = signMetaFund(PARAMS, CONTRACT_ID, keypair);
    expect(keypair.verify(Buffer.from(signed.payloadHash, 'hex'), Buffer.from(signed.signature, 'hex'))).toBe(true);
  });
});
