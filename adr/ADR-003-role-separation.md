# ADR-003: Admin and Fee Collector Role Separation

**Status:** Accepted  
**Date:** 2024-01-15

## Context

Smart contracts commonly use a single "owner" address for all privileged operations. Combining configuration control and fund withdrawal into one keypair creates a large blast radius: compromise of the owner key grants both config manipulation and the ability to drain fees.

## Decision

Split privileges into **two distinct roles**:

| Role | Key stored | Can do |
|---|---|---|
| `admin` | `DataKey::Admin` | `set_fee_bps`, `set_fee_collector`, `propose_new_fee_collector`, `set_admin`, `propose_new_admin`, `upgrade`, `pause`, `unpause`, `add_asset`, `remove_asset`, `add_to_blocklist`, `set_daily_limit`, etc. |
| `fee_collector` | `DataKey::FeeCollector` | `withdraw_fees` only |

- Both roles are set at `initialize` time and can be rotated by their respective current holder (`set_admin` requires admin auth; `set_fee_collector` requires admin auth too, to prevent a compromised fee collector from locking the admin out).
- Neither role can act as the other: `withdraw_fees` checks `fee_collector.require_auth()` and rejects the admin; all config functions check `admin.require_auth()`.

### Superseding role rotation pattern

The contract now supports a safer two-step handoff for both privileged roles:

- Admin rotation: `propose_new_admin(new_admin, nonce)` stores `DataKey::PendingAdmin`, and `accept_admin()` must be authorized by the pending admin before the stored admin is changed.
- Fee-collector rotation: `propose_new_fee_collector(new_collector, nonce)` stores `DataKey::PendingFeeCollector`, and `accept_fee_collector()` must be authorized by the pending collector before the stored fee collector is changed.
- `query_pending_admin()` and `query_pending_fee_collector()` expose pending handoffs for operators and monitoring.

This propose/accept pattern supersedes the original single-call `set_admin` and `set_fee_collector` rotation path for normal operations. It proves the recipient controls the destination key before the role is moved, reduces the chance of transferring control to an unusable address, and creates an observable pending state before the final handoff. The single-call setters remain available for backwards compatibility and emergency operational recovery, but production runbooks should prefer propose/accept.

## Consequences

**Positive:**
- Compromising the fee collector key cannot alter contract configuration.
- Compromising the admin key cannot directly drain fees (it can rotate the fee collector, but that's a detectable on-chain action).
- Auditors can clearly distinguish operational access from financial access.
- Principle of least privilege: hot wallets used for fee collection don't need admin powers.
- Two-step handoff verifies the recipient can authorize before role control moves.

**Negative:**
- Two keypairs to manage instead of one.
- Two-step handoff requires coordination from both the current admin and the proposed recipient.
