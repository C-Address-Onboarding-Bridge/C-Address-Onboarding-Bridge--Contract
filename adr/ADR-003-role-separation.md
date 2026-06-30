# ADR-003: Admin and Fee Collector Role Separation

**Status:** Accepted  
**Date:** 2024-01-15

## Context

Smart contracts commonly use a single "owner" address for all privileged operations. Combining configuration control and fund withdrawal into one keypair creates a large blast radius: compromise of the owner key grants both config manipulation and the ability to drain fees.

## Decision

Split privileges into **two distinct roles**:

| Role | Key stored | Can do |
|---|---|---|
| `admin` | `DataKey::Admin` | `set_fee_bps`, `set_fee_collector`, `set_admin`, `upgrade`, `pause`, `unpause`, `add_asset`, `remove_asset`, `add_to_blocklist`, `set_daily_limit`, etc. |
| `fee_collector` | `DataKey::FeeCollector` | `withdraw_fees` only |

- Both roles are set at `initialize` time and can be rotated by their respective current holder (`set_admin` requires admin auth; `set_fee_collector` requires admin auth too, to prevent a compromised fee collector from locking the admin out).
- Neither role can act as the other: `withdraw_fees` checks `fee_collector.require_auth()` and rejects the admin; all config functions check `admin.require_auth()`.

## Consequences

**Positive:**
- Compromising the fee collector key cannot alter contract configuration.
- Compromising the admin key cannot directly drain fees (it can rotate the fee collector, but that's a detectable on-chain action).
- Auditors can clearly distinguish operational access from financial access.
- Principle of least privilege: hot wallets used for fee collection don't need admin powers.

**Negative:**
- Two keypairs to manage instead of one.
- `set_fee_collector` requires admin auth, so rotating the fee collector after an admin key rotation must be done atomically to avoid a gap.
