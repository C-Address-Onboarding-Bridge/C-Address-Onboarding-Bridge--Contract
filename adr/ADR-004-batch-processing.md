# ADR-004: Batch Processing Design — Atomic vs. Partial Success

**Status:** Accepted  
**Date:** 2024-01-15

## Context

`batch_fund_c_address` transfers tokens to multiple C-addresses in one transaction. Two failure models were considered:

1. **Atomic (all-or-nothing):** if any single transfer fails (blocked target, non-allowlisted address, invalid amount), the entire batch reverts.
2. **Partial success:** individual transfers that fail are skipped; the batch continues and refunds failed amounts to the source.

Use cases include CEX batch payouts (where a single blocked address shouldn't cancel payouts to hundreds of others) and airdrop distributions.

## Decision

Use **partial success** with a refund mechanism:

- The contract pulls the full `sum(amounts)` from source upfront in a single token transfer.
- For each `(target, amount)` pair:
  - If `check_access` or amount validation fails → add amount to `refund_total`; emit `BatchTransferFailed(target, reason)`.
  - Otherwise → transfer net amount to target; accumulate fee.
- After the loop, transfer `refund_total` back to source in one transfer.
- Emit `BatchCompleted(success_count, fail_count, total_refunded)`.
- Targets that succeed within the same batch are **aggregated** (same address deduped into one transfer) to reduce instruction cost.

The asset whitelist check (`check_asset_whitelisted`) **is** atomic — if the asset is not whitelisted the entire batch reverts immediately, since this is a configuration error rather than a per-target access issue.

## Consequences

**Positive:**
- Batch payouts are resilient to individual blocked or invalid addresses.
- Source doesn't need to pre-filter the list; the contract handles it.
- Single token pull and single refund minimise the number of token operations.

**Negative:**
- Source must trust the contract to refund correctly; a bug in refund accounting could strand funds. Mitigated by the `reclaimTokens` admin escape hatch.
- Gas cost is proportional to batch size regardless of how many succeed.
- Partial success means callers must parse `BatchTransferFailed` events to know which targets were skipped.
