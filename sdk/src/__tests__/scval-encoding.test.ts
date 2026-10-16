import { xdr, Address, Contract, scValToNative } from '@stellar/stellar-sdk';
import { toSingleScVal, toScVals } from '../encoding';

const MOCK_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const MOCK_ASSET = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

describe('toScVals / toSingleScVal encoding', () => {
  it('does not infer an address from a G-address string', () => {
    const result = toSingleScVal(MOCK_ADDRESS);
    expect(result.switch().name).toBe('scvString');
    expect(scValToNative(result)).toBe(MOCK_ADDRESS);
  });

  it('does not infer an address from a C-address string', () => {
    const result = toSingleScVal(MOCK_ASSET);
    expect(result.switch().name).toBe('scvString');
    expect(scValToNative(result)).toBe(MOCK_ASSET);
  });

  it('does not infer a numeric type from a string', () => {
    const result = toSingleScVal('12345678901234567890');
    expect(result.switch().name).toBe('scvString');
    expect(scValToNative(result)).toBe('12345678901234567890');
  });

  it('encodes an explicitly typed address and i128', () => {
    const address = new Address(MOCK_ADDRESS);
    const addressVal = toSingleScVal(address);
    const amountVal = toSingleScVal({ value: BigInt('12345678901234567890'), type: 'i128' });

    expect(addressVal.switch().name).toBe('scvAddress');
    expect(Address.fromScVal(addressVal).toString()).toBe(MOCK_ADDRESS);
    expect(amountVal.switch().name).toBe('scvI128');
    expect(scValToNative(amountVal).toString()).toBe('12345678901234567890');
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

  it('encodes a plain string as ScVal String', () => {
    const result = toSingleScVal('test_symbol');
    expect(result.switch().name).toBe('scvString');
    expect(scValToNative(result)).toBe('test_symbol');
  });

  it('encodes array as ScVal Vec', () => {
    const result = toSingleScVal([
      new Address(MOCK_ADDRESS),
      { value: 100n, type: 'i128' },
      new Address(MOCK_ASSET),
    ]);
    const native = scValToNative(result) as any[];
    expect(native).toHaveLength(3);
    expect(native[0].toString()).toBe(MOCK_ADDRESS);
    expect(native[1].toString()).toBe('100');
    expect(native[2].toString()).toBe(MOCK_ASSET);
    expect(result.vec()?.map((value) => value.switch().name)).toEqual([
      'scvAddress',
      'scvI128',
      'scvAddress',
    ]);
  });

  it('encodes null/undefined as ScVal Void', () => {
    const resultNull = toSingleScVal(null);
    const resultUndefined = toSingleScVal(undefined);
    expect(resultNull.toXDR('base64')).toBe(xdr.ScVal.scvVoid().toXDR('base64'));
    expect(resultUndefined.toXDR('base64')).toBe(xdr.ScVal.scvVoid().toXDR('base64'));
  });

  it('toScVals encodes multiple args correctly', () => {
    const results = toScVals([
      new Address(MOCK_ADDRESS),
      { value: 1000n, type: 'i128' },
      new Address(MOCK_ASSET),
      true,
      'symbol',
    ]);
    expect(results).toHaveLength(5);
    expect(Address.fromScVal(results[0]).toString()).toBe(MOCK_ADDRESS);
    expect(scValToNative(results[1]).toString()).toBe('1000');
    expect(Address.fromScVal(results[2]).toString()).toBe(MOCK_ASSET);
    expect(scValToNative(results[3])).toBe(true);
    expect(scValToNative(results[4])).toBe('symbol');
  });

  it('round-trips funding call arguments through contract-call XDR', () => {
    const calls = [
      {
        method: 'fund_c_address',
        args: toScVals([
          new Address(MOCK_ADDRESS),
          new Address(MOCK_ASSET),
          new Address(MOCK_ASSET),
          { value: 123n, type: 'i128' },
          undefined,
          undefined,
        ]),
        types: ['scvAddress', 'scvAddress', 'scvAddress', 'scvI128', 'scvVoid', 'scvVoid'],
      },
      {
        method: 'fund_c_address_with_referral',
        args: toScVals([
          new Address(MOCK_ADDRESS),
          new Address(MOCK_ASSET),
          new Address(MOCK_ASSET),
          { value: 123n, type: 'i128' },
          new Address(MOCK_ADDRESS),
        ]),
        types: ['scvAddress', 'scvAddress', 'scvAddress', 'scvI128', 'scvAddress'],
      },
      {
        method: 'fund_c_address_with_swap',
        args: toScVals([
          new Address(MOCK_ADDRESS),
          new Address(MOCK_ASSET),
          new Address(MOCK_ASSET),
          new Address(MOCK_ASSET),
          { value: 123n, type: 'i128' },
          { value: 100n, type: 'i128' },
          [new Address(MOCK_ASSET)],
          undefined,
          undefined,
        ]),
        types: [
          'scvAddress', 'scvAddress', 'scvAddress', 'scvAddress',
          'scvI128', 'scvI128', 'scvVec', 'scvVoid', 'scvVoid',
        ],
        vectorTypes: [['scvAddress']],
      },
      {
        method: 'batch_fund_c_address',
        args: toScVals([
          new Address(MOCK_ADDRESS),
          [new Address(MOCK_ASSET)],
          [{ value: 123n, type: 'i128' }],
          new Address(MOCK_ASSET),
          undefined,
          undefined,
        ]),
        types: ['scvAddress', 'scvVec', 'scvVec', 'scvAddress', 'scvVoid', 'scvVoid'],
        vectorTypes: [['scvAddress'], ['scvI128']],
      },
      {
        method: 'withdraw_fees',
        args: toScVals([new Address(MOCK_ASSET), { value: 123n, type: 'i128' }, undefined]),
        types: ['scvAddress', 'scvI128', 'scvVoid'],
      },
      {
        method: 'reclaim_tokens',
        args: toScVals([
          new Address(MOCK_ASSET),
          { value: 123n, type: 'i128' },
          new Address(MOCK_ADDRESS),
          undefined,
        ]),
        types: ['scvAddress', 'scvI128', 'scvAddress', 'scvVoid'],
      },
    ];
    const contract = new Contract(MOCK_ASSET);

    for (const { method, args, types, vectorTypes } of calls) {
      const operation = contract.call(method, ...args);
      const decoded = xdr.Operation.fromXDR(operation.toXDR())
        .body()
        .invokeHostFunctionOp()
        .hostFunction()
        .invokeContract()
        .args();

      expect(decoded.map((arg) => arg.switch().name)).toEqual(types);
      vectorTypes?.forEach((expected, index) => {
        const vector = decoded.filter((arg) => arg.switch().name === 'scvVec')[index];
        expect(vector.vec()?.map((arg) => arg.switch().name)).toEqual(expected);
      });
    }
  });

  it('encodes negative numbers as i128', () => {
    const result = toSingleScVal(-42);
    expect(scValToNative(result).toString()).toBe('-42');
  });

  it('encodes zero as i128', () => {
    const result = toSingleScVal(0);
    expect(scValToNative(result).toString()).toBe('0');
  });

  it('encodes empty string as ScVal String', () => {
    const result = toSingleScVal('');
    expect(result.switch().name).toBe('scvString');
    expect(scValToNative(result)).toBe('');
  });

  it('encodes nested arrays correctly', () => {
    const result = toSingleScVal([['nested', 'array'], 'top-level']);
    const native = scValToNative(result) as any[];
    expect(native).toHaveLength(2);
    expect(native[0]).toHaveLength(2);
    expect(native[0][0]).toBe('nested');
    expect(native[0][1]).toBe('array');
    expect(native[1]).toBe('top-level');
    expect(result.vec()?.[0].switch().name).toBe('scvVec');
    expect(result.vec()?.[1].switch().name).toBe('scvString');
  });
});