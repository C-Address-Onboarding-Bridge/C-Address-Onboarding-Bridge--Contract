#!/usr/bin/env node

/**
 * Validates that all public methods in OnboardingBridgeSDK (bridge.ts)
 * and all required SDK interfaces are documented in API_REFERENCE.md.
 */

const fs = require('fs');
const path = require('path');

const bridgePath = path.resolve(__dirname, '../src/bridge.ts');
const docPath = path.resolve(__dirname, '../API_REFERENCE.md');

if (!fs.existsSync(bridgePath)) {
  console.error(`Error: bridge.ts not found at ${bridgePath}`);
  process.exit(1);
}

if (!fs.existsSync(docPath)) {
  console.error(`Error: API_REFERENCE.md not found at ${docPath}`);
  process.exit(1);
}

const bridgeSrc = fs.readFileSync(bridgePath, 'utf8');
const docSrc = fs.readFileSync(docPath, 'utf8');

// 1. Extract public methods from OnboardingBridgeSDK
const methodRegex = /^\s*(?:async\s+)([a-zA-Z0-9_]+)\s*\(/gm;
const publicMethods = new Set();
let match;
while ((match = methodRegex.exec(bridgeSrc)) !== null) {
  publicMethods.add(match[1]);
}

// 2. Extract method headings from API_REFERENCE.md under OnboardingBridgeSDK
const sdkStart = docSrc.indexOf('### `OnboardingBridgeSDK`');
const sdkEnd = docSrc.indexOf('### `OffRampIntegration`', sdkStart);

if (sdkStart === -1 || sdkEnd === -1) {
  console.error('Error: Could not find OnboardingBridgeSDK section in API_REFERENCE.md');
  process.exit(1);
}

const sdkSection = docSrc.slice(sdkStart, sdkEnd);
const headingRegex = /^#####\s+`([a-zA-Z0-9_]+)`/gm;
const documentedMethods = new Set();
while ((match = headingRegex.exec(sdkSection)) !== null) {
  documentedMethods.add(match[1]);
}

const missingMethods = [...publicMethods].filter(m => !documentedMethods.has(m));

// 3. Extract documented interfaces
const interfacesStart = docSrc.indexOf('## Interfaces');
const interfacesEnd = docSrc.indexOf('## Type Aliases', interfacesStart);
const interfacesSection = interfacesStart !== -1 && interfacesEnd !== -1
  ? docSrc.slice(interfacesStart, interfacesEnd)
  : docSrc.slice(interfacesStart);

const interfaceHeadingRegex = /^###\s+`([a-zA-Z0-9_]+)`/gm;
const documentedInterfaces = new Set();
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

const missingInterfaces = requiredInterfaces.filter(i => !documentedInterfaces.has(i));

let hasErrors = false;

if (missingMethods.length > 0) {
  console.error(`FAILED: ${missingMethods.length} public OnboardingBridgeSDK methods missing from API_REFERENCE.md:`);
  for (const m of missingMethods) {
    console.error(`  - ${m}`);
  }
  hasErrors = true;
} else {
  console.log(`PASS: All ${publicMethods.size} public OnboardingBridgeSDK methods are documented in API_REFERENCE.md.`);
}

if (missingInterfaces.length > 0) {
  console.error(`FAILED: ${missingInterfaces.length} interfaces missing from API_REFERENCE.md ## Interfaces:`);
  for (const i of missingInterfaces) {
    console.error(`  - ${i}`);
  }
  hasErrors = true;
} else {
  console.log(`PASS: All ${requiredInterfaces.length} required interfaces are documented in API_REFERENCE.md.`);
}

if (hasErrors) {
  process.exit(1);
}

console.log('API documentation validation passed successfully!');
process.exit(0);
