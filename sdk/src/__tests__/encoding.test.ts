import { nativeToScVal, Address, xdr } from '@stellar/stellar-sdk';
import { toSingleScVal } from '../encoding';

describe('toSingleScVal', () => {
  it('encodes a u32 argument explicitly by its ABI type', () => {
    const result = toSingleScVal('42', { type: 'u32' });
    expect(result).toEqual(nativeToScVal(42, { type: 'u32' }));
    expect(result.switch().name).toBe('scvU32');
  });

  it('does not treat a non-address string starting with G as an Address', () => {
    const value = 'Gnot-an-address';
    const result = toSingleScVal(value, { type: 'string' });
    expect(result).toEqual(nativeToScVal(value, { type: 'string' }));
    expect(result.switch().name).toBe('scvString');
  });

  it('encodes an address argument when the ABI type is address', () => {
    const address = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF5';
    const result = toSingleScVal(address, { type: 'address' });
    expect(result).toEqual(new Address(address).toScVal());
    expect(result.switch().name).toBe('scvAddress');
  });

  it('encodes a numeric string as i128 only when the ABI type is i128', () => {
    const result = toSingleScVal('123', { type: 'i128' });
    expect(result).toEqual(nativeToScVal(BigInt('123'), { type: 'i128' }));
    expect(result.switch().name).toBe('scvI128');
  });

  it('encodes a u64 argument explicitly by its ABI type', () => {
    const result = toSingleScVal('9007199254740993', { type: 'u64' });
    expect(result).toEqual(nativeToScVal(BigInt('9007199254740993'), { type: 'u64' }));
    expect(result.switch().name).toBe('scvU64');
  });

  it('encodes a muxed M... address when the ABI type is address', () => {
    const muxed = 'MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK';
    const result = toSingleScVal(muxed, { type: 'address' });
    expect(result).toEqual(new Address(muxed).toScVal());
    expect(result.switch().name).toBe('scvAddress');
  });

  it('throws when an address-typed argument is not a valid address', () => {
    expect(() => toSingleScVal('Gnot-an-address', { type: 'address' })).toThrow();
  });

  it('encodes a boolean argument explicitly by its ABI type', () => {
    const result = toSingleScVal('true', { type: 'bool' });
    expect(result).toEqual(nativeToScVal(true, { type: 'bool' }));
    expect(result.switch().name).toBe('scvBool');
  });

  it('encodes a symbol argument explicitly by its ABI type', () => {
    const result = toSingleScVal('transfer', { type: 'symbol' });
    expect(result).toEqual(nativeToScVal('transfer', { type: 'symbol' }));
    expect(result.switch().name).toBe('scvSymbol');
  });

  it('encodes a bytes argument explicitly by its ABI type', () => {
    const result = toSingleScVal('deadbeef', { type: 'bytes' });
    expect(result).toEqual(nativeToScVal(Buffer.from('deadbeef', 'hex'), { type: 'bytes' }));
    expect(result.switch().name).toBe('scvBytes');
  });

  it('encodes an i32 argument explicitly by its ABI type', () => {
    const result = toSingleScVal('-7', { type: 'i32' });
    expect(result).toEqual(nativeToScVal(-7, { type: 'i32' }));
    expect(result.switch().name).toBe('scvI32');
  });

  it('encodes a u128 argument explicitly by its ABI type', () => {
    const result = toSingleScVal('340282366920938463463374607431768211455', { type: 'u128' });
    expect(result).toEqual(
      nativeToScVal(BigInt('340282366920938463463374607431768211455'), { type: 'u128' }),
    );
    expect(result.switch().name).toBe('scvU128');
  });

  it('encodes an i64 argument explicitly by its ABI type', () => {
    const result = toSingleScVal('-9007199254740993', { type: 'i64' });
    expect(result).toEqual(nativeToScVal(BigInt('-9007199254740993'), { type: 'i64' }));
    expect(result.switch().name).toBe('scvI64');
  });

  it('encodes a u256 argument explicitly by its ABI type', () => {
    const result = toSingleScVal('1', { type: 'u256' });
    expect(result).toEqual(nativeToScVal(BigInt('1'), { type: 'u256' }));
    expect(result.switch().name).toBe('scvU256');
  });

  it('encodes an i256 argument explicitly by its ABI type', () => {
    const result = toSingleScVal('-1', { type: 'i256' });
    expect(result).toEqual(nativeToScVal(BigInt('-1'), { type: 'i256' }));
    expect(result.switch().name).toBe('scvI256');
  });

  it('encodes a timepoint argument explicitly by its ABI type', () => {
    const result = toSingleScVal('1700000000', { type: 'timepoint' });
    expect(result).toEqual(nativeToScVal(BigInt('1700000000'), { type: 'timepoint' }));
    expect(result.switch().name).toBe('scvTimepoint');
  });

  it('encodes a duration argument explicitly by its ABI type', () => {
    const result = toSingleScVal('3600', { type: 'duration' });
    expect(result).toEqual(nativeToScVal(BigInt('3600'), { type: 'duration' }));
    expect(result.switch().name).toBe('scvDuration');
  });

  it('encodes a vec argument explicitly by its ABI type', () => {
    const result = toSingleScVal(['1', '2'], { type: 'vec', elementType: { type: 'u32' } });
    expect(result).toEqual(
      xdr.ScVal.scvVec([
        nativeToScVal(1, { type: 'u32' }),
        nativeToScVal(2, { type: 'u32' }),
      ]),
    );
    expect(result.switch().name).toBe('scvVec');
  });

  it('encodes an option argument explicitly by its ABI type', () => {
    const result = toSingleScVal('5', { type: 'option', elementType: { type: 'u32' } });
    expect(result).toEqual(nativeToScVal(5, { type: 'u32' }));
    expect(result.switch().name).toBe('scvU32');
  });

  it('encodes a null option argument as void', () => {
    const result = toSingleScVal(null, { type: 'option', elementType: { type: 'u32' } });
    expect(result).toEqual(xdr.ScVal.scvVoid());
    expect(result.switch().name).toBe('scvVoid');
  });
});
