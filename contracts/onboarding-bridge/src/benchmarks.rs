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
extern crate std;
use std::{format, println};

use crate::tests::swap_pool_contract::{SwapPool, SwapPoolClient};
use crate::OnboardingBridge;

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Ledger as _},
    Address, Bytes, BytesN, Env, Vec,
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
        if from == to {
            return;
        }
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
    env.cost_estimate().budget().reset_unlimited();
    env.cost_estimate().budget().reset_tracker();
    f();
    let cpu = env.cost_estimate().budget().cpu_instruction_cost();
    let mem = env.cost_estimate().budget().memory_bytes_cost();
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
    measure(&env, "set_max_withdraw_per_tx", &|| { bridge.set_max_withdraw_per_tx(&500i128, &None); });
    measure(&env, "set_source_daily_limit", &|| { bridge.set_source_daily_limit(&new_addr, &token_id, &10_000i128, &None); });
    measure(&env, "set_asset_fee_cap",  &|| { bridge.set_asset_fee_cap(&token_id, &50u32, &None); });
}

// ── fund_c_address_timelocked / claim_timelocked ──────────────────────────────

#[test]
fn bench_fund_c_address_timelocked() {
    let (env, bridge_id, token_id, _admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    let user = Address::generate(&env);
    let target = Address::generate(&env);
    let amount = 10_000i128;
    mint(&env, &token_id, &user, amount * 2);
    let release_time = env.ledger().timestamp() + 365 * 86_400u64; // 1 year from now

    measure(&env, "fund_c_address_timelocked", || {
        bridge.fund_c_address_timelocked(
            &user, &target, &token_id, &amount, &release_time, &0u64, &None, &None,
        );
    });
}

#[test]
fn bench_claim_timelocked() {
    let (env, bridge_id, token_id, _admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    let user = Address::generate(&env);
    let target = Address::generate(&env);
    let amount = 10_000i128;
    mint(&env, &token_id, &user, amount * 2);
    let release_time = env.ledger().timestamp() + 86_400u64;
    let id = bridge.fund_c_address_timelocked(
        &user, &target, &token_id, &amount, &release_time, &0u64, &None, &None,
    );

    // Advance past release_time so the claim succeeds.
    env.ledger().set_timestamp(release_time + 1);

    measure(&env, "claim_timelocked", || {
        bridge.claim_timelocked(&id);
    });
}

// ═══ fund_c_address_crosschain ═════════════════════════════════════════════

#[test]
fn bench_fund_c_address_crosschain() {
    let (env, bridge_id, token_id, admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    // Register a single relayer and set threshold to 1.
    let relayer_secret: [u8; 32] = [1u8; 32];
    let relayer_pubkey = BytesN::from_array(&env, &[1u8; 32]);
    bridge.add_relayer(&relayer_pubkey);
    bridge.set_relayer_threshold(&1u32);

    // Fund the bridge so it can transfer to target.
    mint(&env, &token_id, &bridge_id, 10_000i128);

    let target = Address::generate(&env);
    let chain_id = 1u32;
    let tx_hash = BytesN::from_array(&env, &[2u8; 32]);

    // Build the canonical payload matching the contract's fund_c_address_crosschain.
    // payload = sha256(
    //   chain_id_be4 || tx_hash || sha256(target_strkey) || sha256(asset_strkey)
    //   || amount_be16 || sha256(chain_id_be4 || tx_hash)
    // )
    let mut nonce_pre = Bytes::new(&env);
    nonce_pre.extend_from_array(&chain_id.to_be_bytes());
    let tx_hash_bytes: Bytes = tx_hash.clone().into();
    nonce_pre.append(&tx_hash_bytes);
    let nonce_hash: BytesN<32> = env.crypto().sha256(&nonce_pre).into();

    let mut addr_buf = [0u8; 64];
    let target_hash = hash_address(&env, &mut addr_buf, &target);
    let asset_hash = hash_address(&env, &mut addr_buf, &token_id);

    let mut payload = Bytes::new(&env);
    payload.extend_from_array(&chain_id.to_be_bytes());
    payload.append(&tx_hash_bytes);
    payload.append(&Bytes::from(target_hash));
    payload.append(&Bytes::from(asset_hash));
    payload.extend_from_array(&10_000i128.to_be_bytes());
    payload.append(&Bytes::from(nonce_hash));
    let payload_hash: BytesN<32> = env.crypto().sha256(&payload).into();

    // Create a relayer signature using the env's Ed25519.
    let sig = env.crypto().ed25519_sign(&relayer_secret, &payload_hash);

    let sigs = Vec::from_array(
        &env,
        [crate::RelayerSig {
            pubkey: relayer_pubkey,
            signature: sig,
        }],
    );

    measure(&env, "fund_c_address_crosschain", || {
        bridge.fund_c_address_crosschain(&chain_id, &tx_hash, &target, &token_id, &10_000i128, &sigs);
    });

    let _ = admin;
}

/// Copies a Soroban `Address`'s strkey into `buf` and returns its SHA-256 hash,
/// matching the contract's on-chain address-hashing scheme.
fn hash_address(env: &Env, buf: &mut [u8; 64], addr: &Address) -> BytesN<32> {
    let s = addr.to_string();
    let len = s.len() as usize;
    s.copy_into_slice(&mut buf[..len]);
    env.crypto()
        .sha256(&Bytes::from_slice(env, &buf[..len]))
        .into()
}

// ── commit_fund / reveal_fund ─────────────────────────────────────────────────

#[test]
fn bench_commit_fund() {
    let (env, bridge_id, token_id, _admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    let user = Address::generate(&env);
    let target = Address::generate(&env);

    use soroban_sdk::Bytes;
    let mut preimage = Bytes::new(&env);
    preimage.extend_from_array(&10_000i128.to_be_bytes());
    preimage.extend_from_array(&1u64.to_be_bytes());
    let amount_hash: BytesN<32> = env.crypto().sha256(&preimage).into();
    let deadline = env.ledger().timestamp() + 86_400;

    measure(&env, "commit_fund", || {
        bridge.commit_fund(&user, &target, &token_id, &amount_hash, &deadline);
    });
}

#[test]
fn bench_reveal_fund() {
    let (env, bridge_id, token_id, _admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    let user = Address::generate(&env);
    let target = Address::generate(&env);
    let amount = 10_000i128;
    let nonce = 1u64;

    mint(&env, &token_id, &user, amount * 2);

    use soroban_sdk::Bytes;
    let mut preimage = Bytes::new(&env);
    preimage.extend_from_array(&amount.to_be_bytes());
    preimage.extend_from_array(&nonce.to_be_bytes());
    let amount_hash: BytesN<32> = env.crypto().sha256(&preimage).into();
    let deadline = env.ledger().timestamp() + 86_400;

    let id = bridge.commit_fund(&user, &target, &token_id, &amount_hash, &deadline);

    // Advance past the minimum delay.
    env.ledger().set_sequence_number(env.ledger().sequence() + crate::COMMIT_REVEAL_MIN_DELAY_LEDGERS + 1);

    measure(&env, "reveal_fund", || {
        bridge.reveal_fund(&id, &user, &target, &token_id, &amount, &nonce);
    });
}

// ── fund_c_address_with_swap ──────────────────────────────────────────────────

#[test]
fn bench_fund_c_address_with_swap() {
    let (env, bridge_id, _token_id, admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    let user = Address::generate(&env);
    let target = Address::generate(&env);

    // Deploy two tokens: source and target.
    let src_token_id = env.register(BenchToken, ());
    let dst_token_id = env.register(BenchToken, ());
    BenchTokenClient::new(&env, &src_token_id).initialize(&admin);
    BenchTokenClient::new(&env, &dst_token_id).initialize(&admin);
    mint(&env, &src_token_id, &user, 10_000i128);
    bridge.add_asset(&dst_token_id, &None);

    // Deploy a minimal swap pool.
    let pool_id = env.register(SwapPool, ());
    SwapPoolClient::new(&env, &pool_id).initialize(&src_token_id, &dst_token_id, &1i128);

    // Fund the swap pool with destination tokens.
    mint(&env, &dst_token_id, &pool_id, 10_000i128);

    bridge.add_swap_pool(&pool_id, &None);

    let swap_route = Vec::from_array(&env, [pool_id]);

    measure(&env, "fund_c_address_with_swap", || {
        bridge.fund_c_address_with_swap(
            &user, &target, &src_token_id, &dst_token_id, &10_000i128, &1i128, &swap_route, &None, &None,
        );
    });
}

// ── execute_meta_fund ─────────────────────────────────────────────────────────

#[test]
fn bench_execute_meta_fund() {
    let (env, bridge_id, token_id, _admin, _fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);

    let source = Address::generate(&env);
    let target = Address::generate(&env);
    let amount = 10_000i128;

    // Fund the bridge so it can transfer to target.
    mint(&env, &token_id, &bridge_id, amount);

    // Generate a keypair and register it as the meta signer for source.
    let secret: [u8; 32] = [7u8; 32];
    let pubkey = BytesN::from_array(&env, &[7u8; 32]);
    bridge.register_meta_signer(&source, &pubkey);

    // Build the canonical meta-fund payload and sign it.
    use soroban_sdk::Bytes;
    let domain = Bytes::from_slice(&env, b"meta_fund");
    let mut addr_buf = [0u8; 64];

    let src_hash = hash_address(&env, &mut addr_buf, &source);
    let tgt_hash = hash_address(&env, &mut addr_buf, &target);
    let ast_hash = hash_address(&env, &mut addr_buf, &token_id);

    let nonce = 1u64;
    let deadline = env.ledger().timestamp() + 86_400;

    let mut payload = Bytes::new(&env);
    payload.append(&domain);
    payload.append(&src_hash.into());
    payload.append(&tgt_hash.into());
    payload.append(&ast_hash.into());
    payload.extend_from_array(&amount.to_be_bytes());
    payload.extend_from_array(&nonce.to_be_bytes());
    payload.extend_from_array(&deadline.to_be_bytes());
    let payload_hash: BytesN<32> = env.crypto().sha256(&payload).into();

    let signature = env.crypto().ed25519_sign(&secret, &payload_hash);

    let params = crate::MetaFundParams {
        source: source.clone(),
        target: target.clone(),
        asset: token_id.clone(),
        amount,
        nonce,
        deadline,
    };

    measure(&env, "execute_meta_fund", || {
        bridge.execute_meta_fund(&params, &pubkey, &signature);
    });
}

// ── Tiered fee lookups ────────────────────────────────────────────────────────

#[test]
fn bench_tiered_fee_lookup() {
    let (env, bridge_id, token_id, admin, fee_collector) = initialized_setup();
    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    let user = Address::generate(&env);

    // Configure fee tiers.
    let tiers = Vec::from_array(
        &env,
        [
            crate::FeeTier { min_volume: 0, max_volume: 1_000i128, fee_bps: 10u32 },
            crate::FeeTier { min_volume: 1_001i128, max_volume: 10_000i128, fee_bps: 25u32 },
            crate::FeeTier { min_volume: 10_001i128, max_volume: 1_000_000i128, fee_bps: 50u32 },
        ],
    );
    bridge.set_fee_tiers(&tiers);
    mint(&env, &token_id, &user, 1_000_000i128 * 2);

    // Fund once to build volume so the tiered lookup activates.
    bridge.fund_c_address(&user, &Address::generate(&env), &token_id, &10_000i128, &None, &None);

    measure(&env, "fund_c_address/tiered_fee", || {
        bridge.fund_c_address(&user, &Address::generate(&env), &token_id, &10_000i128, &None, &None);
    });

    let _ = (admin, fee_collector);
}
