# `set_asset_fee_cap` implementation

## What was implemented

`set_asset_fee_cap` in `contracts/onboarding-bridge/src/lib.rs` previously had a
`todo!()` body. It now:

1. Confirms the contract is initialized (`BridgeError::NotInitialized`).
2. Rejects `max_fee_bps` values above `MAX_FEE_BPS` (1 000) with
   `BridgeError::FeeTooHigh`.
3. Requires the current admin's authorization via `require_auth()`.
4. Consumes the optional sequential admin nonce via the existing
   `consume_nonce` helper, returning `BridgeError::DuplicateNonce` on mismatch.
5. Persists the cap with the pre-existing `save_asset_fee_cap` storage helper
   (already used by `get_effective_fee_bps` to compute `min(global_fee_bps, cap)`).
6. Extends instance TTL via the existing `extend_instance_ttl` helper, matching
   every other mutating admin setter in the contract.

No new storage keys, helpers, or public signatures were introduced — the
function only wires together helpers that already existed for this exact
purpose (`save_asset_fee_cap`, `read_asset_fee_cap`, `get_effective_fee_bps`).

## Verification

`cargo check -p onboarding-bridge` passes with no new errors. The crate's test
target does not currently compile for unrelated, pre-existing reasons (see the
open issues covering the seeded test-target breakage), so `cargo test` could
not be run as part of this change, per the issue's own note.
