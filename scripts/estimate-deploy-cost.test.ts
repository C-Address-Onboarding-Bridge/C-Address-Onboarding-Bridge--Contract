import {
  calculateMinimumBaseFeeXLM,
  estimateDeploymentCost,
  estimateFunctionResourceUsage,
  getWasmSizeNotes,
} from './estimate-deploy-cost';

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

assertEqual(calculateMinimumBaseFeeXLM(1), 0.00001, '100 stroops should equal 0.00001 XLM');
assertEqual(calculateMinimumBaseFeeXLM(4), 0.00004, 'four operations should use four minimum base fees');

const usage = estimateFunctionResourceUsage([
  { functionName: 'fund/amount=100', cpuInstructions: 100, memoryBytes: 20 },
  { functionName: 'fund/amount=1000', cpuInstructions: 300, memoryBytes: 60 },
]);
assertEqual(usage.fund.averageCpuInstructions, 200, 'resource samples should average CPU instructions per function');
assertEqual(usage.fund.averageMemoryBytes, 40, 'resource samples should average memory per function');

assertEqual(getWasmSizeNotes(10_240).length, 0, 'normal contract sizes should not trigger a 10 KiB warning');
assertEqual(getWasmSizeNotes(65_537).length, 1, 'WASM beyond the 64 KiB code limit should be flagged');

const estimate = estimateDeploymentCost(1_024, 'mainnet', []);
assertEqual(estimate.minimumBaseFeePerOperationXLM, 0.00001, 'estimate should expose the protocol minimum base fee');
assertEqual(estimate.deploymentBaseNetworkFeeXLM, null, 'deployment base fee requires a simulated operation count');
assertEqual(estimate.sorobanResourceFeeXLM, null, 'Soroban resource fee must not be presented as a fixed estimate');
assertEqual(estimate.annualStorageRentXLM, null, 'rent must not be presented as a fixed per-byte estimate');
assertEqual(estimate.totalFirstYearCostXLM, null, 'a total must not be presented without simulation and rent data');
assertEqual(estimate.limits.maxTransactionSizeBytes, 131_072, 'transaction size limit should use the protocol limit');
assertEqual(estimate.limits.maxContractCodeBytes, 65_536, 'contract code limit should be 64 KiB');

console.log('deployment estimator tests passed');
