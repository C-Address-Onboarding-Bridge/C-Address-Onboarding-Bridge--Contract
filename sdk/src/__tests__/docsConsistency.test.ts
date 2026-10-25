import * as fs from 'fs';
import * as path from 'path';

describe('API Reference & Types consistency (#878)', () => {
  const apiRefPath = path.resolve(__dirname, '../../API_REFERENCE.md');
  const typesPath = path.resolve(__dirname, '../types.ts');
  const apiRefContent = fs.readFileSync(apiRefPath, 'utf-8');
  const typesContent = fs.readFileSync(typesPath, 'utf-8');

  it('does not document non-existent createCAddress, CreateCOptions, or CreateCAddressResult', () => {
    expect(apiRefContent).not.toContain('createCAddress');
    expect(apiRefContent).not.toContain('CreateCOptions');
    expect(apiRefContent).not.toContain('CreateCAddressResult');
  });

  it('types sourceKeypair as Keypair in fundCAddressWithSwap signature', () => {
    expect(apiRefContent).not.toContain('sourceKeypair: any');
  });

  it('restricts FundCOptions.source to G-address only', () => {
    expect(apiRefContent).not.toContain('G-address or C-address sending the funds');
  });

  it('includes nonce and deadline rows in FundCOptions, BatchFundCOptions, and WithdrawFeesOptions', () => {
    const fundCOptionsSection = apiRefContent.slice(
      apiRefContent.indexOf('### `FundCOptions`'),
      apiRefContent.indexOf('### `BatchFundCOptions`')
    );
    expect(fundCOptionsSection).toMatch(/`nonce`\s*\|\s*`string \\\| number \\\| bigint`/);
    expect(fundCOptionsSection).toMatch(/`deadline`\s*\|\s*`string \\\| number \\\| bigint`/);

    const batchFundCOptionsSection = apiRefContent.slice(
      apiRefContent.indexOf('### `BatchFundCOptions`'),
      apiRefContent.indexOf('### `WithdrawFeesOptions`')
    );
    expect(batchFundCOptionsSection).toMatch(/`nonce`\s*\|\s*`string \\\| number \\\| bigint`/);
    expect(batchFundCOptionsSection).toMatch(/`deadline`\s*\|\s*`string \\\| number \\\| bigint`/);

    const withdrawFeesOptionsSection = apiRefContent.slice(
      apiRefContent.indexOf('### `WithdrawFeesOptions`'),
      apiRefContent.indexOf('### `OffRampConfig`')
    );
    expect(withdrawFeesOptionsSection).toMatch(/`nonce`\s*\|\s*`string \\\| number \\\| bigint`/);
  });

  it('removes the empty C-address creation comment section from types.ts', () => {
    expect(typesContent).not.toContain('// C-address creation');
  });
});
