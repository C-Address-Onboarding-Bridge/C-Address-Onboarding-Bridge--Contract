#!/usr/bin/env node
/**
 * Diffs the public method names of `OnboardingBridgeSDK` in sdk/src/bridge.ts
 * against the `### \`methodName\`` headings in sdk/API_REFERENCE.md.
 *
 * Exits non-zero when a public method is undocumented or a documented method
 * no longer exists, so CI fails on drift between code and docs.
 *
 * Usage: node scripts/check-sdk-api-reference.js [--json]
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BRIDGE_PATH = path.join(ROOT, 'sdk', 'src', 'bridge.ts');
const DOCS_PATH = path.join(ROOT, 'sdk', 'API_REFERENCE.md');

/** Methods that are not part of the documented public surface. */
const IGNORED_METHODS = new Set(['constructor']);

/**
 * Extract public method names declared on the `OnboardingBridgeSDK` class.
 * Private/protected members and `#private` fields are skipped.
 *
 * @param {string} source - Contents of bridge.ts.
 * @returns {string[]} Sorted, de-duplicated method names.
 */
function extractPublicMethods(source) {
  const classStart = source.indexOf('export class OnboardingBridgeSDK');
  if (classStart === -1) {
    throw new Error('OnboardingBridgeSDK class not found in bridge.ts');
  }

  const methods = new Set();
  const lines = source.slice(classStart).split('\n');
  let depth = 0;
  let started = false;

  for (const line of lines) {
    if (!started) {
      if (line.includes('{')) {
        started = true;
        depth = 1;
      }
      continue;
    }

    // A member declaration sits at class-body depth (2 spaces of indentation).
    const member = /^ {2}(?:(?:public|async|static|get|set)\s+)*([A-Za-z_$][\w$]*)\s*[<(]/.exec(line);
    if (member && !/^ {2}(?:private|protected)\b/.test(line)) {
      const name = member[1];
      if (!IGNORED_METHODS.has(name)) methods.add(name);
    }

    for (const ch of line) {
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
    }
    if (depth <= 0) break;
  }

  return [...methods].sort();
}

/**
 * Extract documented method headings (`### \`name\``) from API_REFERENCE.md.
 *
 * @param {string} markdown - Contents of API_REFERENCE.md.
 * @returns {string[]} Sorted, de-duplicated method names.
 */
function extractDocumentedMethods(markdown) {
  const names = new Set();
  const heading = /^###\s+`([A-Za-z_$][\w$]*)`/gm;
  let match;
  while ((match = heading.exec(markdown)) !== null) {
    names.add(match[1]);
  }
  return [...names].sort();
}

/**
 * Compare the two name lists.
 *
 * @param {string[]} code - Public methods found in bridge.ts.
 * @param {string[]} docs - Methods documented in API_REFERENCE.md.
 * @returns {{missing: string[], stale: string[]}} Undocumented and orphaned names.
 */
function diffMethods(code, docs) {
  const codeSet = new Set(code);
  const docsSet = new Set(docs);
  return {
    missing: code.filter((name) => !docsSet.has(name)),
    stale: docs.filter((name) => !codeSet.has(name)),
  };
}

function main() {
  const code = extractPublicMethods(fs.readFileSync(BRIDGE_PATH, 'utf8'));
  const docs = extractDocumentedMethods(fs.readFileSync(DOCS_PATH, 'utf8'));
  const { missing, stale } = diffMethods(code, docs);

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify({ code, docs, missing, stale }, null, 2) + '\n');
  }

  if (missing.length === 0 && stale.length === 0) {
    console.log(`API reference is in sync (${code.length} public methods).`);
    return 0;
  }

  if (missing.length > 0) {
    console.error('Undocumented public methods in sdk/API_REFERENCE.md:');
    for (const name of missing) console.error(`  - ${name}`);
  }
  if (stale.length > 0) {
    console.error('Documented methods that no longer exist in bridge.ts:');
    for (const name of stale) console.error(`  - ${name}`);
  }
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  extractPublicMethods,
  extractDocumentedMethods,
  diffMethods,
};
