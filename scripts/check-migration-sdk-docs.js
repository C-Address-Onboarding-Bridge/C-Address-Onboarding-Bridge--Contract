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
