//! Gas/cost benchmarks for OnboardingBridge contract functions.
//!
//! Run with:
//!   cargo test -p onboarding-bridge --features testutils bench_ -- --nocapture
//!
//! Each benchmark resets the budget tracker before the measured call and
//! prints a single tab-separated row so the CI step can assemble a table
//! and diff against stored baselines.
//!
//! Output columns: name, cpu_instructions, memory_bytes

#![cfg(test)]

use crate::OnboardingBridge;

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger},
    Address, Env, IntoVal, Vec,
};

// ── Inline minimal token (mirrors the one in tests.rs) ────────────────────────

#[contracttype]
pub enum BTDataKey {
    Admin,
    Balance,
}

#[contract]
pub struct BenchToken;

#[contractimpl]
impl BenchToken {
    pub fn initialize(e: Env, admin: Address) {
        e.storage().instance().set(&BTDataKey::Admin, &admin);
    }
    pub fn mint(e: Env, to: Address, amount: i128) {
        let admin: Address = e.storage().instance().get(&BTDataKey::Admin).unwrap();
        admin.require_auth();
        let bal = Self::balance(e.clone(), to.clone());
        e.storage()
            .persistent()
            .set(&(BTDataKey::Balance, to), &(bal + amount));
    }
    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&(BTDataKey::Balance, id))
            .unwrap_or(0)
    }
    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let fb = Self::balance(e.clone(), from.clone());
        let tb = Self::balance(e.clone(), to.clone());
        e.storage()
            .persistent()
            .set(&(BTDataKey::Balance, from), &(fb - amount));
        e.storage()
            .persistent()
            .set(&(BTDataKey::Balance, to), &(tb + amount));
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();
    let bridge_id = env.register(OnboardingBridge, ());
    let token_id = env.register(BenchToken, ());
    let admin = Address::generate(&env);
    let fee_collector = Address::generate(&env);
    BenchTokenClient::new(&env, &token_id).initialize(&admin);
    (env, bridge_id, token_id, admin, fee_collector)
}

fn initialized_setup() -> (Env, Address, Address, Address, Address) {
    let (env, bridge_id, token_id, admin, fee_collector) = setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    (env, bridge_id, token_id, admin, fee_collector)
}

fn mint(env: &Env, token_id: &Address, to: &Address, amount: i128) {
    BenchTokenClient::new(env, token_id).mint(to, &amount);
}

/// Reset the budget tracker, run `f`, then capture and print costs.
fn measure(env: &Env, name: &str, f: impl FnOnce()) {
    env.budget().reset_unlimited();
    env.budget().reset_tracker();
    f();
    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();
    // Tab-separated so CI can parse it with `column -t`
    println!("BENCH\t{name}\t{cpu}\t{mem}");
}

// ── initialize ─────────────────────────────────────────────────────────────────

#[test]
fn bench_initialize_cold() {
    let (env, bridge_id, _token_id, admin, fee_collector) = setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    measure(&env, "initialize/cold", || {
        bridge.initialize(&admin, &fee_collector, &100u32, &None);
    });
}

#[test]
fn bench_initialize_warm() {
    // "warm" = contract already has storage from a previous initialize attempt;
    // we register a fresh instance but pre-touch the env to warm host internals.
    let (env, bridge_id, _token_id, admin, fee_collector) = setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    bridge.initialize(&admin, &fee_collector, &100u32, &None);

    // Register a second bridge instance and measure its initialize (host is warm).
    let bridge2_id = env.register(OnboardingBridge, ());
    let bridge2 = crate::OnboardingBridgeClient::new(&env, &bridge2_id);
    let admin2 = Address::generate(&env);
    let fc2 = Address::generate(&env);
    measure(&env, "initialize/warm", || {
        bridge2.initialize(&admin2, &fc2, &100u32, &None);
    });
}

// ── fund_c_address ─────────────────────────────────────────────────────────────

