use crate::{calculate_fee, BridgeError, FEE_DENOMINATOR, MAX_FEE_BPS};
use proptest::prelude::*;

fn max_safe_amount() -> i128 {
    i128::MAX / MAX_FEE_BPS as i128
}

fn reference_fee(amount: i128, fee_bps: u32) -> Option<i128> {
    amount
        .checked_mul(fee_bps as i128)
        .map(|product| product / FEE_DENOMINATOR)
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 512, .. ProptestConfig::default() })]

    #[test]
    fn fee_invariants_hold_for_valid_amounts(
        amount in 0i128..=max_safe_amount(),
        fee_bps in 0u32..=MAX_FEE_BPS,
    ) {
        let fee_result = calculate_fee(amount, fee_bps);
        prop_assert!(
            fee_result.is_ok(),
            "calculate_fee failed for amount={amount}, fee_bps={fee_bps}: {fee_result:?}"
        );
        let fee = fee_result.unwrap();
        let net = amount - fee;

        prop_assert!(fee <= amount);
        prop_assert_eq!(fee + net, amount);

        if fee_bps == 0 {
            prop_assert_eq!(fee, 0);
        }

        let max_fee = amount * MAX_FEE_BPS as i128 / FEE_DENOMINATOR;
        prop_assert!(fee <= max_fee);
        prop_assert_eq!(fee, reference_fee(amount, fee_bps).unwrap());
    }

    #[test]
    fn fee_is_monotonic_in_amount(
        lower in 0i128..=max_safe_amount(),
        delta in 0i128..=1_000_000_000_000i128,
        fee_bps in 0u32..=MAX_FEE_BPS,
    ) {
        let upper = lower.saturating_add(delta).min(max_safe_amount());
        let lower_fee = calculate_fee(lower, fee_bps).unwrap();
        let upper_fee = calculate_fee(upper, fee_bps).unwrap();

        prop_assert!(lower_fee <= upper_fee);
    }

    #[test]
    fn fee_is_monotonic_in_fee_bps(
        amount in 0i128..=max_safe_amount(),
        lower_bps in 0u32..=MAX_FEE_BPS,
        upper_bps in 0u32..=MAX_FEE_BPS,
    ) {
        let low = lower_bps.min(upper_bps);
        let high = lower_bps.max(upper_bps);
        let lower_fee = calculate_fee(amount, low).unwrap();
        let upper_fee = calculate_fee(amount, high).unwrap();

        prop_assert!(lower_fee <= upper_fee);
    }
}

#[test]
fn fee_edge_case_matrix_matches_reference_or_overflows() {
    let amounts = [
        0,
        1,
        max_safe_amount() - 1,
        max_safe_amount(),
        i128::MAX / 2,
        i128::MAX / MAX_FEE_BPS as i128,
    ];
    let fee_bps_values = [0, 1, MAX_FEE_BPS - 1, MAX_FEE_BPS];

    for amount in amounts {
        for fee_bps in fee_bps_values {
            match reference_fee(amount, fee_bps) {
                Some(expected) => assert_eq!(calculate_fee(amount, fee_bps), Ok(expected)),
                None => assert_eq!(calculate_fee(amount, fee_bps), Err(BridgeError::Overflow)),
            }
        }
    }
}

#[test]
fn fee_overflow_boundary_returns_error() {
    assert_eq!(
        calculate_fee(i128::MAX, MAX_FEE_BPS),
        Err(BridgeError::Overflow)
    );
}
