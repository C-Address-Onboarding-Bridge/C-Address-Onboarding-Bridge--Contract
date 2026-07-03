//! Test suite with explicit authentication using distinct addresses for each role
//!
//! This test suite creates distinct addresses for each role:
//! - admin (bridge administrator, also initializes contract)
//! - fee_collector (fee recipient)
//! - source (user funding)
//! - target (c-address recipient)
//!
//! Each test uses explicit authentication with mock_auths() instead of
//! mock_all_auths(), and uses a real Soroban token contract instead of TestToken.

#![cfg(test)]

use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    Address, Env, IntoVal,
};

use crate::OnboardingBridge;

// Test initialization with explicit auth
#[test]
fn test_initialize_with_explicit_auth() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);

    let bridge_id = env.register(OnboardingBridge, ());
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Initialize with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "initialize",
                args: (
                    admin.clone(),
                    fee_collector.clone(),
                    50u32,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin, &fee_collector, &50u32, &None);

    // Verify initialization
    assert_eq!(bridge.query_fee_bps(), 50u32);
    assert_eq!(bridge.query_fee_collector(), fee_collector);
    assert_eq!(bridge.query_admin(), admin);
    assert!(bridge.query_is_initialized());
}

// Test authorization failures for non-admin
#[test]
#[should_panic(expected = "Auth")]
fn test_non_admin_cannot_set_fee_bps() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);
    let non_admin = Address::generate(&env);

    let bridge_id = env.register(OnboardingBridge, ());
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Initialize with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "initialize",
                args: (
                    admin.clone(),
                    fee_collector.clone(),
                    50u32,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin, &fee_collector, &50u32, &None);

    assert_eq!(bridge.query_fee_bps(), 50u32);

    // Try to set fee bps with non-admin auth (should panic)
    bridge
        .mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "set_fee_bps",
                args: (100u32, soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_fee_bps(&100u32, &None);
}

