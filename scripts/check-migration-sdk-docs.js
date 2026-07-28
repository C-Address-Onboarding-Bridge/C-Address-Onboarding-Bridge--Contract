#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const migrationPath = path.join(repoRoot, 'MIGRATION.md');
const bridgePath = path.join(repoRoot, 'sdk', 'src', 'bridge.ts');

const migration = fs.readFileSync(migrationPath, 'utf8');
const bridge = fs.readFileSync(bridgePath, 'utf8');

const documentedMethods = new Set(
  [...migration.matchAll(/\bsdk\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((match) => match[1]),
);

const implementedMethods = new Set(
  [...bridge.matchAll(/^\s+(?:async\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm)].map((match) => match[1]),
);

const missing = [...documentedMethods].filter((method) => !implementedMethods.has(method));

if (missing.length > 0) {
  console.error(
    `MIGRATION.md documents SDK methods that do not exist: ${missing.join(', ')}`,
  );
  process.exit(1);
}

console.log('MIGRATION.md SDK examples reference implemented SDK methods.');
