//! End-to-end tests for Soroban token contract interactions.
//!
//! Each test registers a real Stellar Asset Contract (SAC) via
//! `register_stellar_asset_contract_v2` so that token transfers are executed
//! by the real token WASM, not a mock. Auth for setup steps uses
//! `mock_all_auths`; the calls under test use scoped `mock_auths` to assert
//! the precise auth chain.

#![cfg(test)]

use crate::OnboardingBridge;

use soroban_sdk::{
    testutils::{Address as _, Ledger, MockAuth, MockAuthInvoke},
    token::{Client as TokenClient, StellarAssetClient},
    Address, Env, IntoVal, Vec,
};

// ─── Shared setup ─────────────────────────────────────────────────────────────

struct Setup {
    env: Env,
    bridge_id: Address,
    token_id: Address,
    admin: Address,
    fee_collector: Address,
}

impl Setup {
    /// fee_bps = 200 (2%) by default so fee arithmetic is easy to verify.
    fn new() -> Self {
        Self::with_fee(200)
    }

    fn with_fee(fee_bps: u32) -> Self {
        let env = Env::default();
        let admin = Address::generate(&env);
        let fee_collector = Address::generate(&env);

        let sac = env.register_stellar_asset_contract_v2(admin.clone());
        let token_id = sac.address();
        let bridge_id = env.register(OnboardingBridge, ());

        let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
        bridge.mock_all_auths().initialize(&admin, &fee_collector, &fee_bps, &None);
        bridge.mock_all_auths().add_asset(&token_id, &None);

        Self { env, bridge_id, token_id, admin, fee_collector }
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

    fn mint(&self, to: &Address, amount: i128) {
        self.sac().mock_all_auths().mint(to, &amount);
    }

    /// Call fund_c_address with a scoped user auth (not mock_all_auths).
    fn fund(&self, user: &Address, target: &Address, amount: i128) {
        self.bridge()
            .mock_auths(&[MockAuth {
                address: user,
                invoke: &MockAuthInvoke {
                    contract: &self.bridge_id,
                    fn_name: "fund_c_address",
                    args: (
                        user.clone(),
                        target.clone(),
                        self.token_id.clone(),
                        amount,
                        soroban_sdk::Val::VOID,
                        soroban_sdk::Val::VOID,
                    )
                        .into_val(&self.env),
                    sub_invokes: &[MockAuthInvoke {
                        contract: &self.token_id,
                        fn_name: "transfer",
                        args: (user.clone(), self.bridge_id.clone(), amount)
                            .into_val(&self.env),
                        sub_invokes: &[],
                    }],
                },
            }])
            .fund_c_address(user, target, &self.token_id, &amount, &None, &None);
    }
}

// ─── Test 1: per-asset fee cap overrides global fee ──────────────────────────

/// Global fee_bps = 200 (2%). Cap token at 50 bps (0.5%).
/// The effective fee must be 50 bps, not 200.
#[test]
fn e2e_asset_fee_cap_overrides_global() {
    let s = Setup::new(); // fee_bps = 200

    // Admin sets a per-asset cap of 50 bps.
    s.bridge().mock_all_auths().set_asset_fee_cap(&s.token_id, &50u32, &None);

    let user = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.mint(&user, 10_000);

    s.fund(&user, &target, 10_000);

    // effective_bps = min(200, 50) = 50 → fee = 10_000 × 50 / 10_000 = 50
    assert_eq!(s.balance(&target), 9_950, "net amount with capped fee");
    assert_eq!(s.balance(&s.bridge_id), 50, "bridge holds capped fee");
    assert_eq!(s.balance(&user), 0, "user fully spent");
}

// ─── Test 2: per-asset fee cap query reflects saved value ─────────────────────

#[test]
fn e2e_query_asset_fee_cap() {
    let s = Setup::new();
    s.bridge().mock_all_auths().set_asset_fee_cap(&s.token_id, &75u32, &None);

    let cap = s.bridge().query_asset_fee_cap(&s.token_id).unwrap();
    assert_eq!(cap, 75u32);
}

// ─── Test 3: daily limit blocks a transfer that exceeds it ────────────────────

#[test]
fn e2e_daily_limit_blocks_excess_transfer() {
    let s = Setup::new();

    let user = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.mint(&user, 20_000);

    // Admin sets per-source daily limit of 5_000.
    s.bridge()
        .mock_all_auths()
        .set_source_daily_limit(&user, &s.token_id, &5_000i128, &None);

    // An amount of 6_000 exceeds the limit — must be rejected.
    let result = s
        .bridge()
        .mock_all_auths()
        .try_fund_c_address(&user, &target, &s.token_id, &6_000i128, &None, &None);

    assert_eq!(result, Err(Ok(crate::BridgeError::DailyLimitExceeded)));
    // No tokens moved.
    assert_eq!(s.balance(&user), 20_000);
    assert_eq!(s.balance(&target), 0);
}

// ─── Test 4: daily limit allows transfer at exactly the limit ─────────────────

#[test]
fn e2e_daily_limit_allows_exact_limit_amount() {
    let s = Setup::new(); // fee_bps = 200

    let user = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.mint(&user, 10_000);

    s.bridge()
        .mock_all_auths()
        .set_source_daily_limit(&user, &s.token_id, &5_000i128, &None);

    s.fund(&user, &target, 5_000);

    // fee = 5_000 × 200 / 10_000 = 100
    assert_eq!(s.balance(&target), 4_900);
    assert_eq!(s.balance(&s.bridge_id), 100);
}

// ─── Test 5: pause blocks fund_c_address, unpause restores it ─────────────────

#[test]
fn e2e_pause_blocks_fund_unpause_restores() {
    let s = Setup::new();

    let user = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.mint(&user, 10_000);

    // Pause contract.
    s.bridge().mock_all_auths().pause(&None);

    let result = s
        .bridge()
        .mock_all_auths()
        .try_fund_c_address(&user, &target, &s.token_id, &1_000i128, &None, &None);

    assert_eq!(result, Err(Ok(crate::BridgeError::ContractPaused)));
    assert_eq!(s.balance(&user), 10_000, "no tokens moved while paused");

    // Unpause and retry.
    s.bridge().mock_all_auths().unpause(&None);

    s.fund(&user, &target, 1_000);
    // fee = 1_000 × 200 / 10_000 = 20
    assert_eq!(s.balance(&target), 980);
}

// ─── Test 6: blocklist in batch_fund — blocked target gets refunded ────────────

#[test]
fn e2e_batch_blocked_target_refunded_to_source() {
    let s = Setup::new(); // fee_bps = 200

    let user = Address::generate(&s.env);
    let ok_target = Address::generate(&s.env);
    let blocked_target = Address::generate(&s.env);
    s.mint(&user, 20_000);

    // Block one target.
    s.bridge()
        .mock_all_auths()
        .add_to_blocklist(&blocked_target, &None);

    let mut targets = Vec::new(&s.env);
    targets.push_back(ok_target.clone());
    targets.push_back(blocked_target.clone());

    let mut amounts = Vec::new(&s.env);
    amounts.push_back(10_000i128);
    amounts.push_back(10_000i128);

    s.bridge()
        .mock_auths(&[MockAuth {
            address: &user,
            invoke: &MockAuthInvoke {
                contract: &s.bridge_id,
                fn_name: "batch_fund_c_address",
                args: (
                    user.clone(),
                    targets.clone(),
                    amounts.clone(),
                    s.token_id.clone(),
                    soroban_sdk::Val::VOID,
                    soroban_sdk::Val::VOID,
                )
                    .into_val(&s.env),
                sub_invokes: &[MockAuthInvoke {
                    contract: &s.token_id,
                    fn_name: "transfer",
                    args: (user.clone(), s.bridge_id.clone(), 20_000i128)
                        .into_val(&s.env),
                    sub_invokes: &[],
                }],
            },
        }])
        .batch_fund_c_address(&user, &targets, &amounts, &s.token_id, &None, &None);

    // ok_target: 10_000 − 200 (2%) = 9_800
    assert_eq!(s.balance(&ok_target), 9_800, "ok_target receives net amount");
    // blocked_target receives nothing
    assert_eq!(s.balance(&blocked_target), 0, "blocked target receives nothing");
    // user gets back refund for blocked target's full amount
    assert_eq!(s.balance(&user), 10_000, "source refunded blocked amount");
    // bridge holds fee for successful transfer only
    assert_eq!(s.balance(&s.bridge_id), 200, "bridge holds fee for ok transfer");
}

// ─── Test 7: referral fee splits correctly between referrer and protocol ───────

#[test]
fn e2e_referral_fee_split() {
    let s = Setup::new(); // fee_bps = 200

    // Set referral rate to 5000 bps of the fee (50% of fee goes to referrer).
    s.bridge().mock_all_auths().set_referral_rate(&5_000u32, &None);

    let user = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    let referrer = Address::generate(&s.env);
    s.mint(&user, 10_000);

    s.bridge()
        .mock_all_auths()
        .fund_c_address_with_referral(
            &user,
            &target,
            &s.token_id,
            &10_000i128,
            &Some(referrer.clone()),
        );

    // gross = 10_000, fee_bps = 200 → fee = 200
    // referral_rate = 5000 → referral_fee = 200 × 5000 / 10_000 = 100
    // protocol_fee = 100, net_to_target = 9_800
    assert_eq!(s.balance(&target), 9_800, "target receives net amount");
    assert_eq!(s.balance(&referrer), 100, "referrer receives referral fee");
    assert_eq!(s.balance(&s.bridge_id), 100, "bridge holds protocol fee only");
    assert_eq!(s.balance(&user), 0);
}

// ─── Test 8: total_bridged and total_fees_collected accumulators ───────────────

#[test]
fn e2e_total_bridged_and_fees_tracked() {
    let s = Setup::new(); // fee_bps = 200

    let user = Address::generate(&s.env);
    s.mint(&user, 30_000);

    for _ in 0..3 {
        let target = Address::generate(&s.env);
        s.fund(&user, &target, 10_000);
    }

    // Each fund: net = 9_800, fee = 200
    // 3 × net = 29_400 total bridged; 3 × 200 = 600 total fees collected
    let total_bridged = s.bridge().query_total_bridged(&s.token_id).unwrap();
    let total_fees = s.bridge().query_total_fees_collected(&s.token_id).unwrap();

    assert_eq!(total_bridged, 29_400, "total bridged across 3 funds");
    assert_eq!(total_fees, 600, "total fees collected across 3 funds");
}

// ─── Test 9: query_balance reads live SAC token balance via contract ───────────

/// query_balance must delegate to the real token and reflect any external mint.
#[test]
fn e2e_query_balance_reflects_real_token_state() {
    let s = Setup::new();

    let wallet = Address::generate(&s.env);
    s.mint(&wallet, 42_000);

    let reported = s.bridge().query_balance(wallet.clone(), s.token_id.clone());
    assert_eq!(reported, 42_000, "query_balance reflects real SAC balance");

    // Mint more externally — query_balance must pick up the change.
    s.mint(&wallet, 8_000);
    let reported2 = s.bridge().query_balance(wallet.clone(), s.token_id.clone());
    assert_eq!(reported2, 50_000, "query_balance reflects updated SAC balance");
}

// ─── Test 10: zero-fee contract still transfers full amount to target ──────────

#[test]
fn e2e_zero_fee_full_amount_transferred() {
    let s = Setup::with_fee(0);

    let user = Address::generate(&s.env);
    let target = Address::generate(&s.env);
    s.mint(&user, 5_000);

    s.fund(&user, &target, 5_000);

    assert_eq!(s.balance(&target), 5_000, "target receives full amount with zero fee");
    assert_eq!(s.balance(&s.bridge_id), 0, "no fee in bridge with fee_bps=0");
    assert_eq!(s.balance(&user), 0);
}
