#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const bridgePath = path.join(repoRoot, 'sdk', 'src', 'bridge.ts');
const apiRefPath = path.join(repoRoot, 'sdk', 'API_REFERENCE.md');

if (!fs.existsSync(bridgePath) || !fs.existsSync(apiRefPath)) {
  console.error('Missing bridge.ts or API_REFERENCE.md');
  process.exit(1);
}

const bridge = fs.readFileSync(bridgePath, 'utf8');
const apiRef = fs.readFileSync(apiRefPath, 'utf8');

// Extract public async methods from OnboardingBridgeSDK
const publicMethods = new Set(
  [...bridge.matchAll(/^\s{2}(?!private\b)(?:async\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]),
);

// Extract method headings from API_REFERENCE.md (e.g. ##### `fundCAddress`)
const documentedHeadings = new Set(
  [...apiRef.matchAll(/^#####\s+[`]?([A-Za-z_][A-Za-z0-9_]*)[`]?/gm)].map((m) => m[1]),
);

const missingMethods = [...publicMethods].filter((m) => !documentedHeadings.has(m)).sort();

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
  'PendingUpgrade',
  'MetaFundParams',
  'ExecuteMetaFundOptions',
];

const documentedInterfaces = new Set(
  [...apiRef.matchAll(/^###\s+[`]?([A-Za-z_][A-Za-z0-9_]*)[`]?/gm)].map((m) => m[1]),
);

const missingInterfaces = requiredInterfaces.filter((i) => !documentedInterfaces.has(i)).sort();

let failed = false;
if (missingMethods.length > 0) {
  console.error(`API_REFERENCE.md omits ${missingMethods.length} public OnboardingBridgeSDK methods:`);
  missingMethods.forEach((m) => console.error(`  - ${m}`));
  failed = true;
}

if (missingInterfaces.length > 0) {
  console.error(`API_REFERENCE.md omits ${missingInterfaces.length} required interfaces:`);
  missingInterfaces.forEach((i) => console.error(`  - ${i}`));
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log(`All ${publicMethods.size} public OnboardingBridgeSDK methods and ${requiredInterfaces.length} required interfaces are documented in API_REFERENCE.md.`);
