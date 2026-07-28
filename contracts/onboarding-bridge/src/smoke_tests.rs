//! Post-deployment smoke tests.
//!
//! These are the checks `.github/workflows/smoke-tests.yml` runs after a
//! deployment, filtered by the `smoke_` prefix. They are deliberately a thin,
//! fast subset of `tests.rs`: enough to prove the deployed build initialises,
//! enforces its guards, moves funds, and reports consistent accounting — not a
//! re-run of the full suite.
//!
//! Live on-chain verification of the deployed address (that the contract
//! actually exists on the target network) is done by the workflow itself via
//! the Soroban RPC endpoint, because reaching the network from inside the
//! contract test harness would mean adding an HTTP client to the crate.

use crate::{BridgeError, OnboardingBridge};

use soroban_sdk::{
    contract, contractimpl, testutils::Address as _, Address, Env, IntoVal, String as SorobanString,
};

// A minimal token stand-in; the contract only needs transfer/balance/mint.
#[contract]
struct SmokeToken;

#[contractimpl]
impl SmokeToken {
    pub fn initialize(env: Env, admin: Address, decimals: u32, name: SorobanString, symbol: SorobanString) {
        env.storage().instance().set(&"admin", &admin);
        env.storage().instance().set(&"decimals", &decimals);
        env.storage().instance().set(&"name", &name);
        env.storage().instance().set(&"symbol", &symbol);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let balance: i128 = env.storage().persistent().get(&to).unwrap_or(0);
        env.storage().persistent().set(&to, &(balance + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage().persistent().get(&id).unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_balance: i128 = env.storage().persistent().get(&from).unwrap_or(0);
        let to_balance: i128 = env.storage().persistent().get(&to).unwrap_or(0);
        env.storage().persistent().set(&from, &(from_balance - amount));
        env.storage().persistent().set(&to, &(to_balance + amount));
    }
}

struct Fixture<'a> {
    env: Env,
    bridge: crate::OnboardingBridgeClient<'a>,
    token: Address,
    admin: Address,
    user: Address,
    fee_collector: Address,
}

/// Registers the bridge and a token, initialises the bridge, and funds the
/// user — the state every smoke test starts from.
fn deploy() -> Fixture<'static> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let user = Address::generate(&env);
    let fee_collector = Address::generate(&env);

    let bridge_id = env.register(OnboardingBridge, ());
    let token = env.register(SmokeToken, ());

    let token_client = SmokeTokenClient::new(&env, &token);
    token_client.initialize(&admin, &7u32, &"Smoke".into_val(&env), &"SMK".into_val(&env));
    token_client.mint(&user, &1_000_000i128);

    let bridge = crate::OnboardingBridgeClient::new(&env, &bridge_id);
    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    Fixture {
        env,
        bridge,
        token,
        admin,
        user,
        fee_collector,
    }
}

/// The deployed contract initialises and reports back the configuration it
/// was given. If this fails, nothing else about the deployment is trustworthy.
#[test]
fn smoke_initializes_with_expected_configuration() {
    let f = deploy();

    assert_eq!(f.bridge.query_fee_bps(), 50u32);
    assert_eq!(f.bridge.query_admin(), f.admin);
    assert_eq!(f.bridge.query_fee_collector(), f.fee_collector);
}

/// Initialisation is one-shot. A second call must be rejected rather than
/// silently reassigning the admin.
#[test]
fn smoke_rejects_double_initialization() {
    let f = deploy();

    let result = f
        .bridge
        .try_initialize(&f.admin, &f.fee_collector, &50u32, &None);

    assert_eq!(result, Err(Ok(BridgeError::AlreadyInitialized)));
}

/// The core happy path: funding moves the amount out of the source and splits
/// it between the target and the fee collector.
#[test]
fn smoke_funds_target_and_collects_fee() {
    let f = deploy();
    let target = Address::generate(&f.env);
    let token_client = SmokeTokenClient::new(&f.env, &f.token);

    let amount = 100_000i128;
    f.bridge
        .fund_c_address(&f.user, &target, &f.token, &amount, &None, &None);

    // 50 bps of 100_000 = 500.
    let expected_fee = 500i128;
    assert_eq!(token_client.balance(&target), amount - expected_fee);
    assert_eq!(token_client.balance(&f.fee_collector), expected_fee);
    assert_eq!(token_client.balance(&f.user), 1_000_000 - amount);
}

/// Accounting totals must agree with what actually moved.
#[test]
fn smoke_tracks_totals_after_funding() {
    let f = deploy();
    let target = Address::generate(&f.env);

    f.bridge
        .fund_c_address(&f.user, &target, &f.token, &100_000i128, &None, &None);

    assert_eq!(f.bridge.query_total_bridged(&f.token), 100_000i128);
    assert_eq!(f.bridge.query_total_fees_collected(&f.token), 500i128);
}

/// Input validation is live on the deployed build — a non-positive amount is
/// rejected instead of being processed as a no-op transfer.
#[test]
fn smoke_rejects_invalid_amount() {
    let f = deploy();
    let target = Address::generate(&f.env);

    let result = f
        .bridge
        .try_fund_c_address(&f.user, &target, &f.token, &0i128, &None, &None);

    assert_eq!(result, Err(Ok(BridgeError::InvalidAmount)));
}

/// The emergency stop works and is reversible. A deployment where pause is
/// broken cannot be safely operated.
#[test]
fn smoke_pause_blocks_funding_and_unpause_restores_it() {
    let f = deploy();
    let target = Address::generate(&f.env);

    f.bridge.pause(&None);

    let paused = f
        .bridge
        .try_fund_c_address(&f.user, &target, &f.token, &100_000i128, &None, &None);
    assert!(paused.is_err(), "funding must be rejected while paused");

    f.bridge.unpause(&None);

    f.bridge
        .fund_c_address(&f.user, &target, &f.token, &100_000i128, &None, &None);
    assert_eq!(f.bridge.query_total_bridged(&f.token), 100_000i128);
}
