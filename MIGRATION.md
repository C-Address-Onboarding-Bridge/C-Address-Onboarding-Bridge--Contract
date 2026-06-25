# Migration Guide

This guide describes how to plan and execute upgrades from `v0.1.0` of the C-Address Onboarding Bridge contract and SDK to later versions. Treat every contract upgrade as a production change that needs testnet rehearsal, explicit compatibility checks, and a rollback plan.

## Upgrade overview

1. Review the target release notes and breaking-change checklist.
2. Compare storage layout, public contract functions, events, and SDK types against the currently deployed version.
3. Build the new WASM artifact from the exact release commit.
4. Rehearse the upgrade on testnet with production-like configuration.
5. Upgrade SDK consumers in a staging environment.
6. Execute the production deployment or replacement procedure.
7. Verify contract state, event indexing, SDK calls, and fee withdrawal flows.
8. Keep the previous contract ID and SDK version available until the new version is stable.

## Upgrading from v0.1.0

Version `v0.1.0` establishes the first public contract and SDK surface. For later versions, classify the upgrade before making changes:

- **SDK-only update**: no on-chain contract replacement is required; update npm package consumers and run SDK compatibility tests.
- **Compatible contract update**: public behavior and storage remain compatible; deploy the new WASM and follow the release-specific upgrade instructions.
- **Breaking contract update**: storage, events, authorization, fee behavior, or public method signatures change; deploy a new contract instance and migrate integrations deliberately.

If the existing contract does not expose an explicit upgrade entrypoint, use a replacement deployment: deploy the new contract, initialize it with approved values, migrate operational configuration, update SDK/backend/frontend contract IDs, and keep the old contract available for reconciliation until all pending flows are closed.

## Breaking-change checklist

Before approving an upgrade, check whether the release changes any of the following:

- Contract function names, argument order, argument types, or return values.
- Event names, topics, or payload fields used by indexers.
- Storage keys, storage value shapes, initialization state, or fee accounting.
- Authorization requirements for admin, fee collector, source accounts, or batch funding.
- Fee calculation, maximum fee basis points, rounding, or withdrawal behavior.
- SDK class names, method signatures, exported interfaces, or error shapes.
- Deployment configuration such as RPC URL, network passphrase, contract ID, or token contract IDs.

Any checked item should be documented in release notes and called out in pull request testing notes.

## Storage migration steps

When storage layout changes, use an explicit migration plan:

1. Export the current contract ID, admin address, fee collector, fee bps, accumulated fee balance, and any other release-specific state.
2. Snapshot recent events and the last processed ledger for indexers.
3. Deploy or upgrade the new contract on testnet.
4. Initialize the new contract with migrated configuration values.
5. Re-run read-only queries and compare expected state.
6. Execute a small funding transaction and verify fee accrual and event emission.
7. Update application configuration only after verification passes.

Do not assume contract storage can be transformed in place unless the contract exposes and tests an explicit migration function.

## SDK compatibility matrix

| Contract version | Compatible SDK version | Notes |
| --- | --- | --- |
| `v0.1.0` | `0.1.x` | Initial SDK and contract surface. |
| `v0.2.x` | `0.2.x` or release-specific compatibility notes | Verify method signatures, event payloads, and deployment configuration before upgrading. |
| Future breaking release | Matching major/minor SDK release | Pin the SDK version until consumer applications have migrated. |

Consumers should pin SDK versions in production apps and upgrade through staging before changing production contract IDs.

## Testnet rehearsal

Run every upgrade on testnet first:

```bash
cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown
npx ts-node scripts/deploy.ts all --config deploy-config.testnet.json
cargo test -p onboarding-bridge --features testutils
npm test --prefix sdk
```

After deployment, verify:

- `query_is_initialized` returns the expected value.
- `query_admin`, `query_fee_collector`, and `query_fee_bps` match approved configuration.
- `fund_c_address` and `batch_fund_c_address` still emit expected events.
- SDK examples run against the new contract ID.
- Monitoring can resume from the stored ledger cursor without duplicate notifications.

## Rollback procedure

Rollback depends on upgrade type:

- **SDK-only rollback**: redeploy the previous application build or pin the previous SDK package version.
- **Replacement deployment rollback**: switch application configuration back to the previous contract ID and pause new traffic to the replacement contract.
- **In-place upgrade rollback**: only possible if the contract has an explicit, tested downgrade or compatibility mode.

Before rollback, record which transactions used the new contract. Reconcile partial funding flows and event indexers so users do not see duplicate or missing status updates.

## Upgrade script example

This pseudocode shows the expected shape of an upgrade helper. Keep real secrets in a secret manager or local environment file that is never committed.

```ts
import { execFileSync } from "node:child_process";

const config = {
  network: "testnet",
  wasmPath: "target/wasm32-unknown-unknown/release/onboarding_bridge.wasm",
  deployerIdentity: "c-address-deployer",
  adminAddress: "G...",
  feeCollectorAddress: "G...",
  feeBps: "50",
};

execFileSync("cargo", ["build", "-p", "onboarding-bridge", "--release", "--target", "wasm32-unknown-unknown"], { stdio: "inherit" });

execFileSync("stellar", [
  "contract", "install",
  "--wasm", config.wasmPath,
  "--source", config.deployerIdentity,
  "--network", config.network,
], { stdio: "inherit" });

// Capture the WASM hash from the install output, deploy the contract, then
// invoke initialize with admin, fee collector, and fee bps after review.
```

Keep real upgrade scripts idempotent where possible and make them print the commit SHA, WASM hash, contract ID, and transaction hashes for release records.
