import { buildSimulationTx } from '../encoding';
import { Address, Contract, Networks, xdr } from '@stellar/stellar-sdk';

const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const ACCOUNT_ID = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const ASSET_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

describe('read simulation address arguments', () => {
  it('encodes every read wrapper address argument as scvAddress', () => {
    const contract = new Contract(CONTRACT_ID);
    const calls: Array<{ method: string; args: any[] }> = [
      { method: 'query_balance', args: [new Address(CONTRACT_ID), new Address(ASSET_ID)] },
      { method: 'query_accrued_fees', args: [new Address(ASSET_ID)] },
      { method: 'query_contract_balance', args: [new Address(ASSET_ID)] },
      { method: 'query_all_balances', args: [[new Address(ASSET_ID), new Address(CONTRACT_ID)]] },
      { method: 'query_current_tier', args: [new Address(ACCOUNT_ID)] },
      { method: 'query_is_blocked', args: [new Address(ACCOUNT_ID)] },
      { method: 'query_is_allowlisted', args: [new Address(CONTRACT_ID)] },
    ];
    const expectedAddresses = [
      [CONTRACT_ID, ASSET_ID],
      [ASSET_ID],
      [ASSET_ID],
      [ASSET_ID, CONTRACT_ID],
      [ACCOUNT_ID],
      [ACCOUNT_ID],
      [CONTRACT_ID],
    ];

    calls.forEach(({ method, args }, index) => {
      const tx = buildSimulationTx(
        contract,
        method,
        args,
        Networks.TESTNET,
        30,
      );
      const operation = tx.toEnvelope().v1().tx().operations()[0];
      const scVals: xdr.ScVal[] = operation
        .body()
        .invokeHostFunctionOp()
        .hostFunction()
        .invokeContract()
        .args();
      const addressArgs = index === 3 ? scVals[0].vec() ?? [] : scVals;
      expect(scVals.map((arg) => arg.switch().name)).toEqual(
        index === 3
          ? ['scvVec']
          : expectedAddresses[index].map(() => 'scvAddress'),
      );
      expect(addressArgs.map((arg) => arg.switch().name)).toEqual(
        expectedAddresses[index].map(() => 'scvAddress'),
      );
      expect(addressArgs).toEqual(
        expectedAddresses[index].map((address) => new Address(address).toScVal()),
      );
    });
  });
});
