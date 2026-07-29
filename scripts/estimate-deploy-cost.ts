#!/usr/bin/env ts-node

/**
 * Deployment Cost Estimator for C-Address Onboarding Bridge
 *
 * Estimates XLM costs for deploying the onboarding bridge contract
 * to Soroban, including storage rent and transaction costs.
 */

import * as fs from 'fs';
import * as path from 'path';

interface NetworkFeeEstimates {
  baseNetworkFeeXLM: number;
  storageFeePerBytePerYear: number;
  maxTransactionSizeBytes: number;
}

// Soroban network fee estimates (updated periodically, adjust as needed)
const NETWORK_FEES: Record<string, NetworkFeeEstimates> = {
  mainnet: {
    baseNetworkFeeXLM: 0.000001, // 1 microXLM per operation
    storageFeePerBytePerYear: 0.000001, // ~1 microXLM per byte per year
    maxTransactionSizeBytes: 10000,
  },
  testnet: {
    baseNetworkFeeXLM: 0.000001,
    storageFeePerBytePerYear: 0.000001,
    maxTransactionSizeBytes: 10000,
  },
  sandbox: {
    baseNetworkFeeXLM: 0.000001,
    storageFeePerBytePerYear: 0.000001,
    maxTransactionSizeBytes: 10000,
  },
};

interface CostEstimate {
  wasmSizeBytes: number;
  deploymentCostXLM: number;
  annualStorageRentXLM: number;
  estimatedTransactionCostXLM: number;
  functionTransactionCostsXLM: Record<string, number>;
  totalFirstYearCostXLM: number;
  network: string;
  timestamp: string;
  notes: string[];
}

interface BenchmarkEntry {
  functionName: string;
  cpuInstructions: number;
  memoryBytes: number;
}

const BENCH_BASELINE_PATH = path.resolve(process.cwd(), 'bench_baseline.txt');
const CPU_INSTRUCTION_COST_XLM = 0.00001 / 569803;
const MEMORY_BYTE_COST_XLM = 0.000002 / 96474;

