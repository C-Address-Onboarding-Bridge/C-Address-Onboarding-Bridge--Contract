use crate::{BridgeError, OnboardingBridge};

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events},
    Address, Bytes, BytesN, Env, IntoVal, Vec,
};

fn register_all_contracts(env: &Env) -> (Address, Address) {
    let bridge_id = env.register(OnboardingBridge, ());
    let token_id = env.register(TestToken, ());
    env.mock_all_auths();
    (bridge_id, token_id)
}

fn init_token(env: &Env, token_id: &Address, admin: &Address) {
    let token = TestTokenClient::new(env, token_id);
    token.initialize(admin, &7u32, &"Test".into_val(env), &"TST".into_val(env));
}

fn create_bridge_client<'a>(
    env: &'a Env,
    bridge_id: &Address,
) -> crate::OnboardingBridgeClient<'a> {
    crate::OnboardingBridgeClient::new(env, bridge_id)
}

fn create_test_users(env: &Env) -> (Address, Address, Address) {
    let admin = Address::generate(env);
    let user = Address::generate(env);
    let fee_collector = Address::generate(env);
    (admin, user, fee_collector)
}

fn mint_tokens(env: &Env, token_id: &Address, to: &Address, amount: i128) {
    let token = TestTokenClient::new(env, token_id);
    token.mint(to, &amount);
}

fn check_balance(env: &Env, token_id: &Address, addr: &Address) -> i128 {
    let token = TestTokenClient::new(env, token_id);
    token.balance(addr)
}

#[test]
fn test_initialize() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);

    assert_eq!(bridge.query_fee_bps(), 50u32);
    assert_eq!(bridge.query_fee_collector(), fee_collector);
    assert_eq!(bridge.query_admin(), admin);
    assert!(bridge.query_is_initialized());
}

#[test]
fn test_initialize_twice() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    assert_eq!(
        bridge.try_initialize(&admin, &fee_collector, &50u32),
        Err(Ok(BridgeError::AlreadyInitialized))
    );
}

#[test]
fn test_initialize_fee_too_high() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    assert_eq!(
        bridge.try_initialize(&admin, &fee_collector, &2000u32),
        Err(Ok(BridgeError::FeeTooHigh))
    );
}

#[test]
fn test_fund_c_address() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128);

    assert_eq!(check_balance(&env, &token_id, &user), 500i128);
    assert_eq!(check_balance(&env, &token_id, &target), 495i128);
    assert_eq!(check_balance(&env, &token_id, &fee_collector), 0i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 5i128);
}

#[test]
fn test_fund_without_initialize() {
    let env = Env::default();
    let (_admin, user, _fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&Address::generate(&env), &Address::generate(&env), &50u32);

    let b2_id = env.register(OnboardingBridge, ());
    let b2 = crate::OnboardingBridgeClient::new(&env, &b2_id);
    let target = Address::generate(&env);
    assert_eq!(
        b2.try_fund_c_address(&user, &target, &token_id, &100i128),
        Err(Ok(BridgeError::NotInitialized))
    );
}

#[test]
fn test_batch_fund_c_addresses() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32);
    mint_tokens(&env, &token_id, &user, 3000i128);

    let target1 = Address::generate(&env);
    let target2 = Address::generate(&env);
    let targets = Vec::from_array(&env, [target1.clone(), target2.clone()]);
    let amounts = Vec::from_array(&env, [1000i128, 500i128]);

    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id);

    assert_eq!(check_balance(&env, &token_id, &user), 1500i128);
    assert_eq!(check_balance(&env, &token_id, &target1), 990i128);
    assert_eq!(check_balance(&env, &token_id, &target2), 495i128);
    assert_eq!(check_balance(&env, &token_id, &fee_collector), 0i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 15i128);
}

#[test]
fn test_fund_with_zero_fee() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &0u32);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128);

    assert_eq!(check_balance(&env, &token_id, &user), 500i128);
    assert_eq!(check_balance(&env, &token_id, &target), 500i128);
    assert_eq!(check_balance(&env, &token_id, &fee_collector), 0i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 0i128);
}

#[test]
fn test_set_fee_bps() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    assert_eq!(bridge.query_fee_bps(), 50u32);

    bridge.set_fee_bps(&200u32);
    assert_eq!(bridge.query_fee_bps(), 200u32);
}

#[test]
fn test_set_fee_bps_too_high() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    assert_eq!(
        bridge.try_set_fee_bps(&2000u32),
        Err(Ok(BridgeError::FeeTooHigh))
    );
}

#[test]
fn test_set_fee_collector() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    let new_collector = Address::generate(&env);
    bridge.set_fee_collector(&new_collector);
    assert_eq!(bridge.query_fee_collector(), new_collector);
}

#[test]
fn test_set_admin() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    let new_admin = Address::generate(&env);
    bridge.set_admin(&new_admin);
    assert_eq!(bridge.query_admin(), new_admin);
}

#[test]
fn test_withdraw_fees() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128);

    assert_eq!(check_balance(&env, &token_id, &fee_collector), 0i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 5i128);

    bridge.withdraw_fees(&token_id, &5i128);

    assert_eq!(check_balance(&env, &token_id, &fee_collector), 5i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 0i128);
}

#[test]
fn test_query_balance() {
    let env = Env::default();
    let (admin, user, _fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &Address::generate(&env), &0u32);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let bal = bridge.query_balance(&user, &token_id);
    assert_eq!(bal, 1000i128);
}

