# Migration Guide

This document provides instructions for upgrading the C-Address Onboarding Bridge contract and SDK to new versions.

## Table of Contents

- [Version Compatibility Matrix](#version-compatibility-matrix)
- [Upgrading from v0.1.0](#upgrading-from-v010)
- [Breaking Changes](#breaking-changes)
- [Storage Migration Steps](#storage-migration-steps)
- [Testing Upgrades on Testnet](#testing-upgrades-on-testnet)
- [Rollback Procedures](#rollback-procedures)
- [Troubleshooting](#troubleshooting)

## Version Compatibility Matrix

| Contract Version | SDK Version | Soroban SDK | Rust | Status |
|---|---|---|---|---|
| v0.1.0 | 0.1.0 | 22.0.1 | 2021 | Current |
| v0.2.0 (planned) | 0.2.0 | 22.0.1+ | 2021 | Future |
| v1.0.0 (planned) | 1.0.0 | 24.0.0+ | 2021 | Future |

### SDK Version Compatibility

- **SDK 0.1.0**: Compatible with Contract v0.1.0
- **SDK 0.2.0+**: Maintains backward compatibility with Contract v0.1.0 (read-only operations only)

Always upgrade the contract before upgrading to a new SDK major version.

## Upgrading from v0.1.0

### Pre-Upgrade Checklist

- [ ] Backup all production keys and configuration
- [ ] Create test contract instance on testnet
- [ ] Update all SDK clients to v0.2.0+ (if upgrading to v0.2.0+)
- [ ] Review breaking changes below
- [ ] Plan maintenance window (if required)
- [ ] Notify all integrators of the upgrade

### Upgrade Process

#### Step 1: Deploy New Contract Version

```bash
# Build new contract version
cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown

# The WASM binary is available at:
# target/wasm32-unknown-unknown/release/onboarding_bridge.wasm
```

#### Step 2: Prepare Storage Migration (if needed)

Some versions may require storage schema changes. See [Storage Migration Steps](#storage-migration-steps) for details.

#### Step 3: Execute Upgrade Transaction

The current SDK exposes the contract's direct admin-only `upgrade` entrypoint.
Upload the new WASM to the target network first, then pass the resulting 32-byte
WASM hash to `sdk.upgrade`.

```typescript
import { OnboardingBridgeSDK } from '@stellar/c-address-onboarding-bridge-sdk';
import { Keypair } from '@stellar/stellar-sdk';

const sdk = new OnboardingBridgeSDK({
  contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
  rpcUrl: 'https://soroban-mainnet.stellar.org',
  networkPassphrase: 'Public Global Stellar Network ; September 2015',
});

const adminKeypair = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY!);

const result = await sdk.upgrade(
  {
    newWasmHash: 'new_wasm_hash_hex',
  },
  adminKeypair,
);

if (result.status === 'failed') {
  throw new Error(result.error);
}

console.log(`Upgrade submitted. TX: ${result.hash}`);
```

#### Step 4: Verify Contract Upgrade

```bash
# Verify contract hash changed
soroban contract info --network testnet CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4

# Verify critical state still exists
curl -X POST https://soroban-testnet.stellar.org -d '
{
  "jsonrpc": "2.0",
  "method": "sorobanRpc_getContractData",
  "params": ["query"],
  "id": 1
}' | jq .
```

#### Step 5: Verify with Smoke Tests

```bash
# Run smoke test suite
npm run test:smoke

# Manual verification
npm run dev  # Start local testnet instance
npm test     # Run integration tests
```

## Breaking Changes

### v0.1.0 → v0.2.0 (Planned)

No breaking changes anticipated for v0.2.0. It will be a pure feature release.

### v0.1.0 → v1.0.0 (Planned)

The v1.0.0 release will stabilize the API and may include breaking changes:

**Planned:**
- [ ] Simplify fee model (remove tiered fees)
- [ ] Consolidate storage keys
- [ ] Remove deprecated functions
- [ ] Require SDK v1.0.0+

**Migration impact:**
- Existing integrations will need SDK updates
- Storage migration required (see below)
- Admin must re-initialize configuration

## Storage Migration Steps

### Understanding Soroban Storage

The contract uses two storage tiers:

1. **Instance Storage** — contract-wide singletons
   - Admin, fee collector, configuration
   - TTL: Extended on every mutating call
   - Survives contract upgrades (in same account)

2. **Persistent Storage** — user/asset data
   - Account balances, nonces, daily limits
   - TTL: Must be explicitly extended
   - May expire if not used for 6 months

### Migration Strategy

#### For Configuration Changes (v0.1.0 → v0.2.0)

No migration needed. Instance storage persists across upgrades in the same account.

```rust
// These values survive the upgrade:
// - Admin (DataKey::Admin)
// - Fee collector (DataKey::FeeCollector)
// - Fee basis points (DataKey::FeeBps)
// - Paused status (DataKey::Paused)
```

#### For Schema Changes (v0.1.0 → v1.0.0, Planned)

If storage schema changes, write and deploy a contract version that performs the
required migration as part of its on-chain upgrade path. Before submitting the
upgrade, capture the existing queryable state with the SDK methods that exist
today.

```typescript
async function upgradeWithStateSnapshot(adminKeypair: Keypair, newWasmHash: string) {
  const sdk = new OnboardingBridgeSDK(CONFIG);

  const backupState = {
    admin: await sdk.getAdmin(),
    feeCollector: await sdk.getFeeCollector(),
    feeBps: await sdk.getFee(),
    initialized: await sdk.isInitialized(),
  };
  fs.writeFileSync('state_backup_v0.1.0.json', JSON.stringify(backupState));

  const result = await sdk.upgrade({ newWasmHash }, adminKeypair);
  if (result.status === 'failed') {
    throw new Error(result.error);
  }

  const postUpgradeState = {
    admin: await sdk.getAdmin(),
    feeCollector: await sdk.getFeeCollector(),
    feeBps: await sdk.getFee(),
    initialized: await sdk.isInitialized(),
  };

  if (postUpgradeState.admin !== backupState.admin) {
    throw new Error('Admin changed unexpectedly during upgrade');
  }
}
```

### TTL Management During Migration

Persistent storage entries have time-to-live (TTL) values. Before a long maintenance window:

```typescript
// The SDK does not currently expose a bulk TTL extension helper.
// Use Stellar CLI or a purpose-built maintenance script to extend each
// persistent ledger entry required by the migration.
```

## Testing Upgrades on Testnet

### Step 1: Deploy to Testnet

```bash
# 1. Build contract
cargo build -p onboarding-bridge --release --target wasm32-unknown-unknown

# 2. Deploy current version to testnet
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/onboarding_bridge.wasm \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase 'Test SDF Network ; September 2015'

# 3. Initialize with test data
npm run init:testnet
```

### Step 2: Run Test Scenarios

```bash
# Run full test suite
npm test

# Run integration tests specifically
npm run test:integration

# Run smoke tests
npm run test:smoke
```

### Step 3: Test Upgrade Path

```typescript
// 1. Deploy new version
const newWasmPath = 'target/wasm32-unknown-unknown/release/onboarding_bridge_v0.2.0.wasm';
const newWasmHash = await calculateWasmHash(fs.readFileSync(newWasmPath));

// 2. Submit upgrade on testnet
const txResult = await sdk.upgrade({
  newWasmHash: newWasmHash,
}, testAdminKeypair);

// 3. Verify upgrade
const postUpgradeState = {
  admin: await sdk.getAdmin(),
  feeBps: await sdk.getFee(),
  initialized: await sdk.isInitialized(),
};
assert.equal(
  preUpgradeState.admin,
  postUpgradeState.admin,
  'Admin should persist across upgrade'
);

// 4. Verify functionality
const fundTx = await sdk.fundCAddress({
  source: testUserAddress,
  target: testCAddress,
  asset: testTokenAddress,
  amount: '1000'
}, testUserKeypair);

assert.equal(fundTx.status, 'pending');
```

### Step 4: Stress Test

```bash
// Run under load to find any issues
npm run test:load

// Monitor:
// - Transaction success rate
// - Gas consumption
// - Ledger entry counts
// - TTL expiration edge cases
```

## Rollback Procedures

### If Upgrade Fails on Testnet

No action required; redeploy from previous known-good version.

```bash
# Redeploy previous version
soroban contract deploy \
  --wasm target/wasm32-unknown-unknown/release/onboarding_bridge_v0.1.0.wasm \
  --rpc-url https://soroban-testnet.stellar.org
```

### If Upgrade Fails During Production Timelock

If critical bugs are discovered during the timelocked upgrade window:

1. **Do NOT execute the upgrade** — Let the timelock expire
2. **Fix the bug** — Create new contract build
3. **Request new upgrade** — File a new upgrade request with corrected WASM hash
4. **Notify stakeholders** — Brief all integrators on the delay

```typescript
// Once the buggy timelock expires (no action needed):
// The upgrade request will become invalid and expire.

// Then submit the corrected upgrade:
const fixedUpgrade = await sdk.upgrade({
  newWasmHash: fixedWasmHash,
}, adminKeypair);
```

### Emergency Rollback (After Upgrade Deployed)

If the upgraded contract has a critical issue:

1. **Stop client and relayer traffic** — Prevent further damage while the
   hotfix is prepared. If the deployed contract version exposes a pause
   entrypoint, call it through the matching contract client.

2. **Notify all users** — Post incident report
3. **Deploy hotfix** — Prepare corrected version
4. **Request emergency upgrade** — Use shorter timelock if governance permits

```typescript
// Emergency upgrade (if available)
const emergencyUpgrade = await sdk.upgrade({
  newWasmHash: hotfixWasmHash,
}, adminKeypair);
```

## Troubleshooting

### Issue: "Contract already initialized" during upgrade

**Cause:** Old upgrade transaction retried (replay attack)

**Solution:**
```typescript
// Check current version
const initialized = await sdk.isInitialized();
console.log(`Initialized: ${initialized}`);

// If upgrade should be complete, investigate the contract state
const admin = await sdk.getAdmin();
console.log(`Admin: ${admin}`);
```

### Issue: Persistent storage entries missing after upgrade

**Cause:** TTL expired during upgrade window

**Solution:**
```typescript
// Check TTL status with Stellar CLI or Soroban RPC ledger-entry queries.
// Restore state only through audited contract-specific recovery tooling.
```

### Issue: Transaction fee estimation incorrect post-upgrade

**Cause:** Contract code size changed, affecting base fee

**Solution:**
```typescript
// Re-estimate fees after upgrade
const feeEstimate = await sdk.estimateCost({
  source: testUserAddress,
  target: testCAddress,
  asset: testTokenAddress,
  amount: '1000',
});

console.log(`Updated resource fee estimate: ${feeEstimate.resourceFee} stroops`);

// Update client-side fee calculations
const txConfig = { ...oldConfig, baseFee: feeEstimate };
```

### Issue: SDK client stops working after contract upgrade

**Cause:** Breaking API change in new contract version

**Solution:**
```typescript
// 1. Check SDK version compatibility
const sdkVersion = require('@stellar/c-address-onboarding-bridge-sdk/package.json').version;
const initialized = await sdk.isInitialized();

console.log(`SDK ${sdkVersion}; contract initialized: ${initialized}`);

// 2. If incompatible, upgrade SDK
npm install @stellar/c-address-onboarding-bridge-sdk@latest

// 3. Update code to new SDK API (check CHANGELOG.md)
```

## Version Release Cycle

### Release Planning

1. **Planning** — Gather feature requests, identify breaking changes
2. **Development** — Implement features on feature branches
3. **Testing** — Deploy to testnet, run full test suite
4. **Audit** (major versions only) — Third-party security review
5. **Release Candidate** — RC period on testnet (1-2 weeks)
6. **Mainnet Release** — Deploy with 7-day timelock
7. **Documentation** — Update migration guides, changelog

### Support Policy

- **Current version**: Full support
- **Previous major version**: Bug fixes only
- **Older versions**: No support (upgrade recommended)

Example:
- v1.0.x: Full support
- v0.2.x: Bug fixes only
- v0.1.x: No support

## See Also

- [DEVELOPER_SETUP.md](DEVELOPER_SETUP.md) — Development environment
- [TESTING.md](TESTING.md) — Testing guide
- [README.md](README.md) — Architecture and features
- [Soroban Documentation](https://developers.stellar.org/learn/soroban)
