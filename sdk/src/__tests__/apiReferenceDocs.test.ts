import * as fs from 'fs';
import * as path from 'path';

describe('API_REFERENCE.md documentation coverage', () => {
  const bridgePath = path.resolve(__dirname, '../bridge.ts');
  const docPath = path.resolve(__dirname, '../../API_REFERENCE.md');

  const bridgeSrc = fs.readFileSync(bridgePath, 'utf8');
  const docSrc = fs.readFileSync(docPath, 'utf8');

  it('documents every public async method on OnboardingBridgeSDK', () => {
    const methodRegex = /^\s*(?:async\s+)([a-zA-Z0-9_]+)\s*\(/gm;
    const publicMethods: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = methodRegex.exec(bridgeSrc)) !== null) {
      publicMethods.push(match[1]);
    }

    const sdkStart = docSrc.indexOf('### `OnboardingBridgeSDK`');
    const sdkEnd = docSrc.indexOf('### `OffRampIntegration`', sdkStart);
    expect(sdkStart).toBeGreaterThan(-1);
    expect(sdkEnd).toBeGreaterThan(sdkStart);

    const sdkSection = docSrc.slice(sdkStart, sdkEnd);
    const headingRegex = /^#####\s+`([a-zA-Z0-9_]+)`/gm;
    const documentedMethods = new Set<string>();
    while ((match = headingRegex.exec(sdkSection)) !== null) {
      documentedMethods.add(match[1]);
    }

    const missingMethods = publicMethods.filter((m) => !documentedMethods.has(m));
    expect(missingMethods).toEqual([]);
  });

  it('documents all required SDK interfaces under ## Interfaces', () => {
    const interfacesStart = docSrc.indexOf('## Interfaces');
    const interfacesEnd = docSrc.indexOf('## Type Aliases', interfacesStart);
    expect(interfacesStart).toBeGreaterThan(-1);

    const interfacesSection = interfacesEnd !== -1
      ? docSrc.slice(interfacesStart, interfacesEnd)
      : docSrc.slice(interfacesStart);

    const interfaceHeadingRegex = /^###\s+`([a-zA-Z0-9_]+)`/gm;
    const documentedInterfaces = new Set<string>();
    let match: RegExpExecArray | null;
    while ((match = interfaceHeadingRegex.exec(interfacesSection)) !== null) {
      documentedInterfaces.add(match[1]);
    }

    const requiredInterfaces = [
      'CommitFundOptions',
      'RevealFundOptions',
      'FundCTimelockedOptions',
      'TimelockEntry',
      'CommitmentEntry',
      'FeeTier',
      'LoyaltyToken',
      'ScheduleUpgradeOptions',
      'ExecuteUpgradeOptions',
      'CancelUpgradeOptions',
      'PendingUpgrade',
      'MetaFundParams',
      'ExecuteMetaFundOptions',
      'FundCAddressWithReferralOptions',
    ];

    const missing = requiredInterfaces.filter((i) => !documentedInterfaces.has(i));
    expect(missing).toEqual([]);
  });
});
