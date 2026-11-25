//! Integration tests using real Soroban SAC token contracts.
//!
//! Setup (initialize, add_asset, mint) uses mock_all_auths for brevity.
//! The core fund/withdraw calls under test use scoped mock_auths so that
//! each require_auth is matched against a specific invocation, proving
//! that the auth chain is correct and token balance changes are real.
//!
//! Balance assertions always use the real token contract's balance() function.

#![cfg(test)]

use crate::OnboardingBridge;

use soroban_sdk::{
    testutils::{Address as _, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal,
};

// ── Setup helper ───────────────────────────────────────────────────────────────

struct Setup {
    env: Env,
    bridge_id: Address,
    token_id: Address,
    #[allow(dead_code)]
    admin: Address,
    fee_collector: Address,
}

impl Setup {
    fn new() -> Self {
        let env = Env::default();
        let admin = Address::generate(&env);
        let fee_collector = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = sac.address();
        let bridge_id = env.register(OnboardingBridge, ());

        // Setup calls: use mock_all_auths — these are not under test.
        let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
        bridge
            .mock_all_auths()
            .initialize(&admin, &fee_collector, &100u32, &None);
        bridge.mock_all_auths().add_asset(&token_id, &None);

        Self {
            env,
            bridge_id,
            token_id,
            admin,
            fee_collector,
        }
    }

    fn bridge(&self) -> crate::OnboardingBridgeClient<'_> {
        crate::OnboardingBridgeClient::new(&self.env, &self.bridge_id)
    }

    fn token(&self) -> TokenClient<'_> {
        TokenClient::new(&self.env, &self.token_id)
    }

    fn sac(&self) -> StellarAssetClient<'_> {
        StellarAssetClient::new(&self.env, &self.token_id)
    }

    fn balance(&self, addr: &Address) -> i128 {
        self.token().balance(addr)
    }

    /// Mint via SAC admin — infrastructure, not under test.
    fn mint(&self, to: &Address, amount: i128) {
        self.sac().mock_all_auths().mint(to, &amount);
    }
}

// ── Test 1: token transfer from user → bridge, then bridge → C-address ────────

#[test]
fn integration_fund_transfers_tokens_to_target() {
    let s = Setup::new();
    let user = Address::generate(&s.env);
    let target = Address::generate(&s.env);

    s.mint(&user, 10_000);
    assert_eq!(s.balance(&user), 10_000);
    assert_eq!(s.balance(&target), 0);
    assert_eq!(s.balance(&s.bridge_id), 0);

    // fund_c_address under test — scoped mock_auth for user only.
    // The token.transfer sub-invocation is authorised by the contract itself
    // (it is the caller of transfer), so only the top-level user auth is needed.
    s.bridge()
        .mock_auths(&[MockAuth {
            address: &user,
            invoke: &MockAuthInvoke {
                contract: &s.bridge_id,
                fn_name: "fund_c_address",
                args: (
                    user.clone(),
                    target.clone(),
                    s.token_id.clone(),
                    10_000i128,
                    soroban_sdk::Val::VOID,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&s.env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &s.token_id,
                    fn_name: "transfer",
                    args: (user.clone(), s.bridge_id.clone(), 10_000i128).into_val(&s.env),
                    sub_invokes: &[],
                }],
            },
        }])
        .fund_c_address(&user, &target, &s.token_id, &10_000, &None, &None);

    // fee_bps=100 → 1% → fee=100; net=9_900
    assert_eq!(s.balance(&user), 0, "user balance after fund");
    assert_eq!(s.balance(&target), 9_900, "target receives net amount");
    assert_eq!(s.balance(&s.bridge_id), 100, "bridge holds the fee");
}

// ── Test 2: fee accumulation across multiple fund calls ────────────────────────

#[test]
fn integration_fee_accumulates_in_bridge() {
    let s = Setup::new();
    let user = Address::generate(&s.env);

    s.mint(&user, 30_000);

    // Three separate fund calls — each accumulates its own fee.
    for _ in 0..3 {
        let target = Address::generate(&s.env);
        s.bridge()
            .mock_auths(&[MockAuth {
                address: &user,
                invoke: &MockAuthInvoke {
                    contract: &s.bridge_id,
                    fn_name: "fund_c_address",
                    args: (
                        user.clone(),
                        target.clone(),
                        s.token_id.clone(),
                        10_000i128,
                        soroban_sdk::Val::VOID,
                        soroban_sdk::Val::VOID,
                    )
                        .into_val(&s.env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &s.token_id,
                        fn_name: "transfer",
                        args: (user.clone(), s.bridge_id.clone(), 10_000i128).into_val(&s.env),
                        sub_invokes: &[],
                    }],
                },
            }])
            .fund_c_address(&user, &target, &s.token_id, &10_000, &None, &None);
    }

    // 3 × 100 fee = 300 accumulated in bridge
    assert_eq!(s.balance(&s.bridge_id), 300);
    // query_fee_balance uses the real token.balance() under the hood
    assert_eq!(s.bridge().query_fee_balance(&s.token_id), 300);
}

// ── Test 3: fee withdrawal from bridge to fee_collector ───────────────────────

