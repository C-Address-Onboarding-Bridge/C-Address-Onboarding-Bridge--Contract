#!/usr/bin/env bash
# Compare two benchmark JSON files and alert if gas usage increased by more than a threshold.
# Usage: ./compare_benchmarks.sh <baseline.json> <current.json> [threshold_percent]
#
# Exit codes:
#   0 - all baseline benchmarks are present and within threshold
#   1 - a benchmark is missing, gas exceeded the threshold, or input is invalid

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

python3 - "$BASELINE" "$CURRENT" "$THRESHOLD" <<'PY'
import json
import sys

baseline_path, current_path, threshold_arg = sys.argv[1:]
try:
    threshold = float(threshold_arg)
except ValueError:
    sys.exit(f"ERROR: invalid threshold: {threshold_arg}")

with open(baseline_path) as f:
    baseline = json.load(f)
with open(current_path) as f:
    current = json.load(f)

baseline_results = baseline.get("benchmark_results", [])
current_results = current.get("benchmark_results", [])
base_map = {
    f"{result['function']}/{result['variant']}": result
    for result in baseline_results
}
current_map = {
    f"{result['function']}/{result['variant']}": result
    for result in current_results
}

print(f"{'Function/Variant':<30} {'Base CPU':>12} {'Curr CPU':>12} {'Base Mem':>12} {'Curr Mem':>10} Status")
print(f"{'-' * 30:<30} {'-' * 8:>12} {'-' * 8:>12} {'-' * 8:>12} {'-' * 8:>10} {'-' * 6}")

failed = False
for key, result in current_map.items():
    if key not in base_map:
        print(f"{key:<30} {'N/A':>12} {result['cpu_insns']:>12} {'N/A':>12} {result['mem_bytes']:>10} NEW")
        continue

    base = base_map[key]
    cpu_change = ((result["cpu_insns"] - base["cpu_insns"]) / base["cpu_insns"] * 100) if base["cpu_insns"] > 0 else 0
    mem_change = ((result["mem_bytes"] - base["mem_bytes"]) / base["mem_bytes"] * 100) if base["mem_bytes"] > 0 else 0
    status = "OK"
    if cpu_change > threshold or mem_change > threshold:
        status = f"REGRESSION (+{max(cpu_change, mem_change):.1f}%)"
        failed = True
    print(
        f"{key:<30} {base['cpu_insns']:>12} {result['cpu_insns']:>12} "
        f"{base['mem_bytes']:>12} {result['mem_bytes']:>10} {status}"
    )

missing = sorted(set(base_map) - set(current_map))
if missing:
    failed = True
    print(f"\nERROR: {len(missing)} baseline benchmark(s) are missing from the current run:")
    for key in missing:
        print(f"  - {key}")

if len(current_results) < len(baseline_results):
    failed = True
    print(
        f"\nERROR: current benchmark count ({len(current_results)}) is lower than "
        f"baseline count ({len(baseline_results)})."
    )

if failed:
    sys.exit(1)
print(f"\nAll benchmarks within {threshold:g}% threshold.")
PY
