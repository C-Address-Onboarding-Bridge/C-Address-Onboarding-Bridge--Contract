#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const bridgePath = path.join(repoRoot, 'sdk', 'src', 'bridge.ts');
const bridge = fs.readFileSync(bridgePath, 'utf8');

const documentationPaths = ['MIGRATION.md', 'README.md', 'examples/README.md']
  .map((relativePath) => path.join(repoRoot, relativePath))
  .filter((filePath) => fs.existsSync(filePath));

const documentedMethods = new Set(
  documentationPaths.flatMap((filePath) =>
    [...fs.readFileSync(filePath, 'utf8').matchAll(/\bsdk\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
      .map((match) => match[1]),
  ),
);

const implementedMethods = new Set(
  [...bridge.matchAll(/^\s{2}(?:private\s+)?async\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)].map((match) => match[1]),
);

const missing = [...documentedMethods].filter((method) => !implementedMethods.has(method));

if (missing.length > 0) {
  console.error(
    `Documentation references SDK methods that do not exist: ${missing.join(', ')}`,
  );
  process.exit(1);
}

console.log('SDK documentation examples reference implemented SDK methods.');

// Every `##### \`method\`` heading in the OnboardingBridgeSDK section of
// sdk/API_REFERENCE.md must name a method that exists on
// OnboardingBridgeSDK.prototype (#1138). Headings under other classes
// (OffRampIntegration, CachedContractClient, ...) are out of scope.
const apiReferencePath = path.join(repoRoot, 'sdk', 'API_REFERENCE.md');
if (fs.existsSync(apiReferencePath)) {
  const apiReference = fs.readFileSync(apiReferencePath, 'utf8');
  const sectionStart = apiReference.indexOf('### `OnboardingBridgeSDK`');
  if (sectionStart === -1) {
    console.error('sdk/API_REFERENCE.md has no `### \`OnboardingBridgeSDK\`` section.');
    process.exit(1);
  }
  const bodyStart = apiReference.indexOf('\n', sectionStart) + 1;
  const nextSection = apiReference.slice(bodyStart).search(/^#{1,3} /m);
  const section =
    nextSection === -1
      ? apiReference.slice(bodyStart)
      : apiReference.slice(bodyStart, bodyStart + nextSection);

  const prototypeMethods = new Set(
    [...bridge.matchAll(/^\s{2}(?:public\s+)?(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>\n]*>)?\s*\(/gm)]
      .map((match) => match[1])
      .filter((name) => !['if', 'for', 'while', 'switch', 'return', 'constructor'].includes(name)),
  );
  const privateMethods = new Set(
    [...bridge.matchAll(/^\s{2}private\s+(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)].map((m) => m[1]),
  );

  const headings = [...section.matchAll(/^#####\s+`([A-Za-z_][A-Za-z0-9_]*)`/gm)].map((m) => m[1]);
  const undocumentedHeadings = headings.filter(
    (name) => !prototypeMethods.has(name) || privateMethods.has(name),
  );

  if (undocumentedHeadings.length > 0) {
    console.error(
      `sdk/API_REFERENCE.md documents OnboardingBridgeSDK methods that do not exist: ${undocumentedHeadings.join(', ')}`,
    );
    process.exit(1);
  }

  console.log(`sdk/API_REFERENCE.md: all ${headings.length} OnboardingBridgeSDK method headings exist.`);
}