#[test]
fn test_batch_empty() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    let token_id = Address::generate(&env);
    bridge.initialize(&admin, &fee_collector, &50u32);

    let targets: Vec<Address> = Vec::new(&env);
    let amounts: Vec<i128> = Vec::new(&env);

    bridge.batch_fund_c_address(&admin, &targets, &amounts, &token_id);
}

#[test]
fn test_fund_events() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128);

    let events = env.events().all();
    assert!(events.len() > 0);

    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

#[test]
fn test_query_fee_bps_uninitialized() {
    let env = Env::default();
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    assert_eq!(
        bridge.try_query_fee_bps(),
        Err(Ok(BridgeError::NotInitialized))
    );
}

#[test]
fn test_pause_and_unpause() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);

    assert!(!bridge.query_is_paused());

    bridge.pause();
    assert!(bridge.query_is_paused());

    bridge.unpause();
    assert!(!bridge.query_is_paused());
}

#[test]
fn test_fund_c_address_paused() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause();

    let target = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_batch_fund_paused() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause();

    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target.clone()]);
    let amounts = Vec::from_array(&env, [500i128]);
    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_withdraw_fees_paused() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32);
    mint_tokens(&env, &token_id, &user, 1000i128);
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128);
    bridge.pause();

    assert_eq!(
        bridge.try_withdraw_fees(&token_id, &5i128),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_set_fee_bps_paused() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    bridge.pause();
    assert_eq!(
        bridge.try_set_fee_bps(&100u32),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_set_fee_collector_paused() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    bridge.pause();
    assert_eq!(
        bridge.try_set_fee_collector(&Address::generate(&env)),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_set_admin_paused() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    bridge.pause();
    assert_eq!(
        bridge.try_set_admin(&Address::generate(&env)),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_view_functions_work_when_paused() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &50u32);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause();

    assert_eq!(bridge.query_fee_bps(), 50u32);
    assert_eq!(bridge.query_fee_collector(), fee_collector);
    assert_eq!(bridge.query_admin(), admin);
    assert!(bridge.query_is_initialized());
    assert!(bridge.query_is_paused());
    assert_eq!(bridge.query_balance(&user, &token_id), 1000i128);
}

#[test]
fn test_pause_emits_event() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    bridge.pause();

    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

#[test]
fn test_unpause_emits_event() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    bridge.pause();
    bridge.unpause();

    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

#[test]
fn test_fund_works_after_unpause() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause();
    bridge.unpause();

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128);

    assert_eq!(check_balance(&env, &token_id, &target), 495i128);
}

// The soroban-sdk ships a known-good compiled wasm fixture used for doc/unit
// tests. We reuse it here as our "v2" wasm to get a real BytesN<32> hash that
// the host accepts, so we can exercise the full auth → wasm-swap → event path.
const V2_WASM: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../target/wasm32-unknown-unknown/release/onboarding_bridge.wasm"
));

#[test]
fn test_upgrade_admin_only_and_event() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    env.mock_all_auths();

    bridge.initialize(&admin, &fee_collector, &50u32);

    let wasm_bytes = Bytes::from_slice(&env, V2_WASM);
    let wasm_hash: BytesN<32> = env.deployer().upload_contract_wasm(wasm_bytes);

    bridge.upgrade(&wasm_hash);

    // Verify the Upgraded event was emitted from the bridge contract.
    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

#[test]
#[should_panic]
fn test_upgrade_non_admin_rejected() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let bridge_id = env.register(OnboardingBridge, ());
    env.mock_all_auths();
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);

    let wasm_bytes = Bytes::from_slice(&env, V2_WASM);
    let wasm_hash: BytesN<32> = env.deployer().upload_contract_wasm(wasm_bytes);

    // Clear all mocked auths so upgrade is called without admin authorization.
    use soroban_sdk::xdr::SorobanAuthorizationEntry;
    env.set_auths(&[] as &[SorobanAuthorizationEntry]);
    bridge.upgrade(&wasm_hash);
}

/********** Minimal Test Token **********/

#[contracttype]
pub enum TDataKey {
    Admin,
    Decimal,
    Name,
    Symbol,
    Initialized,
    Balance,
}

#[contract]
pub struct TestToken;

#[contractimpl]
impl TestToken {
    pub fn initialize(
        e: Env,
        admin: Address,
        decimal: u32,
        name: soroban_sdk::String,
        symbol: soroban_sdk::String,
    ) {
        e.storage().instance().set(&TDataKey::Admin, &admin);
        e.storage().instance().set(&TDataKey::Decimal, &decimal);
        e.storage().instance().set(&TDataKey::Name, &name);
        e.storage().instance().set(&TDataKey::Symbol, &symbol);
        e.storage().instance().set(&TDataKey::Initialized, &true);
    }

    pub fn mint(e: Env, to: Address, amount: i128) {
        let admin: Address = e.storage().instance().get(&TDataKey::Admin).unwrap();
        admin.require_auth();
        let bal = Self::balance(e.clone(), to.clone());
        e.storage()
            .persistent()
            .set(&(TDataKey::Balance, to), &(bal + amount));
    }

    pub fn balance(e: Env, id: Address) -> i128 {
        e.storage()
            .persistent()
            .get(&(TDataKey::Balance, id))
            .unwrap_or(0)
    }

    pub fn transfer(e: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let from_bal = Self::balance(e.clone(), from.clone());
        if from_bal < amount {
            panic!("insufficient balance");
        }
        let to_bal = Self::balance(e.clone(), to.clone());
        e.storage()
            .persistent()
            .set(&(TDataKey::Balance, from), &(from_bal - amount));
        e.storage()
            .persistent()
            .set(&(TDataKey::Balance, to), &(to_bal + amount));
    }
}
