#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
output="$(mktemp)"
trap 'rm -f "$output"' EXIT

if bash "$ROOT/scripts/compare_benchmarks.sh" \
  "$ROOT/scripts/fixtures/benchmark-baseline.json" \
  "$ROOT/scripts/fixtures/benchmark-current-dropped.json" 5 >"$output" 2>&1; then
  cat "$output"
  echo "ERROR: comparison succeeded despite a dropped benchmark" >&2
  exit 1
fi

grep -q 'query_balance/default' "$output"
grep -q 'baseline benchmark(s) are missing' "$output"
echo "Benchmark disappearance regression test passed."