#[test]
fn integration_withdraw_fees_to_fee_collector() {
    let s = Setup::new();
    let user = Address::generate(&s.env);
    let target = Address::generate(&s.env);

    s.mint(&user, 10_000);

    // Fund to accumulate 100 in fees.
    s.bridge()
        .mock_auths(&[MockAuth {
            address: &user,
            invoke: &MockAuthInvoke {
                contract: &s.bridge_id,
                fn_name: "fund_c_address",
                args: (
                    user.clone(),
                    target.clone(),
                    s.token_id.clone(),
                    10_000i128,
                    soroban_sdk::Val::VOID,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&s.env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &s.token_id,
                    fn_name: "transfer",
                    args: (user.clone(), s.bridge_id.clone(), 10_000i128).into_val(&s.env),
                    sub_invokes: &[],
                }],
            },
        }])
        .fund_c_address(&user, &target, &s.token_id, &10_000, &None, &None);

    assert_eq!(s.balance(&s.fee_collector), 0);
    assert_eq!(s.balance(&s.bridge_id), 100);

    // withdraw_fees — scoped to fee_collector.
    s.bridge()
        .mock_auths(&[MockAuth {
            address: &s.fee_collector,
            invoke: &MockAuthInvoke {
                contract: &s.bridge_id,
                fn_name: "withdraw_fees",
                args: (s.token_id.clone(), 100i128, soroban_sdk::Val::VOID).into_val(&s.env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &s.token_id,
                    fn_name: "transfer",
                    args: (s.bridge_id.clone(), s.fee_collector.clone(), 100i128).into_val(&s.env),
                    sub_invokes: &[],
                }],
            },
        }])
        .withdraw_fees(&s.token_id, &100, &None);

    assert_eq!(
        s.balance(&s.fee_collector),
        100,
        "fee_collector received fees"
    );
    assert_eq!(s.balance(&s.bridge_id), 0, "bridge drained to zero");
}

// ── Test 4: multiple tokens accumulate and withdraw independently ─────────────

#[test]
fn integration_multiple_tokens_simultaneously() {
    let env = Env::default();

    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);

    let sac_a = env.register_stellar_asset_contract_v2(admin.clone());
    let sac_b = env.register_stellar_asset_contract_v2(admin.clone());
    let token_a = sac_a.address();
    let token_b = sac_b.address();

    let bridge_id = env.register(OnboardingBridge, ());
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Setup (not under test).
    bridge
        .mock_all_auths()
        .initialize(&admin, &fee_collector, &100u32, &None);
    bridge.mock_all_auths().add_asset(&token_a, &None);
    bridge.mock_all_auths().add_asset(&token_b, &None);

    let user = Address::generate(&env);
    StellarAssetClient::new(&env, &token_a)
        .mock_all_auths()
        .mint(&user, &5_000);
    StellarAssetClient::new(&env, &token_b)
        .mock_all_auths()
        .mint(&user, &8_000);

    let target_a = Address::generate(&env);
    let target_b = Address::generate(&env);

    // Fund with token A — scoped auth.
    bridge
        .mock_auths(&[MockAuth {
            address: &user,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "fund_c_address",
                args: (
                    user.clone(),
                    target_a.clone(),
                    token_a.clone(),
                    5_000i128,
                    soroban_sdk::Val::VOID,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &token_a,
                    fn_name: "transfer",
                    args: (user.clone(), bridge_id.clone(), 5_000i128).into_val(&env),
                    sub_invokes: &[],
                }],
            },
        }])
        .fund_c_address(&user, &target_a, &token_a, &5_000, &None, &None);

    // Fund with token B — scoped auth.
    bridge
        .mock_auths(&[MockAuth {
            address: &user,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "fund_c_address",
                args: (
                    user.clone(),
                    target_b.clone(),
                    token_b.clone(),
                    8_000i128,
                    soroban_sdk::Val::VOID,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &token_b,
                    fn_name: "transfer",
                    args: (user.clone(), bridge_id.clone(), 8_000i128).into_val(&env),
                    sub_invokes: &[],
                }],
            },
        }])
        .fund_c_address(&user, &target_b, &token_b, &8_000, &None, &None);

    let tc_a = TokenClient::new(&env, &token_a);
    let tc_b = TokenClient::new(&env, &token_b);

    // fee_bps=100 → 1%: 5_000×1%=50, 8_000×1%=80
    assert_eq!(tc_a.balance(&target_a), 4_950, "token A net to target");
    assert_eq!(tc_b.balance(&target_b), 7_920, "token B net to target");
    assert_eq!(tc_a.balance(&bridge_id), 50, "token A fee in bridge");
    assert_eq!(tc_b.balance(&bridge_id), 80, "token B fee in bridge");

    // Withdraw only token A fees — token B balance must be unaffected.
    bridge
        .mock_auths(&[MockAuth {
            address: &fee_collector,
            invoke: &MockAuthInvoke {
                contract: &bridge_id,
                fn_name: "withdraw_fees",
                args: (token_a.clone(), 50i128, soroban_sdk::Val::VOID).into_val(&env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &token_a,
                    fn_name: "transfer",
                    args: (bridge_id.clone(), fee_collector.clone(), 50i128).into_val(&env),
                    sub_invokes: &[],
                }],
            },
        }])
        .withdraw_fees(&token_a, &50, &None);

    assert_eq!(tc_a.balance(&fee_collector), 50, "token A fees withdrawn");
    assert_eq!(tc_a.balance(&bridge_id), 0, "token A bridge empty");
    assert_eq!(tc_b.balance(&bridge_id), 80, "token B fees unaffected");
    assert_eq!(tc_b.balance(&fee_collector), 0, "token B not withdrawn");
}
