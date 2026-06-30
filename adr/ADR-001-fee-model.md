# ADR-001: Fee Model and Basis Points Calculation

**Status:** Accepted  
**Date:** 2024-01-15

## Context

The bridge contract needs to charge a fee on each transfer to sustain protocol operations. Two common approaches exist:

1. Fixed flat fee per transaction.
2. Percentage fee expressed in basis points (bps), where 1 bps = 0.01%.

The protocol serves a wide range of transfer sizes, from micro-payments to large institutional transfers. A flat fee would be regressive (punishing small transfers) while being trivially small for large ones.

## Decision

Use a **basis-points fee model** with the following properties:

- Fee is stored as `fee_bps: u32` in contract state.
- Max allowed: **1 000 bps (10%)**, enforced at `set_fee_bps` and `initialize` time.
- Calculation: `fee = amount × fee_bps / 10_000` using integer arithmetic (floors to nearest stroop).
- Per-asset fee caps: individual assets can have a tighter cap via `set_asset_fee_cap`, making `effective_bps = min(global_bps, cap)`.
- Tiered fees: high-volume sources can receive a reduced rate stored per-source-address.
- Fee-exempt addresses: specific addresses can be marked exempt via `add_fee_exempt`.
- Fees accumulate in the contract under `DataKey::AccruedFees(asset)` and are claimed by the fee collector via `withdraw_fees`.

## Consequences

**Positive:**
- Proportional — small transfers pay small fees, large transfers pay proportionally.
- Integer arithmetic avoids floating point precision issues.
- Per-asset caps give flexibility for low-margin tokens.
- Tiered fees enable volume discounts for partners.

**Negative:**
- Very small amounts (< 10 000 stroops) may round fee to zero even with non-zero bps. This is acceptable — the transfer still succeeds.
- Fee changes take effect immediately on the next transaction, not at end-of-epoch. Callers should monitor for fee changes.
