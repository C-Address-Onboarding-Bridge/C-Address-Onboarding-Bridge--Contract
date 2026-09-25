# `batch_fund_c_address` implementation

## What was implemented

`batch_fund_c_address` in `contracts/onboarding-bridge/src/lib.rs` previously
had a `todo!()` body. It now implements the full documented flow:

1. **Guards, in the documented error order**: reentrancy guard, initialized,
   not-paused, `targets.len() > MAX_BATCH_SIZE` → `BatchTooLarge`, past
   `deadline` → `TransactionExpired`, `targets.len() != amounts.len()` →
   `MismatchedArrays`, then `AssetNotWhitelisted` via the existing
   `check_asset_whitelisted` helper.
2. **Pre-transfer validation**: a loop over `amounts` rejects any element that
   is `<= 0` or below the configured minimum transfer amount
   (`InvalidAmount`) *before* any tokens move, matching the "Security
   Considerations" note in the doc comment. The loop also accumulates the
   batch total.
3. **Daily limit check** against the aggregate batch total via the existing
   `check_daily_limit` helper, then `source.require_auth()` and the optional
   nonce is consumed via `consume_nonce`.
4. **Single upfront pull**: `sum(amounts)` is transferred from `source` to the
   contract in one `token_client.transfer` call.
5. **Aggregation**: amounts for duplicate targets are summed into a
   `Map<Address, i128>` first, so each unique target receives at most one
   outbound transfer and one `CAddressFunded`/`BatchTransferFailed` event,
   per the "aggregated into a single token transfer" requirement in the doc.
6. **Per-target processing**: blocked/non-allowlisted targets (checked via the
   existing `check_access` helper) are skipped — their amount is accumulated
   into a refund total and a `BatchTransferFailed` event is emitted with
   `(amount, "access_denied")`. Allowed targets have the fee deducted (via the
   existing `calculate_fee`, using the effective fee rate from
   `get_tiered_fee_bps` + `get_effective_fee_bps`, same resolution order used
   elsewhere in the contract), receive the net transfer, and emit
   `CAddressFunded`.
7. **End of batch**: any refund total is transferred back to `source` in one
   call, `source`'s bridged volume is incremented once, instance TTL is
   extended, loyalty tokens are minted once to `source` (matching the
   existing comment stating batch funding mints "once per call, not per
   recipient"), and a single `BatchCompleted` event reports
   `(num_success, num_failures)`.

No new storage keys were introduced. All per-asset counters, daily-limit,
fee-tier, fee-cap, and loyalty helpers already existed in the file (used by
other funding paths such as `reveal_fund`) and are reused here.

## Verification

`cargo check -p onboarding-bridge` passes with no new errors. As noted in the
issue, the crate's test target does not currently compile for unrelated,
pre-existing reasons, so `cargo test` could not be run.
