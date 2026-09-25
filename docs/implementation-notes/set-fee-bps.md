# `set_fee_bps` implementation

## What was implemented

`set_fee_bps` in `contracts/onboarding-bridge/src/lib.rs` previously had a
`todo!()` body. It now:

1. Confirms the contract is initialized (`BridgeError::NotInitialized`).
2. Rejects mutating calls while the contract is paused
   (`BridgeError::ContractPaused`), via the existing `check_not_paused` helper.
3. Rejects `new_fee_bps` values above `MAX_FEE_BPS` (1 000) with
   `BridgeError::FeeTooHigh`.
4. Requires the current admin's authorization via `require_auth()`.
5. Consumes the optional sequential admin nonce via the existing
   `consume_nonce` helper, returning `BridgeError::DuplicateNonce` on mismatch.
6. Reads the previous rate, persists the new rate via the existing
   `save_fee_bps` helper, and extends instance TTL.
7. Emits the documented `("FeeBpsChanged", old_fee_bps, new_fee_bps)` event
   with `(admin,)` as the event data, matching the doc comment exactly.

No new storage keys or helpers were introduced — `read_fee_bps` and
`save_fee_bps` already existed and back `query_fee_bps` and every funding
path's fee calculation.

## Verification

`cargo check -p onboarding-bridge` passes with no new errors. As noted in the
issue, the crate's test target does not currently compile for unrelated,
pre-existing reasons, so `cargo test` could not be run.
