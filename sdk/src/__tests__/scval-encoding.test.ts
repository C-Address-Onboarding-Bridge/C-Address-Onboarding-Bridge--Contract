import { SorobanRpc, xdr, Address, nativeToScVal, scValToNative } from '@stellar/stellar-sdk';

const MOCK_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const MOCK_ASSET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

function toSingleScVal(arg: any): xdr.ScVal {
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

function toScVals(args: any[]): xdr.ScVal[] {
  return args.map((arg) => {
    if (arg === null || arg === undefined) {
      return xdr.ScVal.scvVoid();
    }

    if (Array.isArray(arg)) {
      return xdr.ScVal.scvVec(
        arg.map((item) => toSingleScVal(item)),
      );
    }

    return toSingleScVal(arg);
  });
}

describe('toScVals / toSingleScVal encoding', () => {
  it('encodes G-address (account) to ScVal Address', () => {
    const result = toSingleScVal(MOCK_ADDRESS);
    expect(Address.fromScVal(result).toString()).toBe(MOCK_ADDRESS);
  });

  it('encodes C-address (contract) to ScVal Address', () => {
    const result = toSingleScVal(MOCK_ASSET);
    expect(Address.fromScVal(result).toString()).toBe(MOCK_ASSET);
  });

  it('encodes numeric string as i128', () => {
    const result = toSingleScVal('12345678901234567890');
    expect(scValToNative(result).toString()).toBe('12345678901234567890');
  });

  it('encodes number as i128', () => {
    const result = toSingleScVal(42);
    expect(scValToNative(result).toString()).toBe('42');
  });

  it('encodes bigint as i128', () => {
    const result = toSingleScVal(BigInt('9999999999999999999'));
    expect(scValToNative(result).toString()).toBe('9999999999999999999');
  });

  it('encodes boolean as ScVal Bool', () => {
    const resultTrue = toSingleScVal(true);
    const resultFalse = toSingleScVal(false);
    expect(scValToNative(resultTrue)).toBe(true);
    expect(scValToNative(resultFalse)).toBe(false);
  });

  it('encodes symbol string as ScVal Symbol', () => {
    const result = toSingleScVal('test_symbol');
    expect(scValToNative(result)).toBe('test_symbol');
  });

  it('encodes array as ScVal Vec', () => {
    const result = toSingleScVal([MOCK_ADDRESS, '100', MOCK_ASSET]);
    const native = scValToNative(result) as any[];
    expect(native).toHaveLength(3);
    expect(native[0].toString()).toBe(MOCK_ADDRESS);
    expect(native[1]).toBe('100');
    expect(native[2].toString()).toBe(MOCK_ASSET);
  });

  it('encodes null/undefined as ScVal Void', () => {
    const resultNull = toSingleScVal(null);
    const resultUndefined = toSingleScVal(undefined);
    expect(resultNull.toXDR('base64')).toBe(xdr.ScVal.scvVoid().toXDR('base64'));
    expect(resultUndefined.toXDR('base64')).toBe(xdr.ScVal.scvVoid().toXDR('base64'));
  });

  it('toScVals encodes multiple args correctly', () => {
    const results = toScVals([MOCK_ADDRESS, '1000', MOCK_ASSET, true, 'symbol']);
    expect(results).toHaveLength(5);
    expect(Address.fromScVal(results[0]).toString()).toBe(MOCK_ADDRESS);
    expect(scValToNative(results[1]).toString()).toBe('1000');
    expect(Address.fromScVal(results[2]).toString()).toBe(MOCK_ASSET);
    expect(scValToNative(results[3])).toBe(true);
    expect(scValToNative(results[4])).toBe('symbol');
  });
});