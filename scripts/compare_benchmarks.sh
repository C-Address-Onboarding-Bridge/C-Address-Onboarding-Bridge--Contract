#!/usr/bin/env bash
# Compare two benchmark JSON files and alert if gas usage increased by more than a threshold.
# Usage: ./compare_benchmarks.sh <baseline.json> <current.json> [threshold_percent]
#
# Exit codes:
#   0 - all within threshold
#   1 - at least one function exceeded threshold

set -euo pipefail

BASELINE="${1:?Usage: compare_benchmarks.sh <baseline.json> <current.json> [threshold_percent]}"
CURRENT="${2:?Usage: compare_benchmarks.sh <baseline.json> <current.json> [threshold_percent]}"
THRESHOLD="${3:-5}"

if [ ! -f "$BASELINE" ]; then
    echo "No baseline file found at $BASELINE — skipping comparison (first run)."
    exit 0
fi

if [ ! -f "$CURRENT" ]; then
    echo "ERROR: Current benchmark file not found at $CURRENT"
    exit 1
fi

echo "=== Benchmark Comparison ==="
echo "Baseline: $BASELINE"
echo "Current:  $CURRENT"
echo "Threshold: ${THRESHOLD}%"
echo ""

EXCEEDED=0

printf "%-30s %-12s %-12s %-12s %-10s %s\n" "Function/Variant" "Base CPU" "Curr CPU" "Base Mem" "Curr Mem" "Status"
printf "%-30s %-12s %-12s %-12s %-10s %s\n" "------------------------------" "--------" "--------" "--------" "--------" "------"

# Parse and compare each benchmark entry
BASELINE_COUNT=$(python3 -c "
import json, sys
with open('$BASELINE') as f:
    data = json.load(f)
print(len(data.get('benchmark_results', [])))
" 2>/dev/null || echo "0")

CURRENT_COUNT=$(python3 -c "
import json, sys
with open('$CURRENT') as f:
    data = json.load(f)
print(len(data.get('benchmark_results', [])))
" 2>/dev/null || echo "0")

python3 -c "
import json, sys

with open('$BASELINE') as f:
    baseline = json.load(f)
with open('$CURRENT') as f:
    current = json.load(f)

base_map = {}
for r in baseline.get('benchmark_results', []):
    key = f\"{r['function']}/{r['variant']}\"
    base_map[key] = r

exceeded = 0
threshold = float($THRESHOLD)

for r in current.get('benchmark_results', []):
    key = f\"{r['function']}/{r['variant']}\"
    if key not in base_map:
        print(f'{key:<30} {\"N/A\":>12} {r[\"cpu_insns\"]:>12} {\"N/A\":>12} {r[\"mem_bytes\"]:>10} NEW')
        continue

    b = base_map[key]
    base_cpu = b['cpu_insns']
    curr_cpu = r['cpu_insns']
    base_mem = b['mem_bytes']
    curr_mem = r['mem_bytes']

    cpu_change = ((curr_cpu - base_cpu) / base_cpu * 100) if base_cpu > 0 else 0
    mem_change = ((curr_mem - base_mem) / base_mem * 100) if base_mem > 0 else 0

    status = 'OK'
    if cpu_change > threshold or mem_change > threshold:
        status = f'REGRESSION (+{max(cpu_change, mem_change):.1f}%)'
        exceeded = 1

    print(f'{key:<30} {base_cpu:>12} {curr_cpu:>12} {base_mem:>12} {curr_mem:>10} {status}')

sys.exit(exceeded)
" || EXCEEDED=1

echo ""
if [ "$EXCEEDED" -eq 1 ]; then
    echo "WARNING: One or more functions exceeded the ${THRESHOLD}% gas increase threshold!"
    exit 1
else
    echo "All benchmarks within ${THRESHOLD}% threshold."
    exit 0
fi
