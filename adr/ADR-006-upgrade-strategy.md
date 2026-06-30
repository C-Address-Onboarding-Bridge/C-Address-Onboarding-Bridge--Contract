# ADR-006: Contract Upgrade Strategy

**Status:** Accepted  
**Date:** 2024-01-15

## Context

Soroban supports in-place WASM replacement via `update_current_contract_wasm`. This preserves all instance storage (admin, fees, asset whitelist, etc.) while replacing the execution logic.

Three upgrade strategies were considered:

1. **Immediate upgrade** — admin calls `upgrade(new_wasm_hash)` and the new code is live in the same transaction.
2. **Timelock upgrade** — admin schedules an upgrade; a mandatory delay must pass before execution.
3. **Deploy new instance + migration** — deploy a fresh contract, migrate state manually, redirect SDK to new address.

## Decision

Use a **timelock upgrade** pattern:

- `schedule_upgrade(new_wasm_hash, delay_seconds)` (admin only): stores the pending hash and `release_time = now + delay` under `DataKey::PendingUpgrade`.
- `execute_upgrade(expected_hash)` (admin only): callable only after `release_time`; verifies the hash matches to prevent bait-and-switch; calls `update_current_contract_wasm`.
- `cancel_upgrade()` (admin only): removes the pending upgrade if the admin changes their mind.
- Minimum enforced delay: **24 hours** (configurable upward; cannot be lowered below the minimum by admin).
- The `expected_hash` parameter in `execute_upgrade` is a safety check: if the admin's key was compromised and the attacker scheduled a different WASM, the legitimate admin (who stored the expected hash off-chain at schedule time) can detect the mismatch.

Deploy-new-instance was rejected because it changes the contract ID, breaking all integrations.
Immediate upgrade was rejected because it gives no window for users to exit if the new code is malicious.

## Consequences

**Positive:**
- Users have a guaranteed window to observe the pending WASM hash and withdraw if they disagree.
- Hash verification prevents bait-and-switch attacks.
- Instance storage (admin config, fees, accrued balances) is fully preserved across upgrades.
- No change to the contract address — integrations continue working.

**Negative:**
- Security patches cannot be applied instantly; a 24-hour window must elapse. For critical bugs, the admin should pause the contract immediately while the upgrade is pending.
- Adds operational complexity: two transactions (schedule + execute) instead of one.
- If the admin key is lost after scheduling an upgrade, there is no way to execute it. Mitigated by maintaining a secure backup of the admin key.