fn bench_fund_amount(amount: i128) {
    let (env, bridge_id, token_id, _admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    let user = Address::generate(&env);
    let target = Address::generate(&env);
    mint(&env, &token_id, &user, amount * 2);
    measure(&env, &format!("fund_c_address/amount={amount}"), || {
        bridge.fund_c_address(&user, &target, &token_id, &amount, &None, &None);
    });
}

#[test]
fn bench_fund_c_address_small()  { bench_fund_amount(100); }
#[test]
fn bench_fund_c_address_medium() { bench_fund_amount(1_000_000); }
#[test]
fn bench_fund_c_address_large()  { bench_fund_amount(1_000_000_000); }

// ── batch_fund_c_address ───────────────────────────────────────────────────────

fn bench_batch(size: u32) {
    let (env, bridge_id, token_id, _admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    let user = Address::generate(&env);
    let total = 1_000i128 * size as i128;
    mint(&env, &token_id, &user, total * 2);

    let mut targets: Vec<Address> = Vec::new(&env);
    let mut amounts: Vec<i128> = Vec::new(&env);
    for _ in 0..size {
        targets.push_back(Address::generate(&env));
        amounts.push_back(1_000i128);
    }

    measure(&env, &format!("batch_fund_c_address/size={size}"), || {
        bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);
    });
}

#[test]
fn bench_batch_1()  { bench_batch(1); }
#[test]
fn bench_batch_5()  { bench_batch(5); }
#[test]
fn bench_batch_10() { bench_batch(10); }
#[test]
fn bench_batch_50() { bench_batch(50); }

// ── withdraw_fees ──────────────────────────────────────────────────────────────

fn bench_withdraw(amount: i128) {
    let (env, bridge_id, token_id, admin, fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Seed fees by running a fund first (outside the measurement window).
    let user = Address::generate(&env);
    mint(&env, &token_id, &user, amount * 100);
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &(amount * 100), &None, &None);

    measure(&env, &format!("withdraw_fees/amount={amount}"), || {
        bridge.withdraw_fees(&token_id, &amount, &None);
    });
    let _ = (admin, fee_collector);
}

#[test]
fn bench_withdraw_fees_small()  { bench_withdraw(10); }
#[test]
fn bench_withdraw_fees_medium() { bench_withdraw(500); }
#[test]
fn bench_withdraw_fees_large()  { bench_withdraw(5_000); }

// ── view functions ─────────────────────────────────────────────────────────────

#[test]
fn bench_views() {
    let (env, bridge_id, token_id, _admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    let addr = Address::generate(&env);

    let views: &[(&str, &dyn Fn())] = &[
        ("query_fee_bps",          &|| { bridge.query_fee_bps(); }),
        ("query_fee_collector",    &|| { bridge.query_fee_collector(); }),
        ("query_admin",            &|| { bridge.query_admin(); }),
        ("query_is_initialized",   &|| { bridge.query_is_initialized(); }),
        ("query_is_paused",        &|| { bridge.query_is_paused(); }),
        ("query_referral_rate",    &|| { bridge.query_referral_rate(); }),
        ("query_fee_balance",      &|| { bridge.query_fee_balance(&token_id); }),
        ("query_balance",          &|| { bridge.query_balance(&addr, &token_id); }),
        ("query_is_blocked",       &|| { bridge.query_is_blocked(&addr); }),
        ("query_is_allowlisted",   &|| { bridge.query_is_allowlisted(&addr); }),
        ("query_allowlist_mode",   &|| { bridge.query_allowlist_mode(); }),
        ("query_nonce",            &|| { bridge.query_nonce(&addr); }),
        ("query_calculate_fee",    &|| { bridge.query_calculate_fee(&1_000_000i128); }),
        ("query_total_bridged",    &|| { bridge.query_total_bridged(&token_id); }),
        ("query_total_fees_collected", &|| { bridge.query_total_fees_collected(&token_id); }),
    ];

    for (name, f) in views {
        measure(&env, name, f);
    }
}

// ── admin setters ──────────────────────────────────────────────────────────────

#[test]
fn bench_admin_setters() {
    let (env, bridge_id, token_id, _admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    let new_addr = Address::generate(&env);

    measure(&env, "set_fee_bps",        &|| { bridge.set_fee_bps(&200u32, &None); });
    measure(&env, "set_referral_rate",  &|| { bridge.set_referral_rate(&2000u32, &None); });
    measure(&env, "set_fee_collector",  &|| { bridge.set_fee_collector(&new_addr, &None); });
    measure(&env, "set_admin",          &|| { bridge.set_admin(&new_addr, &None); });
    measure(&env, "add_asset",          &|| { bridge.add_asset(&token_id, &None); });
    measure(&env, "remove_asset",       &|| { bridge.remove_asset(&token_id, &None); });
    measure(&env, "add_to_blocklist",   &|| { bridge.add_to_blocklist(&new_addr, &None); });
    measure(&env, "remove_from_blocklist", &|| { bridge.remove_from_blocklist(&new_addr, &None); });
    measure(&env, "add_to_allowlist",   &|| { bridge.add_to_allowlist(&new_addr, &None); });
    measure(&env, "remove_from_allowlist", &|| { bridge.remove_from_allowlist(&new_addr, &None); });
    measure(&env, "set_allowlist_mode", &|| { bridge.set_allowlist_mode(&true, &None); });
    measure(&env, "pause",              &|| { bridge.pause(&None); });
    measure(&env, "unpause",            &|| { bridge.unpause(&None); });
}
