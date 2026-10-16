#!/usr/bin/env ts-node

/**
 * Deployment resource report for C-Address Onboarding Bridge.
 *
 * The report intentionally does not convert benchmark resource usage or
 * contract-code bytes into XLM. Soroban resource fees and rent depend on the
 * transaction simulation and current network configuration.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface CostEstimate {
  wasmSizeBytes: number;
  minimumBaseFeePerOperationXLM: number;
  deploymentBaseNetworkFeeXLM: null;
  sorobanResourceFeeXLM: null;
  annualStorageRentXLM: null;
  totalFirstYearCostXLM: null;
  functionResourceUsage: Record<string, FunctionResourceUsage>;
  limits: {
    maxTransactionSizeBytes: number;
    maxContractCodeBytes: number;
  };
  network: string;
  timestamp: string;
  notes: string[];
}

export interface BenchmarkEntry {
  functionName: string;
  cpuInstructions: number;
  memoryBytes: number;
}

export interface FunctionResourceUsage {
  averageCpuInstructions: number;
  averageMemoryBytes: number;
}

const SUPPORTED_NETWORKS = ['mainnet', 'testnet', 'sandbox'];
const STROOPS_PER_XLM = 10_000_000;
const MIN_BASE_FEE_STROOPS = 100;
const MAX_TRANSACTION_SIZE_BYTES = 131_072;
const MAX_CONTRACT_CODE_BYTES = 65_536;
const BENCH_BASELINE_PATH = path.resolve(process.cwd(), 'bench_baseline.txt');

function getWasmFileSize(wasmPath: string): number {
  try {
    return fs.statSync(wasmPath).size;
  } catch (error) {
    throw new Error(`Failed to read WASM file at ${wasmPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeFunctionName(name: string): string {
  return name.split('/')[0];
}

export function readBenchmarkEntries(benchPath: string = BENCH_BASELINE_PATH): BenchmarkEntry[] {
  if (!fs.existsSync(benchPath)) return [];

  const lines = fs.readFileSync(benchPath, 'utf8').trim().split(/\r?\n/);
  return lines.slice(1).flatMap((line) => {
    const [functionName, cpuInstructions, memoryBytes] = line.split(/\s+/);
    const cpu = Number(cpuInstructions);
    const memory = Number(memoryBytes);

    if (!functionName || !Number.isFinite(cpu) || !Number.isFinite(memory)) {
      return [];
    }

    return [{ functionName, cpuInstructions: cpu, memoryBytes: memory }];
  });
}

export function calculateMinimumBaseFeeXLM(
  operationCount: number,
  baseFeeStroops: number = MIN_BASE_FEE_STROOPS,
): number {
  if (!Number.isInteger(operationCount) || operationCount < 0) {
    throw new Error(`operationCount must be a non-negative integer, got ${operationCount}`);
  }
  if (!Number.isFinite(baseFeeStroops) || baseFeeStroops < MIN_BASE_FEE_STROOPS) {
    throw new Error(`baseFeeStroops must be at least ${MIN_BASE_FEE_STROOPS}, got ${baseFeeStroops}`);
  }
  return operationCount * baseFeeStroops / STROOPS_PER_XLM;
}

export function estimateFunctionResourceUsage(
  entries: BenchmarkEntry[],
): Record<string, FunctionResourceUsage> {
  const grouped = new Map<string, BenchmarkEntry[]>();

  for (const entry of entries) {
    const name = normalizeFunctionName(entry.functionName);
    grouped.set(name, [...(grouped.get(name) ?? []), entry]);
  }

  return Object.fromEntries(
    Array.from(grouped.entries()).map(([name, samples]) => [
      name,
      {
        averageCpuInstructions:
          samples.reduce((sum, sample) => sum + sample.cpuInstructions, 0) / samples.length,
        averageMemoryBytes:
          samples.reduce((sum, sample) => sum + sample.memoryBytes, 0) / samples.length,
      },
    ]),
  );
}

export function getWasmSizeNotes(wasmSizeBytes: number): string[] {
  if (!Number.isFinite(wasmSizeBytes) || wasmSizeBytes < 0) {
    throw new Error(`wasmSizeBytes must be a non-negative number, got ${wasmSizeBytes}`);
  }
  if (wasmSizeBytes > MAX_CONTRACT_CODE_BYTES) {
    return [`WASM size (${wasmSizeBytes} bytes) exceeds the Soroban contract code limit (${MAX_CONTRACT_CODE_BYTES} bytes).`];
  }
  return [];
}

export function estimateDeploymentCost(
  wasmSizeBytes: number,
  network: string = 'mainnet',
  benchmarkEntries: BenchmarkEntry[] = readBenchmarkEntries(),
): CostEstimate {
  const normalizedNetwork = network.toLowerCase();
  if (!SUPPORTED_NETWORKS.includes(normalizedNetwork)) {
    throw new Error(`Unknown network: ${network}. Available: ${SUPPORTED_NETWORKS.join(', ')}`);
  }

  const notes = [
    'The base fee is the Stellar protocol minimum of 100 stroops (0.00001 XLM) per operation; the current network fee may be higher.',
    'Deployment total is not estimated: obtain the operation count and fee with a transaction simulation against the selected RPC.',
    'Soroban resource fees and storage rent are not estimated; they depend on the simulated transaction, entry TTLs, and current network rent configuration.',
    'CPU and memory values are local benchmark measurements from bench_baseline.txt, not XLM fee conversions.',
  ];
  notes.push(...getWasmSizeNotes(wasmSizeBytes));

  return {
    wasmSizeBytes,
    minimumBaseFeePerOperationXLM: calculateMinimumBaseFeeXLM(1),
    deploymentBaseNetworkFeeXLM: null,
    sorobanResourceFeeXLM: null,
    annualStorageRentXLM: null,
    totalFirstYearCostXLM: null,
    functionResourceUsage: estimateFunctionResourceUsage(benchmarkEntries),
    limits: {
      maxTransactionSizeBytes: MAX_TRANSACTION_SIZE_BYTES,
      maxContractCodeBytes: MAX_CONTRACT_CODE_BYTES,
    },
    network: normalizedNetwork,
    timestamp: new Date().toISOString(),
    notes,
  };
}

function formatCost(xlm: number): string {
  if (xlm < 0.0001) {
    return `${(xlm * 1_000_000).toFixed(2)} μXLM`;
  }
  if (xlm < 1) {
    return `${(xlm * 1000).toFixed(4)} mXLM`;
  }
  return `${xlm.toFixed(6)} XLM`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function printEstimate(estimate: CostEstimate): void {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║     C-Address Onboarding Bridge - Deployment Resource Report ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log(`📦 Contract WASM Size:         ${formatBytes(estimate.wasmSizeBytes)}`);
  console.log(`🌐 Network:                   ${estimate.network.toUpperCase()}`);
  console.log(`🕐 Reported at:               ${estimate.timestamp}\n`);
  console.log(`💰 Minimum base fee/operation: ${formatCost(estimate.minimumBaseFeePerOperationXLM)}`);
  console.log('💰 Deployment base fee:       Not estimated (requires operation count)');
  console.log('💰 Soroban resource fee:      Not estimated (requires transaction simulation)');
  console.log('💰 Annual storage rent:       Not estimated (requires ledger-entry TTL/rent data)');
  console.log('📊 Total first-year cost:     Not estimated\n');

  if (Object.keys(estimate.functionResourceUsage).length > 0) {
    console.log('📈 Local benchmark resource usage (not fee estimates):');
    Object.entries(estimate.functionResourceUsage)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([functionName, usage]) => {
        console.log(`  └─ ${functionName}: ${usage.averageCpuInstructions.toFixed(0)} CPU instructions, ${formatBytes(usage.averageMemoryBytes)} memory`);
      });
    console.log();
  }

  console.log(`📐 Protocol limits: transaction ${formatBytes(estimate.limits.maxTransactionSizeBytes)}, contract code ${formatBytes(estimate.limits.maxContractCodeBytes)}`);
  if (estimate.notes.length > 0) {
    console.log('\n📋 Notes:');
    estimate.notes.forEach((note) => console.log(`  ${note}`));
  }
  console.log('\nℹ️  Use Soroban transaction simulation and current network rent configuration for budget estimates.\n');
}

function main(): void {
  const args = process.argv.slice(2);
  let wasmPath: string | null = null;
  let network = 'mainnet';
  let outputJson = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: estimate-deploy-cost [OPTIONS] <wasm-file>

Options:
  <wasm-file>        Path to the compiled WASM contract binary
  --network <name>   Network: mainnet (default), testnet, or sandbox
  --json            Output results as JSON instead of formatted text
  --help, -h         Show this help message

Examples:
  npx ts-node scripts/estimate-deploy-cost.ts target/wasm32v1-none/release/address_onboarding_bridge.wasm
  npx ts-node scripts/estimate-deploy-cost.ts --network testnet ./contract.wasm
  npx ts-node scripts/estimate-deploy-cost.ts --json ./contract.wasm | jq .
      `);
      process.exit(0);
    } else if (arg === '--network' && i + 1 < args.length) {
      network = args[++i];
    } else if (arg === '--json') {
      outputJson = true;
    } else if (!arg.startsWith('--')) {
      wasmPath = arg;
    }
  }

  if (!wasmPath) {
    wasmPath = process.env.WASM_FILE || 'target/wasm32v1-none/release/address_onboarding_bridge.wasm';
  }

  const normalizedNetwork = network.toLowerCase();
  if (!SUPPORTED_NETWORKS.includes(normalizedNetwork)) {
    console.error(`❌ Unknown network: ${network}`);
    console.error(`   Available: ${SUPPORTED_NETWORKS.join(', ')}`);
    process.exit(1);
  }

  try {
    const resolvedPath = path.resolve(process.cwd(), wasmPath);
    if (!fs.existsSync(resolvedPath)) {
      console.error(`❌ WASM file not found: ${resolvedPath}`);
      console.error('\nPlease build the contract first:');
      console.error('  cargo build --release --target wasm32v1-none');
      process.exit(1);
    }

    const estimate = estimateDeploymentCost(getWasmFileSize(resolvedPath), normalizedNetwork);
    if (outputJson) {
      console.log(JSON.stringify(estimate, null, 2));
    } else {
      printEstimate(estimate);
    }
  } catch (error) {
    console.error(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (require.main === module) main();