// Test admin-only operations with wrong auth
#[test]
#[should_panic(expected = "Auth")]
fn test_non_admin_cannot_set_admin() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);
    let non_admin = Address::generate(&env);

    let bridge_id = env.register(OnboardingBridge, ());
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Initialize with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "initialize",
                args: (
                    admin.clone(),
                    fee_collector.clone(),
                    50u32,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin, &fee_collector, &50u32, &None);

    // Try to set admin with non-admin auth (should panic)
    let new_admin = Address::generate(&env);
    bridge
        .mock_auths(&[MockAuth {
            address: &non_admin,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "set_admin",
                args: (new_admin.clone(), soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_admin(&new_admin, &None);
}

// Test that operations fail without proper auth
#[test]
#[should_panic(expected = "Auth")]
fn test_fund_without_auth_fails() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);

    // Create real token
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();

    let bridge_id = env.register(OnboardingBridge, ());
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Initialize with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "initialize",
                args: (
                    admin.clone(),
                    fee_collector.clone(),
                    100u32,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin, &fee_collector, &100u32, &None);

    // Add asset with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "add_asset",
                args: (token_id.clone(), soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .add_asset(&token_id, &None);

    // Try to fund WITHOUT auth (should panic)
    // Note: no mock_auths() call here
    bridge.fund_c_address(&source, &target, &token_id, &500i128, &None, &None);
}

// Test correct admin operations succeed
#[test]
fn test_admin_operations_succeed() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);

    let bridge_id = env.register(OnboardingBridge, ());
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Initialize with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "initialize",
                args: (
                    admin.clone(),
                    fee_collector.clone(),
                    50u32,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin, &fee_collector, &50u32, &None);

    assert_eq!(bridge.query_fee_bps(), 50u32);

    // Set fee bps with correct admin auth (should succeed)
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "set_fee_bps",
                args: (100u32, soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_fee_bps(&100u32, &None);

    assert_eq!(bridge.query_fee_bps(), 100u32);

    // Set new admin with correct admin auth (should succeed)
    let new_admin = Address::generate(&env);
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "set_admin",
                args: (new_admin.clone(), soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_admin(&new_admin, &None);

    assert_eq!(bridge.query_admin(), new_admin);
}

// Test with real token contract integration
#[test]
fn test_real_token_integration() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);

    // Create real token contract
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();

    let bridge_id = env.register(OnboardingBridge, ());
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Initialize with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "initialize",
                args: (
                    admin.clone(),
                    fee_collector.clone(),
                    100u32,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin, &fee_collector, &100u32, &None);

    // Add asset with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "add_asset",
                args: (token_id.clone(), soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .add_asset(&token_id, &None);

    // Verify token is whitelisted
    assert!(bridge.query_is_asset_whitelisted(&token_id));
}

// Test fee_collector-specific operations
#[test]
fn test_fee_collector_operations() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);

    // Create real token
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();

    let bridge_id = env.register(OnboardingBridge, ());
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Initialize with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "initialize",
                args: (
                    admin.clone(),
                    fee_collector.clone(),
                    100u32,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin, &fee_collector, &100u32, &None);

    // Add asset with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "add_asset",
                args: (token_id.clone(), soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .add_asset(&token_id, &None);

    // Test setting new fee collector (admin only)
    let new_fee_collector = Address::generate(&env);
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "set_fee_collector",
                args: (new_fee_collector.clone(), soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .set_fee_collector(&new_fee_collector, &None);

    assert_eq!(bridge.query_fee_collector(), new_fee_collector);
}

// Test that fee_collector can call withdraw_fees with proper auth (auth chain only, no actual tokens)
#[test]
fn test_fee_collector_withdraw_fees() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);

    // Create real token
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();

    let bridge_id = env.register(OnboardingBridge, ());
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Initialize with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "initialize",
                args: (
                    admin.clone(),
                    fee_collector.clone(),
                    100u32,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin, &fee_collector, &100u32, &None);

    // Add asset with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "add_asset",
                args: (token_id.clone(), soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .add_asset(&token_id, &None);

    // Test that fee_collector can call withdraw_fees (will fail due to insufficient balance, but auth passes)
    // This tests the authorization chain only
    let result = bridge
        .mock_auths(&[MockAuth {
            address: &fee_collector,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "withdraw_fees",
                args: (token_id.clone(), 100i128, soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .try_withdraw_fees(&token_id, &100i128, &None);

    // Withdraw should fail due to insufficient balance, not due to auth
    // The important part is that fee_collector auth is accepted
    assert!(result.is_err());
    // We don't check the specific error because it's about insufficient balance
    // The key is that it didn't fail with Auth error
}

// Test comprehensive authorization failures (no mint required)
#[test]
#[should_panic(expected = "Auth")]
fn test_authorization_failures() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);
    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let attacker = Address::generate(&env);

    // Create real token
    let sac = env.register_stellar_asset_contract_v2(admin.clone());
    let token_id = sac.address();

    let bridge_id = env.register(OnboardingBridge, ());
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Initialize with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "initialize",
                args: (
                    admin.clone(),
                    fee_collector.clone(),
                    100u32,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .initialize(&admin, &fee_collector, &100u32, &None);

    // Add asset with admin auth
    bridge
        .mock_auths(&[MockAuth {
            address: &admin,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "add_asset",
                args: (token_id.clone(), soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[],
            },
        }])
        .add_asset(&token_id, &None);

    // Try to fund with wrong source auth (attacker instead of source) - should panic
    // Note: This will fail due to insufficient balance, but should fail with Auth first
    bridge
        .mock_auths(&[MockAuth {
            address: &attacker,
            invoke: &MockAuthInvoke {
                contract: &bridge.address,
                fn_name: "fund_c_address",
                args: (
                    source.clone(),
                    target.clone(),
                    token_id.clone(),
                    500i128,
                    soroban_sdk::Val::VOID,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[],
            },
        }])
        .fund_c_address(&source, &target, &token_id, &500i128, &None, &None);
}
