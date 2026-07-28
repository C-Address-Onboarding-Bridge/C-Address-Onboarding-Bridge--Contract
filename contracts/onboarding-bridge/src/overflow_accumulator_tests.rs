//! Property and edge-case coverage for the storage accumulators that were
//! switched from raw `+=` to `safe_math::safe_add` (see lib.rs `increment_*`
//! / `update_asset_counters` / `check_daily_limit`). Each of these functions
//! must return `BridgeError::Overflow` instead of panicking/wrapping when the
//! running total would exceed `i128::MAX`.

#![cfg(test)]

use crate::{
    check_daily_limit, increment_accrued_fees, increment_source_bridged_volume,
    increment_total_bridged, increment_total_fees_collected, increment_user_deposit,
    save_source_daily_limit, update_asset_counters, BridgeError, OnboardingBridge,
};
use proptest::prelude::*;
use soroban_sdk::{testutils::Address as _, Address, Env};

fn setup() -> (Env, Address, Address, Address) {
    let env = Env::default();
    let bridge_id = env.register(OnboardingBridge, ());
    let asset = Address::generate(&env);
    let source = Address::generate(&env);
    (env, bridge_id, asset, source)
}

#[test]
fn accrued_fees_overflow_returns_error_not_panic() {
    let (env, bridge_id, asset, _source) = setup();
    env.as_contract(&bridge_id, || {
        increment_accrued_fees(&env, &asset, i128::MAX).unwrap();
        assert_eq!(
            increment_accrued_fees(&env, &asset, 1),
            Err(BridgeError::Overflow)
        );
    });
}

#[test]
fn total_bridged_overflow_returns_error_not_panic() {
    let (env, bridge_id, asset, _source) = setup();
    env.as_contract(&bridge_id, || {
        increment_total_bridged(&env, &asset, i128::MAX).unwrap();
        assert_eq!(
            increment_total_bridged(&env, &asset, 1),
            Err(BridgeError::Overflow)
        );
    });
}

#[test]
fn total_fees_collected_overflow_returns_error_not_panic() {
    let (env, bridge_id, asset, _source) = setup();
    env.as_contract(&bridge_id, || {
        increment_total_fees_collected(&env, &asset, i128::MAX).unwrap();
        assert_eq!(
            increment_total_fees_collected(&env, &asset, 1),
            Err(BridgeError::Overflow)
        );
    });
}

#[test]
fn update_asset_counters_overflow_returns_error_not_panic() {
    let (env, bridge_id, asset, _source) = setup();
    env.as_contract(&bridge_id, || {
        update_asset_counters(&env, &asset, i128::MAX, i128::MAX).unwrap();
        assert_eq!(
            update_asset_counters(&env, &asset, 1, 0),
            Err(BridgeError::Overflow)
        );
        assert_eq!(
            update_asset_counters(&env, &asset, 0, 1),
            Err(BridgeError::Overflow)
        );
    });
}

#[test]
fn source_bridged_volume_overflow_returns_error_not_panic() {
    let (env, bridge_id, _asset, source) = setup();
    env.as_contract(&bridge_id, || {
        increment_source_bridged_volume(&env, &source, i128::MAX).unwrap();
        assert_eq!(
            increment_source_bridged_volume(&env, &source, 1),
            Err(BridgeError::Overflow)
        );
    });
}

#[test]
fn user_deposit_overflow_returns_error_not_panic() {
    let (env, bridge_id, asset, source) = setup();
    env.as_contract(&bridge_id, || {
        increment_user_deposit(&env, &source, &asset, i128::MAX).unwrap();
        assert_eq!(
            increment_user_deposit(&env, &source, &asset, 1),
            Err(BridgeError::Overflow)
        );
    });
}

#[test]
fn daily_limit_usage_overflow_returns_error_not_panic() {
    let (env, bridge_id, asset, source) = setup();
    env.as_contract(&bridge_id, || {
        // A high limit so the overflow check (not the limit check) is what fires.
        save_source_daily_limit(&env, &source, &asset, i128::MAX);
        check_daily_limit(&env, &source, &asset, i128::MAX).unwrap();
        assert_eq!(
            check_daily_limit(&env, &source, &asset, 1),
            Err(BridgeError::Overflow)
        );
    });
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, .. ProptestConfig::default() })]

    /// Every `increment_*` accumulator must agree with `checked_add` on
    /// whether a given (base, delta) pair overflows i128, regardless of how
    /// close `base` sits to `i128::MAX`.
    #[test]
    fn accrued_fees_matches_checked_add_near_i128_max(
        base in (i128::MAX - 1_000_000)..=i128::MAX,
        delta in 0i128..=2_000_000i128,
    ) {
        let (env, bridge_id, asset, _source) = setup();
        env.as_contract(&bridge_id, || {
            increment_accrued_fees(&env, &asset, base).unwrap();
            let result = increment_accrued_fees(&env, &asset, delta);
            let expected_overflow = base.checked_add(delta).is_none();
            prop_assert_eq!(result.is_err(), expected_overflow);
            if let Err(e) = result {
                prop_assert_eq!(e, BridgeError::Overflow);
            }
            Ok(())
        })?;
    }
}
