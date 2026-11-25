# `set_source_daily_limit` implementation

## What was implemented

`set_source_daily_limit` in `contracts/onboarding-bridge/src/lib.rs` previously
had a `todo!()` body. It now:

1. Confirms the contract is initialized (`BridgeError::NotInitialized`).
2. Requires the current admin's authorization via `require_auth()`.
3. Consumes the optional sequential admin nonce via the existing
   `consume_nonce` helper, returning `BridgeError::DuplicateNonce` on mismatch.
4. Persists the per-`(source, asset)` limit with the pre-existing
   `save_source_daily_limit` storage helper. Passing `0` disables the limit,
   which matches `check_daily_limit`'s existing "0 means unlimited" behaviour
   used by `fund_c_address`.
5. Extends instance TTL via the existing `extend_instance_ttl` helper.

No new storage keys or helpers were introduced — the daily-limit storage and
enforcement helpers (`save_source_daily_limit`, `read_source_daily_limit`,
`check_daily_limit`) already existed; this function was simply the missing
admin-facing setter that wires into them.

## Rolling window semantics

`check_daily_limit` no longer uses a fixed UTC calendar-day bucket. Usage is
recorded in hourly buckets (`DataKey::DailyUsage(source, asset, bucket)` where
`bucket = timestamp / 3_600`) and a call is measured against the current bucket
plus the 23 preceding ones, i.e. a rolling 24-hour window. At most 24 bucket
reads per call, so the per-call cost stays bounded; buckets older than the
window are never read again and expire with their TTL.

Usage is recorded even when no limit is configured (`limit == 0`), so a limit
set mid-window immediately counts volume already bridged in the trailing 24
hours. This costs one extra persistent write per funding call and is covered by
`test_daily_limit_set_after_funding_counts_earlier_usage`.

## Verification

`cargo check -p onboarding-bridge` passes with no new errors. As noted in the
issue, the crate's test target does not currently compile for unrelated,
pre-existing reasons, so `cargo test` could not be run.