function getWasmFileSize(wasmPath: string): number {
  try {
    const stats = fs.statSync(wasmPath);
    return stats.size;
  } catch (error) {
    throw new Error(`Failed to read WASM file at ${wasmPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeFunctionName(name: string): string {
  return name.split('/')[0];
}

function readBenchmarkEntries(benchPath: string = BENCH_BASELINE_PATH): BenchmarkEntry[] {
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

function estimateFunctionTransactionCosts(entries: BenchmarkEntry[]): Record<string, number> {
  const grouped = new Map<string, number[]>();

  for (const entry of entries) {
    const name = normalizeFunctionName(entry.functionName);
    const estimate =
      (entry.cpuInstructions * CPU_INSTRUCTION_COST_XLM) +
      (entry.memoryBytes * MEMORY_BYTE_COST_XLM);
    grouped.set(name, [...(grouped.get(name) || []), estimate]);
  }

  return Object.fromEntries(
    Array.from(grouped.entries()).map(([name, estimates]) => [
      name,
      estimates.reduce((sum, value) => sum + value, 0) / estimates.length,
    ]),
  );
}

function estimateDeploymentCost(
  wasmSizeBytes: number,
  network: string = 'mainnet'
): CostEstimate {
  const fees = NETWORK_FEES[network.toLowerCase()] || NETWORK_FEES.mainnet;

  // Deployment cost: base fee for contract creation operation
  // Soroban contract creation typically uses 3-5 operations
  const deploymentCostXLM = fees.baseNetworkFeeXLM * 4;

  // Storage cost: charged based on contract code size
  // Storage rent is paid annually for persistent data
  const annualStorageRentXLM = (wasmSizeBytes * fees.storageFeePerBytePerYear);

  const functionTransactionCostsXLM = estimateFunctionTransactionCosts(readBenchmarkEntries());
  const functionCosts = Object.values(functionTransactionCostsXLM);
  const estimatedTransactionCostXLM = functionCosts.length > 0
    ? functionCosts.reduce((sum, value) => sum + value, 0) / functionCosts.length
    : 0.00001;

  // Total first year cost
  const totalFirstYearCostXLM = deploymentCostXLM + annualStorageRentXLM + estimatedTransactionCostXLM;

  const notes: string[] = [];

  if (wasmSizeBytes > fees.maxTransactionSizeBytes) {
    notes.push(`⚠️  WASM size (${wasmSizeBytes} bytes) exceeds typical transaction limit (${fees.maxTransactionSizeBytes} bytes)`);
  }

  if (wasmSizeBytes > 65536) {
    notes.push('⚠️  Large contract (>64KB) may have higher gas costs during execution');
  }

  if (annualStorageRentXLM > 1) {
    notes.push('⚠️  Annual storage rent exceeds 1 XLM — consider optimizing contract size');
  }

  return {
    wasmSizeBytes,
    deploymentCostXLM,
    annualStorageRentXLM,
    estimatedTransactionCostXLM,
    functionTransactionCostsXLM,
    totalFirstYearCostXLM,
    network: network.toLowerCase(),
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
  console.log('║     C-Address Onboarding Bridge - Deployment Cost Estimate  ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  console.log(`📦 Contract WASM Size:        ${formatBytes(estimate.wasmSizeBytes)}`);
  console.log(`🌐 Network:                  ${estimate.network.toUpperCase()}`);
  console.log(`🕐 Estimated at:             ${estimate.timestamp}\n`);

  console.log('💰 Cost Breakdown:');
  console.log(`  └─ Deployment (contract creation):    ${formatCost(estimate.deploymentCostXLM)}`);
  console.log(`  └─ Annual storage rent:               ${formatCost(estimate.annualStorageRentXLM)}`);
  console.log(`  └─ Avg transaction cost (benchmarked): ${formatCost(estimate.estimatedTransactionCostXLM)}\n`);

  if (Object.keys(estimate.functionTransactionCostsXLM).length > 0) {
    console.log('📈 Function-specific Transaction Estimates:');
    Object.entries(estimate.functionTransactionCostsXLM)
      .sort(([a], [b]) => a.localeCompare(b))
      .forEach(([functionName, cost]) => {
        console.log(`  └─ ${functionName}: ${formatCost(cost)}`);
      });
    console.log();
  }

  console.log(`📊 Total First Year Cost:    ${formatCost(estimate.totalFirstYearCostXLM)}`);
  console.log(`📊 Annual Cost (after Y1):   ${formatCost(estimate.annualStorageRentXLM)}\n`);

  if (estimate.notes.length > 0) {
    console.log('📋 Notes:');
    estimate.notes.forEach(note => console.log(`  ${note}`));
    console.log();
  }

  console.log('ℹ️  These are estimates based on current Soroban fee structure and bench_baseline.txt.');
  console.log('   Actual costs may vary. Check https://soroban.stellar.org for current rates.\n');
}

function main(): void {
  const args = process.argv.slice(2);

  // Parse arguments
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
  --help, -h        Show this help message

Examples:
  npx ts-node scripts/estimate-deploy-cost.ts target/wasm32-unknown-unknown/release/onboarding_bridge.wasm
  npx ts-node scripts/estimate-deploy-cost.ts --network testnet ./contract.wasm
  npx ts-node scripts/estimate-deploy-cost.ts --json ./contract.wasm | jq .

Environment:
  Set WASM_FILE environment variable to use a default WASM file path.
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

  // Use environment variable if wasm path not provided
  if (!wasmPath) {
    wasmPath = process.env.WASM_FILE || 'target/wasm32-unknown-unknown/release/onboarding_bridge.wasm';
  }

  // Validate network
  if (!NETWORK_FEES[network.toLowerCase()]) {
    console.error(`❌ Unknown network: ${network}`);
    console.error(`   Available: ${Object.keys(NETWORK_FEES).join(', ')}`);
    process.exit(1);
  }

  try {
    // Resolve path relative to project root
    const resolvedPath = path.resolve(process.cwd(), wasmPath);

    if (!fs.existsSync(resolvedPath)) {
      console.error(`❌ WASM file not found: ${resolvedPath}`);
      console.error(`\nPlease build the contract first:`);
      console.error(`  cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown`);
      process.exit(1);
    }

    const wasmSize = getWasmFileSize(resolvedPath);
    const estimate = estimateDeploymentCost(wasmSize, network);

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

main();
