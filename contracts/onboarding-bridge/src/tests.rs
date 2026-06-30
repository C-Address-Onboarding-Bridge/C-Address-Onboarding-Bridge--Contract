use crate::{BridgeError, OnboardingBridge};

use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::{Address as _, Events, Ledger},
    Address, Bytes, BytesN, Env, IntoVal, Vec,
};

fn register_all_contracts(env: &Env) -> (Address, Address) {
    let bridge_id = env.register(OnboardingBridge, ());
    let token_id = env.register(TestToken, ());
    (bridge_id, token_id)
}

fn register_all_contracts_mocked(env: &Env) -> (Address, Address) {
    env.mock_all_auths();
    register_all_contracts(env)
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
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    assert_eq!(bridge.query_fee_bps(), 50u32);
    assert_eq!(bridge.query_fee_collector(), fee_collector);
    assert_eq!(bridge.query_admin(), admin);
    assert!(bridge.query_is_initialized());
}

#[test]
fn test_initialize_twice() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    assert_eq!(
        bridge.try_initialize(&admin, &fee_collector, &50u32, &None),
        Err(Ok(BridgeError::AlreadyInitialized))
    );
}

#[test]
fn test_initialize_fee_too_high() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    assert_eq!(
        bridge.try_initialize(&admin, &fee_collector, &2000u32, &None),
        Err(Ok(BridgeError::FeeTooHigh))
    );
}

#[test]
fn test_fund_c_address() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);

    assert_eq!(check_balance(&env, &token_id, &user), 500i128);
    assert_eq!(check_balance(&env, &token_id, &target), 495i128);
    assert_eq!(check_balance(&env, &token_id, &fee_collector), 0i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 5i128);
}

#[test]
fn test_fund_without_initialize() {
    let env = Env::default();
    let (_admin, user, _fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&Address::generate(&env), &Address::generate(&env), &50u32, &None);

    let b2_id = env.register(OnboardingBridge, ());
    let b2 = crate::OnboardingBridgeClient::new(&env, &b2_id);
    let target = Address::generate(&env);
    assert_eq!(
        b2.try_fund_c_address(&user, &target, &token_id, &100i128, &None, &None),
        Err(Ok(BridgeError::NotInitialized))
    );
}

#[test]
fn test_batch_fund_c_addresses() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 3000i128);

    let target1 = Address::generate(&env);
    let target2 = Address::generate(&env);
    let targets = Vec::from_array(&env, [target1.clone(), target2.clone()]);
    let amounts = Vec::from_array(&env, [1000i128, 500i128]);

    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

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
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &0u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);

    assert_eq!(check_balance(&env, &token_id, &user), 500i128);
    assert_eq!(check_balance(&env, &token_id, &target), 500i128);
    assert_eq!(check_balance(&env, &token_id, &fee_collector), 0i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 0i128);
}

#[test]
fn test_set_fee_bps() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    assert_eq!(bridge.query_fee_bps(), 50u32);

    bridge.set_fee_bps(&200u32, &None);
    assert_eq!(bridge.query_fee_bps(), 200u32);
}

#[test]
fn test_set_fee_bps_too_high() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    assert_eq!(
        bridge.try_set_fee_bps(&2000u32, &None),
        Err(Ok(BridgeError::FeeTooHigh))
    );
}

#[test]
fn test_set_fee_collector() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    let new_collector = Address::generate(&env);
    bridge.set_fee_collector(&new_collector, &None);
    assert_eq!(bridge.query_fee_collector(), new_collector);
}

#[test]
fn test_set_admin() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    let new_admin = Address::generate(&env);
    bridge.set_admin(&new_admin, &None);
    assert_eq!(bridge.query_admin(), new_admin);
}

#[test]
fn test_withdraw_fees() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);

    assert_eq!(check_balance(&env, &token_id, &fee_collector), 0i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 5i128);

    bridge.withdraw_fees(&token_id, &5i128, &None);

    assert_eq!(check_balance(&env, &token_id, &fee_collector), 5i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 0i128);
}

#[test]
fn test_query_balance() {
    let env = Env::default();
    let (admin, user, _fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &Address::generate(&env), &0u32, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let bal = bridge.query_balance(&user, &token_id);
    assert_eq!(bal, 1000i128);
}

#[test]
fn test_batch_empty() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    let token_id = Address::generate(&env);
    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    let targets: Vec<Address> = Vec::new(&env);
    let amounts: Vec<i128> = Vec::new(&env);

    bridge.batch_fund_c_address(&admin, &targets, &amounts, &token_id, &None, &None);
}

#[test]
fn test_fund_events() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);

    let events = env.events().all();
    assert!(events.len() > 0);

    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

#[test]
fn test_query_fee_bps_uninitialized() {
    let env = Env::default();
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    assert_eq!(
        bridge.try_query_fee_bps(),
        Err(Ok(BridgeError::NotInitialized))
    );
}

/********** Pause / Upgrade tests **********/

#[test]
fn test_pause_and_unpause() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    assert!(!bridge.query_is_paused());

    bridge.pause(&None);
    assert!(bridge.query_is_paused());

    bridge.unpause(&None);
    assert!(!bridge.query_is_paused());
}

#[test]
fn test_fund_c_address_paused() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause(&None);

    let target = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None, &None),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_batch_fund_paused() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause(&None);

    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target.clone()]);
    let amounts = Vec::from_array(&env, [500i128]);
    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_withdraw_fees_paused() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);
    bridge.pause(&None);

    assert_eq!(
        bridge.try_withdraw_fees(&token_id, &5i128, &None),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_set_fee_bps_paused() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.pause(&None);
    assert_eq!(
        bridge.try_set_fee_bps(&100u32, &None),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_set_fee_collector_paused() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.pause(&None);
    assert_eq!(
        bridge.try_set_fee_collector(&Address::generate(&env), &None),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_set_admin_paused() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.pause(&None);
    assert_eq!(
        bridge.try_set_admin(&Address::generate(&env), &None),
        Err(Ok(BridgeError::ContractPaused))
    );
}

#[test]
fn test_view_functions_work_when_paused() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause(&None);

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
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.pause(&None);

    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

#[test]
fn test_unpause_emits_event() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.pause(&None);
    bridge.unpause(&None);

    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

#[test]
fn test_fund_works_after_unpause() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause(&None);
    bridge.unpause(&None);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);

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
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    env.mock_all_auths();

    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    let wasm_bytes = Bytes::from_slice(&env, V2_WASM);
    let wasm_hash: BytesN<32> = env.deployer().upload_contract_wasm(wasm_bytes);

    bridge.upgrade(&wasm_hash, &None);

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

    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    let wasm_bytes = Bytes::from_slice(&env, V2_WASM);
    let wasm_hash: BytesN<32> = env.deployer().upload_contract_wasm(wasm_bytes);

    // Clear all mocked auths so upgrade is called without admin authorization.
    use soroban_sdk::xdr::SorobanAuthorizationEntry;
    env.set_auths(&[] as &[SorobanAuthorizationEntry]);
    bridge.upgrade(&wasm_hash, &None);
}

// --------- Blocklist / Allowlist Tests ---------

fn setup_bridge(env: &Env) -> (crate::OnboardingBridgeClient<'_>, Address, Address, Address) {
    let (bridge_id, token_id) = register_all_contracts_mocked(env);
    let bridge = create_bridge_client(env, &bridge_id);
    let (admin, user, fee_collector) = create_test_users(env);
    init_token(env, &token_id, &admin);
    bridge.initialize(&admin, &fee_collector, &0u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(env, &token_id, &user, 1000i128);
    (bridge, user, token_id, admin)
}

#[test]
fn test_blocklist_prevents_fund() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.add_to_blocklist(&target, &None);
    assert!(bridge.query_is_blocked(&target));

    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None, &None),
        Err(Ok(crate::BridgeError::AddressBlocked))
    );
}

#[test]
fn test_remove_from_blocklist_allows_fund() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.add_to_blocklist(&target, &None);
    bridge.remove_from_blocklist(&target, &None);
    assert!(!bridge.query_is_blocked(&target));

    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);
    assert_eq!(check_balance(&env, &token_id, &target), 500i128);
}

#[test]
fn test_allowlist_mode_blocks_non_allowlisted() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.set_allowlist_mode(&true, &None);
    assert!(bridge.query_allowlist_mode());

    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None, &None),
        Err(Ok(crate::BridgeError::AddressNotAllowlisted))
    );
}

#[test]
fn test_allowlist_mode_allows_allowlisted() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.set_allowlist_mode(&true, &None);
    bridge.add_to_allowlist(&target, &None);
    assert!(bridge.query_is_allowlisted(&target));

    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);
    assert_eq!(check_balance(&env, &token_id, &target), 500i128);
}

#[test]
fn test_remove_from_allowlist_blocks_in_allowlist_mode() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.set_allowlist_mode(&true, &None);
    bridge.add_to_allowlist(&target, &None);
    bridge.remove_from_allowlist(&target, &None);
    assert!(!bridge.query_is_allowlisted(&target));

    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None, &None),
        Err(Ok(crate::BridgeError::AddressNotAllowlisted))
    );
}

#[test]
fn test_blocklist_overrides_allowlist() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.set_allowlist_mode(&true, &None);
    bridge.add_to_allowlist(&target, &None);
    bridge.add_to_blocklist(&target, &None);

    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None, &None),
        Err(Ok(crate::BridgeError::AddressBlocked))
    );
}

#[test]
fn test_batch_fund_blocked_address_fails() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let t1 = Address::generate(&env);
    let t2 = Address::generate(&env);

    bridge.add_to_blocklist(&t2, &None);

    let targets = Vec::from_array(&env, [t1.clone(), t2.clone()]);
    let amounts = Vec::from_array(&env, [200i128, 300i128]);

    // batch_fund_c_address skips blocked targets (refunding their amount) rather than failing.
    // t1 succeeds, t2 is blocked and refunded to source.
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);
    assert_eq!(check_balance(&env, &token_id, &t2), 0i128);
}

#[test]
fn test_allowlist_mode_off_allows_all() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    // allowlist mode off by default
    assert!(!bridge.query_allowlist_mode());
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);
    assert_eq!(check_balance(&env, &token_id, &target), 500i128);
}

// --------- reclaim_tokens Tests ---------

#[test]
fn test_reclaim_accidentally_sent_tokens() {
    let env = Env::default();
    let (bridge, _user, token_id, admin) = setup_bridge(&env);

    // Directly mint tokens to bridge (simulating accidental transfer, no fees accrued)
    mint_tokens(&env, &token_id, &bridge.address, 500i128);

    let destination = Address::generate(&env);
    bridge.reclaim_tokens(&token_id, &500i128, &destination, &None);

    assert_eq!(check_balance(&env, &token_id, &destination), 500i128);
    let _ = admin; // suppress unused warning
}

#[test]
fn test_reclaim_cannot_take_accrued_fees() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);

    // Fund so fees (10%) accrue in contract
    bridge.set_fee_bps(&1000u32, &None); // 10%
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &1000i128, &None, &None);
    // contract now holds 100 in accrued fees, 0 reclaimable

    let destination = Address::generate(&env);
    assert_eq!(
        bridge.try_reclaim_tokens(&token_id, &1i128, &destination, &None),
        Err(Ok(crate::BridgeError::InsufficientReclaimable))
    );
}

#[test]
fn test_reclaim_only_excess_over_fees() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);

    bridge.set_fee_bps(&1000u32, &None); // 10%
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &1000i128, &None, &None);
    // 100 accrued fees in contract; mint 200 more directly
    mint_tokens(&env, &token_id, &bridge.address, 200i128);

    let destination = Address::generate(&env);
    // Can reclaim exactly 200 (the excess)
    bridge.reclaim_tokens(&token_id, &200i128, &destination, &None);
    assert_eq!(check_balance(&env, &token_id, &destination), 200i128);

    // Cannot reclaim 1 more
    let dest2 = Address::generate(&env);
    assert_eq!(
        bridge.try_reclaim_tokens(&token_id, &1i128, &dest2, &None),
        Err(Ok(crate::BridgeError::InsufficientReclaimable))
    );
}

#[test]
fn test_reclaim_emits_event() {
    let env = Env::default();
    let (bridge, _user, token_id, _admin) = setup_bridge(&env);

    mint_tokens(&env, &token_id, &bridge.address, 300i128);
    let destination = Address::generate(&env);
    bridge.reclaim_tokens(&token_id, &300i128, &destination, &None);

    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge.address);
}

/********** Asset whitelist tests **********/

#[test]
fn test_add_asset_whitelists_it() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    assert_eq!(bridge.query_is_asset_whitelisted(&token_id), false);

    bridge.add_asset(&token_id, &None);
    assert_eq!(bridge.query_is_asset_whitelisted(&token_id), true);
}

#[test]
fn test_remove_asset() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.add_asset(&token_id, &None);
    assert_eq!(bridge.query_is_asset_whitelisted(&token_id), true);

    bridge.remove_asset(&token_id, &None);
    assert_eq!(bridge.query_is_asset_whitelisted(&token_id), false);
}

#[test]
fn test_query_whitelisted_assets() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    let asset1 = Address::generate(&env);
    let asset2 = Address::generate(&env);
    bridge.add_asset(&asset1, &None);
    bridge.add_asset(&asset2, &None);

    let assets = bridge.query_whitelisted_assets();
    assert_eq!(assets.len(), 2);

    let mut found1 = false;
    let mut found2 = false;
    for a in assets.iter() {
        if a == asset1 {
            found1 = true;
        }
        if a == asset2 {
            found2 = true;
        }
    }
    assert!(found1 && found2);
}

#[test]
fn test_add_asset_is_idempotent() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.add_asset(&token_id, &None);
    bridge.add_asset(&token_id, &None);

    assert_eq!(bridge.query_whitelisted_assets().len(), 1);
}

#[test]
#[should_panic]
fn test_add_asset_non_admin_rejected() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    env.set_auths(&[]);
    bridge.add_asset(&token_id, &None);
}

#[test]
#[should_panic]
fn test_remove_asset_non_admin_rejected() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.add_asset(&token_id, &None);

    env.set_auths(&[]);
    bridge.remove_asset(&token_id, &None);
}

#[test]
fn test_whitelist_query_uninitialized() {
    let env = Env::default();
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    assert_eq!(
        bridge.try_query_is_asset_whitelisted(&token_id),
        Err(Ok(BridgeError::NotInitialized))
    );
}

#[test]
fn test_fund_rejects_non_whitelisted_asset() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None, &None),
        Err(Ok(BridgeError::AssetNotWhitelisted))
    );
}

#[test]
fn test_batch_fund_rejects_non_whitelisted_asset() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    mint_tokens(&env, &token_id, &user, 3000i128);

    let target1 = Address::generate(&env);
    let targets = Vec::from_array(&env, [target1]);
    let amounts = Vec::from_array(&env, [1000i128]);

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None),
        Err(Ok(BridgeError::AssetNotWhitelisted))
    );
}

/********** query_all_balances Tests **********/

#[test]
fn test_query_all_balances_returns_contract_balances() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);
    bridge.initialize(&admin, &fee_collector, &0u32, &None);

    // Mint directly to the bridge contract
    mint_tokens(&env, &token_id, &bridge_id, 750i128);

    let assets = Vec::from_array(&env, [token_id.clone()]);
    let balances = bridge.query_all_balances(&assets);

    assert_eq!(balances.get(token_id).unwrap(), 750i128);
}

#[test]
fn test_query_all_balances_empty_input() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    bridge.initialize(&admin, &fee_collector, &0u32, &None);

    let assets: Vec<Address> = Vec::new(&env);
    let balances = bridge.query_all_balances(&assets);
    assert_eq!(balances.len(), 0);
}

#[test]
fn test_accrued_fees_single_deposit() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);

    // 500 * 100 / 10000 = 5
    assert_eq!(bridge.query_accrued_fees(&token_id), 5i128);
}

#[test]
fn test_accrued_fees_accumulate_across_deposits() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 3000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None); // fee = 5
    bridge.fund_c_address(&user, &target, &token_id, &1000i128, &None, &None); // fee = 10

    assert_eq!(bridge.query_accrued_fees(&token_id), 15i128);
}

#[test]
fn test_accrued_fees_batch_accumulate() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 3000i128);

    let target1 = Address::generate(&env);
    let target2 = Address::generate(&env);
    let targets = Vec::from_array(&env, [target1.clone(), target2.clone()]);
    let amounts = Vec::from_array(&env, [1000i128, 500i128]);

    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    // 1000*100/10000 + 500*100/10000 = 10 + 5 = 15
    assert_eq!(bridge.query_accrued_fees(&token_id), 15i128);
}

#[test]
fn test_withdraw_fees_decrements_accrued() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None); // accrued = 5

    bridge.withdraw_fees(&token_id, &3i128, &None);

    assert_eq!(bridge.query_accrued_fees(&token_id), 2i128);
    assert_eq!(check_balance(&env, &token_id, &fee_collector), 3i128);
}

#[test]
fn test_withdraw_fees_exceeds_accrued() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None); // accrued = 5

    assert_eq!(
        bridge.try_withdraw_fees(&token_id, &6i128, &None),
        Err(Ok(BridgeError::InsufficientReclaimable))
    );
}

#[test]
fn test_zero_fee_no_accrued_entry() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &0u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);

    assert_eq!(bridge.query_accrued_fees(&token_id), 0i128);
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
        if from == to {
            return;
        }
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

mod swap_pool_contract {
    use super::*;

    #[contracttype]
    pub enum SwapPoolDataKey {
        InputToken,
        OutputToken,
        Rate,
    }

    #[contract]
    pub struct SwapPool;

    #[contractimpl]
    impl SwapPool {
        pub fn initialize(e: Env, input_token: Address, output_token: Address, rate: i128) {
            e.storage().instance().set(&SwapPoolDataKey::InputToken, &input_token);
            e.storage().instance().set(&SwapPoolDataKey::OutputToken, &output_token);
            e.storage().instance().set(&SwapPoolDataKey::Rate, &rate);
        }

        pub fn swap(e: Env, min_amount_out: i128, to: Address) -> i128 {
            let rate: i128 = e.storage().instance().get(&SwapPoolDataKey::Rate).unwrap();
            let input_token: Address = e.storage().instance().get(&SwapPoolDataKey::InputToken).unwrap();
            let input_token_client = soroban_sdk::token::Client::new(&e, &input_token);
            let amount_in = input_token_client.balance(&e.current_contract_address());
            let amount_out = amount_in.checked_mul(rate).unwrap_or(0);
            if amount_out < min_amount_out {
                return amount_out;
            }
            let output_token: Address = e.storage().instance().get(&SwapPoolDataKey::OutputToken).unwrap();
            let output_token_client = soroban_sdk::token::Client::new(&e, &output_token);
            output_token_client.transfer(&e.current_contract_address(), &to, &amount_out);
            amount_out
        }
    }
}

use swap_pool_contract::{SwapPool, SwapPoolClient};

/********** query_calculate_fee tests **********/

#[test]
fn test_query_calculate_fee() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);

    let (fee, net) = bridge.query_calculate_fee(&1000i128);
    assert_eq!(fee, 10i128);
    assert_eq!(net, 990i128);
}

#[test]
fn test_query_calculate_fee_zero_fee() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &0u32, &None);

    let (fee, net) = bridge.query_calculate_fee(&1000i128);
    assert_eq!(fee, 0i128);
    assert_eq!(net, 1000i128);
}

#[test]
fn test_query_calculate_fee_max_fee() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &1000u32, &None);

    let (fee, net) = bridge.query_calculate_fee(&1000i128);
    assert_eq!(fee, 100i128);
    assert_eq!(net, 900i128);
}

/********** cumulative counters tests **********/

#[test]
fn test_query_total_bridged_and_fees_collected() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);

    let total_bridged = bridge.query_total_bridged(&token_id);
    let total_fees = bridge.query_total_fees_collected(&token_id);

    assert_eq!(total_bridged, 495i128);
    assert_eq!(total_fees, 5i128);
}

#[test]
fn test_query_total_bridged_accumulates() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 5000i128);

    let target1 = Address::generate(&env);
    let target2 = Address::generate(&env);

    bridge.fund_c_address(&user, &target1, &token_id, &1000i128, &None, &None);
    bridge.fund_c_address(&user, &target2, &token_id, &1000i128, &None, &None);

    let total_bridged = bridge.query_total_bridged(&token_id);
    let total_fees = bridge.query_total_fees_collected(&token_id);

    assert_eq!(total_bridged, 1990i128);
    assert_eq!(total_fees, 10i128);
}

#[test]
fn test_query_total_bridged_batch() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 3000i128);

    let target1 = Address::generate(&env);
    let target2 = Address::generate(&env);
    let targets = Vec::from_array(&env, [target1, target2]);
    let amounts = Vec::from_array(&env, [1000i128, 500i128]);

    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    let total_bridged = bridge.query_total_bridged(&token_id);
    let total_fees = bridge.query_total_fees_collected(&token_id);

    assert_eq!(total_bridged, 1485i128);
    assert_eq!(total_fees, 15i128);
}

#[test]
fn test_query_total_bridged_zero() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    let total_bridged = bridge.query_total_bridged(&token_id);
    let total_fees = bridge.query_total_fees_collected(&token_id);

    assert_eq!(total_bridged, 0i128);
    assert_eq!(total_fees, 0i128);
}

/********** admin state change events tests **********/

#[test]
fn test_initialize_emits_event() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

#[test]
fn test_fee_bps_changed_emits_event() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.set_fee_bps(&100u32, &None);

    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

#[test]
fn test_fee_collector_changed_emits_event() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    let new_collector = Address::generate(&env);
    bridge.set_fee_collector(&new_collector, &None);

    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

#[test]
fn test_admin_changed_emits_event() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    let new_admin = Address::generate(&env);
    bridge.set_admin(&new_admin, &None);

    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

// --------- batch_fund_c_address edge case tests ---------

fn setup_batch(env: &Env) -> (crate::OnboardingBridgeClient<'_>, Address, Address, Address) {
    let (bridge_id, token_id) = register_all_contracts_mocked(env);
    let bridge = create_bridge_client(env, &bridge_id);
    let (admin, user, fee_collector) = create_test_users(env);
    init_token(env, &token_id, &admin);
    bridge.initialize(&admin, &fee_collector, &100u32, &None); // 1% fee
    bridge.add_asset(&token_id, &None);
    mint_tokens(env, &token_id, &user, 1_000_000i128);
    (bridge, user, token_id, admin)
}

/// Helper: count events from bridge with a given topic string prefix.
fn count_events_with_topic(env: &Env, bridge_id: &Address, topic: &str) -> u32 {
    use soroban_sdk::{IntoVal, String as SStr, TryFromVal, Val};
    let topic_val: Val = topic.into_val(env);
    let topic_str: SStr = SStr::try_from_val(env, &topic_val).unwrap();
    let mut count = 0u32;
    for event in env.events().all().iter() {
        let (cid, topics, _) = event;
        if cid == *bridge_id && topics.len() > 0 {
            if let Some(t) = topics.get(0) {
                if let Ok(s) = SStr::try_from_val(env, &t) {
                    if s == topic_str {
                        count += 1;
                    }
                }
            }
        }
    }
    count
}

/// Empty targets array — returns Ok immediately, no BatchCompleted event.
#[test]
fn test_batch_empty_array_no_events() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);
    let event_count_before = env.events().all().len();

    let targets: Vec<Address> = Vec::new(&env);
    let amounts: Vec<i128> = Vec::new(&env);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    // No new events emitted — the contract returns early before even emitting BatchCompleted.
    assert_eq!(env.events().all().len(), event_count_before);
    // Source balance unchanged.
    assert_eq!(check_balance(&env, &token_id, &user), 1_000_000i128);
}

/// Single target — boundary case; correct fee and CAddressFunded + BatchCompleted events.
#[test]
fn test_batch_single_target() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);
    let bridge_id = bridge.address.clone();

    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target.clone()]);
    let amounts = Vec::from_array(&env, [1000i128]);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    // Check events BEFORE any additional contract calls that may reset the event log.
    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 1);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);

    assert_eq!(check_balance(&env, &token_id, &target), 990i128); // 1% fee
    assert_eq!(check_balance(&env, &token_id, &user), 999_000i128);
}

/// Duplicate target addresses — each entry is processed independently.
#[test]
fn test_batch_duplicate_targets() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);
    let bridge_id = bridge.address.clone();

    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target.clone(), target.clone(), target.clone()]);
    let amounts = Vec::from_array(&env, [1000i128, 2000i128, 3000i128]);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 3);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
    // Net: 990 + 1980 + 2970 = 5940
    assert_eq!(check_balance(&env, &token_id, &target), 5940i128);
}

/// Target is same as source — source receives net amount back (self-fund).
#[test]
fn test_batch_target_is_source() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);
    let bridge_id = bridge.address.clone();

    // user sends 1000 to themselves; they pay fee, so net back is 990.
    let targets = Vec::from_array(&env, [user.clone()]);
    let amounts = Vec::from_array(&env, [1000i128]);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 1);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
    // Started with 1_000_000. Paid 1000, received 990. Net: 999_990.
    assert_eq!(check_balance(&env, &token_id, &user), 999_990i128);
}

/// Target is the contract itself — contract receives the net amount.
#[test]
fn test_batch_target_is_contract() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);
    let bridge_id = bridge.address.clone();

    let targets = Vec::from_array(&env, [bridge_id.clone()]);
    let amounts = Vec::from_array(&env, [1000i128]);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 1);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
    // Contract should hold 1000 total (990 transferred to itself as target + 10 accrued fee).
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 1000i128);
}

/// Zero amount in array — rejected with InvalidAmount before any transfer.
#[test]
fn test_batch_zero_amount_rejected() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);

    let t1 = Address::generate(&env);
    let t2 = Address::generate(&env);
    let targets = Vec::from_array(&env, [t1.clone(), t2.clone()]);
    let amounts = Vec::from_array(&env, [500i128, 0i128]);

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None),
        Err(Ok(BridgeError::InvalidAmount))
    );
    // No tokens moved — user balance intact.
    assert_eq!(check_balance(&env, &token_id, &user), 1_000_000i128);
    assert_eq!(check_balance(&env, &token_id, &t1), 0i128);
}

/// Negative amount in array — also rejected as InvalidAmount.
#[test]
fn test_batch_negative_amount_rejected() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);

    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target]);
    let amounts = Vec::from_array(&env, [-1i128]);

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None),
        Err(Ok(BridgeError::InvalidAmount))
    );
    assert_eq!(check_balance(&env, &token_id, &user), 1_000_000i128);
}

/// Fee causes net_amount == 0 — transfer is skipped, fee still accrues.
/// At 1000 bps (10%), an amount of 9 → fee=0 (rounds down), net=9, transfer happens.
/// At 1000 bps, amount=1 → fee=0 (1*1000/10000 = 0), net=1.
/// To get net==0 we need fee_bps=10000 which exceeds max. Instead, use fee_bps=1000 and
/// amount=1: fee = 1*1000/10000 = 0, net = 1. Can't get net=0 with valid fee_bps.
/// The contract MAX_FEE_BPS is 1000 (10%), so with amount=1: fee=0, net=1.
/// With amount=9 and fee_bps=1000: fee=0, net=9.
/// The only way net rounds to 0 is if the math rounds to exactly amount.
/// This is mathematically impossible with fee_bps <= 1000 for integer amount >= 1.
/// Test documents this invariant: net is always > 0 for any valid input.
#[test]
fn test_batch_fee_never_produces_zero_net_within_max_fee_bps() {
    let env = Env::default();
    let (bridge, user, token_id, admin) = setup_batch(&env);
    let bridge_id = bridge.address.clone();

    // Set max fee 1000 bps (10%).
    bridge.set_fee_bps(&1000u32, &None);

    // Amount=1: fee = 1*1000/10000 = 0, net = 1. Transfer happens.
    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target.clone()]);
    let amounts = Vec::from_array(&env, [1i128]);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 1);
    assert_eq!(check_balance(&env, &token_id, &target), 1i128);
    let _ = admin;
}

/// Mismatched arrays — rejected with MismatchedArrays.
#[test]
fn test_batch_mismatched_arrays() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);

    let t1 = Address::generate(&env);
    let targets = Vec::from_array(&env, [t1]);
    let amounts = Vec::from_array(&env, [500i128, 300i128]);

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None),
        Err(Ok(BridgeError::MismatchedArrays))
    );
}

/// Blocked target in batch — that entry is skipped and refunded, others succeed.
/// BatchTransferFailed emitted for the blocked one, CAddressFunded for successful ones,
/// BatchCompleted at the end reflecting counts.
#[test]
fn test_batch_blocked_target_skipped_and_refunded() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);
    let bridge_id = bridge.address.clone();

    let good = Address::generate(&env);
    let blocked = Address::generate(&env);
    bridge.add_to_blocklist(&blocked, &None);

    let targets = Vec::from_array(&env, [good.clone(), blocked.clone()]);
    let amounts = Vec::from_array(&env, [1000i128, 500i128]);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 1);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchTransferFailed"), 1);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
    // Good target receives net amount (1% fee on 1000 = 990).
    assert_eq!(check_balance(&env, &token_id, &good), 990i128);
    // Blocked target receives nothing; 500 refunded to source.
    assert_eq!(check_balance(&env, &token_id, &blocked), 0i128);
    // Source paid 1500 total, got 500 back: net cost 1000.
    assert_eq!(check_balance(&env, &token_id, &user), 999_000i128);
}

/// All targets blocked — all refunded, only BatchTransferFailed + BatchCompleted emitted.
#[test]
fn test_batch_all_blocked_full_refund() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);
    let bridge_id = bridge.address.clone();

    let t1 = Address::generate(&env);
    let t2 = Address::generate(&env);
    bridge.add_to_blocklist(&t1, &None);
    bridge.add_to_blocklist(&t2, &None);

    let targets = Vec::from_array(&env, [t1.clone(), t2.clone()]);
    let amounts = Vec::from_array(&env, [400i128, 600i128]);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);

    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 0);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchTransferFailed"), 2);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
    // Full refund — source balance unchanged.
    assert_eq!(check_balance(&env, &token_id, &user), 1_000_000i128);
    assert_eq!(check_balance(&env, &token_id, &t1), 0i128);
    assert_eq!(check_balance(&env, &token_id, &t2), 0i128);
}

/// Large batch (100 targets) — verifies all succeed, correct event count, correct balances.
#[test]
fn test_batch_100_targets() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);
    let bridge_id = bridge.address.clone();

    // Give user enough tokens: 100 * 1000 = 100_000.
    mint_tokens(&env, &token_id, &user, 100_000i128);

    let mut targets_vec = Vec::new(&env);
    let mut amounts_vec = Vec::new(&env);
    let mut target_addrs: soroban_sdk::Vec<Address> = Vec::new(&env);
    for _ in 0..100 {
        let t = Address::generate(&env);
        target_addrs.push_back(t.clone());
        targets_vec.push_back(t);
        amounts_vec.push_back(1000i128);
    }

    bridge.batch_fund_c_address(&user, &targets_vec, &amounts_vec, &token_id, &None, &None);

    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 100);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
    // Each target receives 990 (1% fee on 1000).
    for i in 0..100 {
        assert_eq!(check_balance(&env, &token_id, &target_addrs.get(i).unwrap()), 990i128);
    }
    // Source spent 100_000 tokens from the extra mint.
    assert_eq!(check_balance(&env, &token_id, &user), 1_000_000i128); // original unchanged
}

/// Batches larger than MAX_BATCH_SIZE (100) must be rejected.
#[test]
fn test_batch_exceeds_max_size() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);

    let mut targets: Vec<Address> = Vec::new(&env);
    let mut amounts: Vec<i128> = Vec::new(&env);
    for _ in 0..101 {
        targets.push_back(Address::generate(&env));
        amounts.push_back(1i128);
    }

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None),
        Err(Ok(BridgeError::InvalidAmount))
    );
    assert_eq!(check_balance(&env, &token_id, &user), 1_000_000i128);
}

/********** Nonce tests **********/

#[test]
fn test_nonce_starts_at_zero() {
    let env = Env::default();
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    let caller = Address::generate(&env);
    assert_eq!(bridge.query_nonce(&caller), 0u64);
}

#[test]
fn test_nonce_increments_on_use() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);

    assert_eq!(bridge.query_nonce(&user), 0u64);

    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target]);
    let amounts = Vec::from_array(&env, [100i128]);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &Some(0u64), &None);

    assert_eq!(bridge.query_nonce(&user), 1u64);
}

#[test]
fn test_nonce_replay_rejected() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);

    let target1 = Address::generate(&env);
    let target2 = Address::generate(&env);
    let targets1 = Vec::from_array(&env, [target1]);
    let targets2 = Vec::from_array(&env, [target2]);
    let amounts = Vec::from_array(&env, [100i128]);

    // First call with nonce=0 succeeds.
    bridge.batch_fund_c_address(&user, &targets1, &amounts, &token_id, &Some(0u64), &None);

    // Replaying nonce=0 rejected.
    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets2, &amounts, &token_id, &Some(0u64), &None),
        Err(Ok(BridgeError::DuplicateNonce))
    );
}

#[test]
fn test_nonce_none_skips_check() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);

    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target]);
    let amounts = Vec::from_array(&env, [100i128]);

    // None skips nonce check; nonce stays at 0.
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None);
    assert_eq!(bridge.query_nonce(&user), 0u64);
}

#[test]
fn test_nonce_wrong_value_rejected() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);

    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target]);
    let amounts = Vec::from_array(&env, [100i128]);

    // Nonce is 0, passing 1 should fail.
    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &Some(1u64), &None),
        Err(Ok(BridgeError::DuplicateNonce))
    );
}

#[test]
fn test_nonce_independent_per_caller() {
    let env = Env::default();
    let (bridge, user, token_id, admin) = setup_batch(&env);

    let user2 = Address::generate(&env);
    mint_tokens(&env, &token_id, &user2, 1_000i128);

    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target]);
    let amounts = Vec::from_array(&env, [100i128]);

    // user uses nonce=0.
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &Some(0u64), &None);
    // user2's nonce is still 0, independent of user's.
    assert_eq!(bridge.query_nonce(&user2), 0u64);
    assert_eq!(bridge.query_nonce(&user), 1u64);
    let _ = admin;
}

#[test]
fn test_fund_c_address_nonce() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &100i128, &Some(0u64), &None);
    assert_eq!(bridge.query_nonce(&user), 1u64);

    // Reuse nonce=0 on fund_c_address rejected.
    let target2 = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target2, &token_id, &100i128, &Some(0u64), &None),
        Err(Ok(BridgeError::DuplicateNonce))
    );
}

/********** Deadline tests **********/

#[test]
fn test_fund_c_address_deadline_none_always_passes() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);
    let target = Address::generate(&env);
    // No deadline — always succeeds regardless of ledger time.
    bridge.fund_c_address(&user, &target, &token_id, &100i128, &None, &None);
    assert_eq!(check_balance(&env, &token_id, &target), 99i128); // 1% fee
}

#[test]
fn test_fund_c_address_deadline_in_future_passes() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let (bridge, user, token_id, _) = setup_batch(&env);
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &100i128, &None, &Some(2000u64));
    assert_eq!(check_balance(&env, &token_id, &target), 99i128);
}

#[test]
fn test_fund_c_address_deadline_exact_passes() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let (bridge, user, token_id, _) = setup_batch(&env);
    let target = Address::generate(&env);
    // deadline == current timestamp: not yet expired (strictly >).
    bridge.fund_c_address(&user, &target, &token_id, &100i128, &None, &Some(1000u64));
    assert_eq!(check_balance(&env, &token_id, &target), 99i128);
}

#[test]
fn test_fund_c_address_deadline_expired_reverts() {
    let env = Env::default();
    env.ledger().set_timestamp(2000);
    let (bridge, user, token_id, _) = setup_batch(&env);
    let target = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &100i128, &None, &Some(1999u64)),
        Err(Ok(BridgeError::TransactionExpired))
    );
    // No tokens moved.
    assert_eq!(check_balance(&env, &token_id, &user), 1_000_000i128);
    assert_eq!(check_balance(&env, &token_id, &target), 0i128);
}

#[test]
fn test_batch_fund_deadline_expired_reverts() {
    let env = Env::default();
    env.ledger().set_timestamp(5000);
    let (bridge, user, token_id, _) = setup_batch(&env);
    let t1 = Address::generate(&env);
    let targets = Vec::from_array(&env, [t1.clone()]);
    let amounts = Vec::from_array(&env, [500i128]);
    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &Some(4999u64)),
        Err(Ok(BridgeError::TransactionExpired))
    );
    assert_eq!(check_balance(&env, &token_id, &user), 1_000_000i128);
    assert_eq!(check_balance(&env, &token_id, &t1), 0i128);
}

#[test]
fn test_batch_fund_deadline_in_future_passes() {
    let env = Env::default();
    env.ledger().set_timestamp(1000);
    let (bridge, user, token_id, _) = setup_batch(&env);
    let t1 = Address::generate(&env);
    let targets = Vec::from_array(&env, [t1.clone()]);
    let amounts = Vec::from_array(&env, [1000i128]);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &Some(9999u64));
    assert_eq!(check_balance(&env, &token_id, &t1), 990i128); // 1% fee
}

/********** Timelocked funding tests **********/

#[cfg(test)]
mod timelocked_tests {
    use super::*;

    fn setup_timelocked(env: &Env) -> (
        crate::OnboardingBridgeClient<'_>,
        Address,
        Address,
        Address,
        Address,
    ) {
        let (bridge_id, token_id) = register_all_contracts_mocked(env);
        let bridge = create_bridge_client(env, &bridge_id);
        let (admin, user, fee_collector) = create_test_users(env);
        init_token(env, &token_id, &admin);
        bridge.initialize(&admin, &fee_collector, &100u32, &None); // 1% fee
        bridge.add_asset(&token_id, &None);
        mint_tokens(env, &token_id, &user, 10_000i128);
        (bridge, user, token_id, fee_collector, admin)
    }

    #[test]
    fn test_timelocked_happy_path() {
        let env = Env::default();
        env.ledger().set_timestamp(1_000);
        let (bridge, user, token_id, _fee_collector, _admin) = setup_timelocked(&env);
        let target = Address::generate(&env);
        let release_time = 1_100u64;

        let id = bridge.fund_c_address_timelocked(
            &user,
            &target,
            &token_id,
            &500i128,
            &release_time,
            &0u64,
        );

        env.ledger().set_timestamp(release_time + 1);
        bridge.claim_timelocked(&id);

        assert_eq!(check_balance(&env, &token_id, &target), 495i128);
        assert_eq!(bridge.query_accrued_fees(&token_id), 5i128);
    }

    #[test]
    fn test_timelocked_claim_before_release_fails() {
        let env = Env::default();
        env.ledger().set_timestamp(2_000);
        let (bridge, user, token_id, _fee_collector, _admin) = setup_timelocked(&env);
        let target = Address::generate(&env);

        let id = bridge.fund_c_address_timelocked(
            &user,
            &target,
            &token_id,
            &500i128,
            &(2_100u64),
            &0u64,
        );

        assert_eq!(
            bridge.try_claim_timelocked(&id),
            Err(Ok(BridgeError::TimelockNotMatured))
        );
    }

    #[test]
    fn test_timelocked_cliff_time_after_release_fails() {
        let env = Env::default();
        env.ledger().set_timestamp(3_000);
        let (bridge, user, token_id, _fee_collector, _admin) = setup_timelocked(&env);
        let target = Address::generate(&env);

        assert_eq!(
            bridge.try_fund_c_address_timelocked(
                &user,
                &target,
                &token_id,
                &500i128,
                &3_100u64,
                &3_101u64,
            ),
            Err(Ok(BridgeError::InvalidReleaseTime))
        );
    }

    #[test]
    fn test_timelocked_release_in_past_fails() {
        let env = Env::default();
        env.ledger().set_timestamp(4_000);
        let (bridge, user, token_id, _fee_collector, _admin) = setup_timelocked(&env);
        let target = Address::generate(&env);

        assert_eq!(
            bridge.try_fund_c_address_timelocked(
                &user,
                &target,
                &token_id,
                &500i128,
                &4_000u64,
                &0u64,
            ),
            Err(Ok(BridgeError::InvalidReleaseTime))
        );
    }

    #[test]
    fn test_timelocked_double_claim_fails() {
        let env = Env::default();
        env.ledger().set_timestamp(5_000);
        let (bridge, user, token_id, _fee_collector, _admin) = setup_timelocked(&env);
        let target = Address::generate(&env);
        let release_time = 5_050u64;

        let id = bridge.fund_c_address_timelocked(
            &user,
            &target,
            &token_id,
            &500i128,
            &release_time,
            &0u64,
        );

        env.ledger().set_timestamp(release_time + 1);
        bridge.claim_timelocked(&id);

        assert_eq!(
            bridge.try_claim_timelocked(&id),
            Err(Ok(BridgeError::Unauthorized))
        );
    }

    #[test]
    fn test_query_timelocked_unknown_id_fails() {
        let env = Env::default();
        let (bridge, _user, _token_id, _fee_collector, _admin) = setup_timelocked(&env);

        assert_eq!(
            bridge.try_query_timelocked(&999_999u64),
            Err(Ok(BridgeError::TimelockNotFound))
        );
    }
}

/********** Cross-chain Onboarding Tests **********/

#[cfg(test)]
mod crosschain_tests {
    use super::*;
    use crate::{BridgeError, OnboardingBridge, RelayerSig};
    use ed25519_dalek::{Signer, SigningKey};
    use soroban_sdk::{Bytes, BytesN, Env, Vec};

    fn make_signing_key(seed: [u8; 32]) -> SigningKey {
        SigningKey::from_bytes(&seed)
    }

    /// Replicates the contract's payload hash for a given set of call arguments.
    fn build_payload_hash(
        env: &Env,
        chain_id: u32,
        tx_hash: &BytesN<32>,
        target: &soroban_sdk::Address,
        asset: &soroban_sdk::Address,
        amount: i128,
    ) -> BytesN<32> {
        let tx_hash_bytes: Bytes = tx_hash.clone().into();

        // nonce = sha256(chain_id_be4 || tx_hash)
        let mut nonce_pre = Bytes::new(env);
        nonce_pre.extend_from_array(&chain_id.to_be_bytes());
        nonce_pre.append(&tx_hash_bytes);
        let nonce: BytesN<32> = env.crypto().sha256(&nonce_pre).into();

        // Mirror the contract: hash each address's strkey bytes
        let mut addr_buf = [0u8; 64];
        let target_strkey = target.clone().to_string();
        let tlen = target_strkey.len() as usize;
        target_strkey.copy_into_slice(&mut addr_buf[..tlen]);
        let target_raw = Bytes::from_slice(env, &addr_buf[..tlen]);
        let target_bytes: Bytes = env.crypto().sha256(&target_raw).into();

        let asset_strkey = asset.clone().to_string();
        let alen = asset_strkey.len() as usize;
        asset_strkey.copy_into_slice(&mut addr_buf[..alen]);
        let asset_raw = Bytes::from_slice(env, &addr_buf[..alen]);
        let asset_bytes: Bytes = env.crypto().sha256(&asset_raw).into();

        let nonce_bytes: Bytes = nonce.into();

        let mut payload = Bytes::new(env);
        payload.extend_from_array(&chain_id.to_be_bytes());
        payload.append(&tx_hash_bytes);
        payload.append(&target_bytes);
        payload.append(&asset_bytes);
        payload.extend_from_array(&amount.to_be_bytes());
        payload.append(&nonce_bytes);

        env.crypto().sha256(&payload).into()
    }

    fn make_relayer_sig(
        env: &Env,
        signing_key: &SigningKey,
        payload_hash: &BytesN<32>,
    ) -> RelayerSig {
        let hash_bytes: Bytes = payload_hash.clone().into();
        let mut hash_arr = [0u8; 32];
        for i in 0..32 {
            hash_arr[i] = hash_bytes.get(i as u32).unwrap();
        }
        let sig = signing_key.sign(&hash_arr);
        RelayerSig {
            pubkey: BytesN::from_array(env, signing_key.verifying_key().as_bytes()),
            signature: BytesN::from_array(env, &sig.to_bytes()),
        }
    }

    fn setup(env: &Env) -> (
        soroban_sdk::Address,
        soroban_sdk::Address,
        soroban_sdk::Address,
        crate::OnboardingBridgeClient<'_>,
    ) {
        let bridge_id = env.register(OnboardingBridge, ());
        let token_id = env.register(TestToken, ());
        env.mock_all_auths();

        let admin = soroban_sdk::Address::generate(env);
        let fee_collector = soroban_sdk::Address::generate(env);

        let bridge = crate::OnboardingBridgeClient::new(env, &bridge_id);
        TestTokenClient::new(env, &token_id).initialize(
            &admin,
            &7u32,
            &"Test".into_val(env),
            &"TST".into_val(env),
        );
        bridge.initialize(&admin, &fee_collector, &100u32, &None); // 1% fee
        bridge.add_asset(&token_id, &None);

        // Fund the bridge contract so it can pay out cross-chain claims
        TestTokenClient::new(env, &token_id).mint(&bridge_id, &10_000i128);

        (bridge_id, token_id, admin, bridge)
    }

    #[test]
    fn test_crosschain_happy_path_single_relayer() {
        let env = Env::default();
        let (bridge_id, token_id, _admin, bridge) = setup(&env);

        let sk = make_signing_key([1u8; 32]);
        let pubkey = BytesN::from_array(&env, sk.verifying_key().as_bytes());

        bridge.add_relayer(&pubkey);
        bridge.set_relayer_threshold(&1u32);

        let target = soroban_sdk::Address::generate(&env);
        let tx_hash = BytesN::from_array(&env, &[0xab; 32]);
        let chain_id: u32 = 1;
        let amount: i128 = 1000;

        let payload_hash = build_payload_hash(&env, chain_id, &tx_hash, &target, &token_id, amount);
        let sig = make_relayer_sig(&env, &sk, &payload_hash);
        let sigs = Vec::from_array(&env, [sig]);

        bridge.fund_c_address_crosschain(&chain_id, &tx_hash, &target, &token_id, &amount, &sigs);

        // 1% fee on 1000 = 10; net = 990
        assert_eq!(TestTokenClient::new(&env, &token_id).balance(&target), 990i128);
        assert_eq!(TestTokenClient::new(&env, &token_id).balance(&bridge_id), 10_000 - 990);
    }

    #[test]
    fn test_crosschain_happy_path_2_of_3() {
        let env = Env::default();
        let (_bridge_id, token_id, _admin, bridge) = setup(&env);

        let sk1 = make_signing_key([1u8; 32]);
        let sk2 = make_signing_key([2u8; 32]);
        let sk3 = make_signing_key([3u8; 32]);

        bridge.add_relayer(&BytesN::from_array(&env, sk1.verifying_key().as_bytes()));
        bridge.add_relayer(&BytesN::from_array(&env, sk2.verifying_key().as_bytes()));
        bridge.add_relayer(&BytesN::from_array(&env, sk3.verifying_key().as_bytes()));
        bridge.set_relayer_threshold(&2u32);

        let target = soroban_sdk::Address::generate(&env);
        let tx_hash = BytesN::from_array(&env, &[0xcd; 32]);
        let chain_id: u32 = 101;
        let amount: i128 = 500;

        let payload_hash = build_payload_hash(&env, chain_id, &tx_hash, &target, &token_id, amount);
        let sigs = Vec::from_array(&env, [
            make_relayer_sig(&env, &sk1, &payload_hash),
            make_relayer_sig(&env, &sk2, &payload_hash),
        ]);

        bridge.fund_c_address_crosschain(&chain_id, &tx_hash, &target, &token_id, &amount, &sigs);
        assert_eq!(TestTokenClient::new(&env, &token_id).balance(&target), 495i128);
    }

    #[test]
    fn test_crosschain_replay_rejected() {
        let env = Env::default();
        let (_bridge_id, token_id, _admin, bridge) = setup(&env);

        let sk = make_signing_key([1u8; 32]);
        bridge.add_relayer(&BytesN::from_array(&env, sk.verifying_key().as_bytes()));
        bridge.set_relayer_threshold(&1u32);

        let target = soroban_sdk::Address::generate(&env);
        let tx_hash = BytesN::from_array(&env, &[0xef; 32]);

        let payload_hash = build_payload_hash(&env, 1, &tx_hash, &target, &token_id, 100);
        let sigs = Vec::from_array(&env, [make_relayer_sig(&env, &sk, &payload_hash)]);

        bridge.fund_c_address_crosschain(&1u32, &tx_hash, &target, &token_id, &100i128, &sigs);

        // Second call with same tx_hash must fail
        assert_eq!(
            bridge.try_fund_c_address_crosschain(&1u32, &tx_hash, &target, &token_id, &100i128, &sigs),
            Err(Ok(BridgeError::ReplayedNonce))
        );
    }

    #[test]
    fn test_crosschain_below_threshold_rejected() {
        let env = Env::default();
        let (_bridge_id, token_id, _admin, bridge) = setup(&env);

        let sk1 = make_signing_key([1u8; 32]);
        let sk2 = make_signing_key([2u8; 32]);

        bridge.add_relayer(&BytesN::from_array(&env, sk1.verifying_key().as_bytes()));
        bridge.add_relayer(&BytesN::from_array(&env, sk2.verifying_key().as_bytes()));
        bridge.set_relayer_threshold(&2u32);

        let target = soroban_sdk::Address::generate(&env);
        let tx_hash = BytesN::from_array(&env, &[0x11; 32]);

        let payload_hash = build_payload_hash(&env, 1, &tx_hash, &target, &token_id, 100);
        // Only 1 sig when threshold is 2
        let sigs = Vec::from_array(&env, [make_relayer_sig(&env, &sk1, &payload_hash)]);

        assert_eq!(
            bridge.try_fund_c_address_crosschain(&1u32, &tx_hash, &target, &token_id, &100i128, &sigs),
            Err(Ok(BridgeError::BelowThreshold))
        );
    }

    #[test]
    fn test_crosschain_non_relayer_rejected() {
        let env = Env::default();
        let (_bridge_id, token_id, _admin, bridge) = setup(&env);

        let sk_registered = make_signing_key([1u8; 32]);
        let sk_stranger = make_signing_key([9u8; 32]); // not registered

        bridge.add_relayer(&BytesN::from_array(&env, sk_registered.verifying_key().as_bytes()));
        bridge.set_relayer_threshold(&1u32);

        let target = soroban_sdk::Address::generate(&env);
        let tx_hash = BytesN::from_array(&env, &[0x22; 32]);

        let payload_hash = build_payload_hash(&env, 1, &tx_hash, &target, &token_id, 100);
        let sigs = Vec::from_array(&env, [make_relayer_sig(&env, &sk_stranger, &payload_hash)]);

        assert_eq!(
            bridge.try_fund_c_address_crosschain(&1u32, &tx_hash, &target, &token_id, &100i128, &sigs),
            Err(Ok(BridgeError::NotRelayer))
        );
    }

    #[test]
    fn test_add_remove_relayer_and_threshold() {
        let env = Env::default();
        let (_bridge_id, _token_id, _admin, bridge) = setup(&env);

        let pk = BytesN::from_array(&env, make_signing_key([5u8; 32]).verifying_key().as_bytes());

        bridge.add_relayer(&pk);
        assert!(bridge.query_is_relayer(&pk));

        bridge.set_relayer_threshold(&1u32);
        assert_eq!(bridge.query_relayer_threshold(), 1u32);

        // Can't remove last relayer when it would drop below threshold
        assert_eq!(
            bridge.try_remove_relayer(&pk),
            Err(Ok(BridgeError::BelowThreshold))
        );
    }
}

/********** Referral system tests **********/

#[test]
fn test_set_and_query_referral_rate() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);

    // Default referral rate is 0
    assert_eq!(bridge.query_referral_rate(), 0u32);

    // Admin sets referral rate to 2000 (20% of fee)
    bridge.set_referral_rate(&2000u32, &None);
    assert_eq!(bridge.query_referral_rate(), 2000u32);
}

#[test]
fn test_set_referral_rate_too_high() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);

    assert_eq!(
        bridge.try_set_referral_rate(&10001u32, &None),
        Err(Ok(BridgeError::FeeTooHigh))
    );
}

#[test]
fn test_fund_with_referral_splits_fee() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    // fee_bps = 100 (1%), referral_rate = 2000 (20% of fee)
    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    bridge.set_referral_rate(&2000u32, &None);

    mint_tokens(&env, &token_id, &user, 1000i128);
    let target = Address::generate(&env);
    let referrer = Address::generate(&env);

    bridge.fund_c_address_with_referral(
        &user,
        &target,
        &token_id,
        &1000i128,
        &Some(referrer.clone()),
    );

    // gross = 1000, fee = 10 (1%), referral_fee = 2 (20% of 10), protocol_fee = 8
    assert_eq!(check_balance(&env, &token_id, &user), 0i128);
    assert_eq!(check_balance(&env, &token_id, &target), 990i128);
    assert_eq!(check_balance(&env, &token_id, &referrer), 2i128);
    // contract holds protocol fee (8)
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 8i128);
}

#[test]
fn test_fund_with_no_referrer_accrues_full_fee() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    bridge.set_referral_rate(&2000u32, &None);

    mint_tokens(&env, &token_id, &user, 1000i128);
    let target = Address::generate(&env);

    bridge.fund_c_address_with_referral(&user, &target, &token_id, &1000i128, &None);

    // No referrer — full fee (10) stays in contract
    assert_eq!(check_balance(&env, &token_id, &target), 990i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 10i128);
}

#[test]
fn test_fund_with_referral_zero_referral_rate() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    // referral_rate defaults to 0

    mint_tokens(&env, &token_id, &user, 1000i128);
    let target = Address::generate(&env);
    let referrer = Address::generate(&env);

    bridge.fund_c_address_with_referral(
        &user,
        &target,
        &token_id,
        &1000i128,
        &Some(referrer.clone()),
    );

    // referral_rate = 0, so referrer gets nothing, full fee in contract
    assert_eq!(check_balance(&env, &token_id, &referrer), 0i128);
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 10i128);
}

/********** Zero-amount behavior tests **********/

// fund_c_address with amount=0 — the contract guards `amount <= 0` before
// require_auth, so it must return InvalidAmount immediately.
#[test]
fn test_fund_c_address_zero_amount_fails() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);

    let target = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &0i128, &None, &None),
        Err(Ok(BridgeError::InvalidAmount))
    );
}

// No CAddressFunded event must be emitted when the call is rejected due to zero amount.
#[test]
fn test_fund_c_address_zero_amount_no_event() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);

    // Snapshot event count after setup (Initialized + add_asset events already emitted).
    let events_before = env.events().all().len();

    let target = Address::generate(&env);
    let _ = bridge.try_fund_c_address(&user, &target, &token_id, &0i128, &None, &None);

    // No new events should have been emitted by the rejected call.
    assert_eq!(env.events().all().len(), events_before);
}

// batch_fund_c_address where every amount is zero — fails at validation loop.
#[test]
fn test_batch_fund_all_zeros_fails() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);

    let targets = Vec::from_array(&env, [Address::generate(&env), Address::generate(&env)]);
    let amounts = Vec::from_array(&env, [0i128, 0i128]);

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None),
        Err(Ok(BridgeError::InvalidAmount))
    );
}

// batch_fund_c_address with mixed zero and non-zero amounts — the validation
// loop rejects on the first zero found, before any token transfer occurs.
#[test]
fn test_batch_fund_mixed_zero_nonzero_fails() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let user_balance_before = check_balance(&env, &token_id, &user);

    let targets = Vec::from_array(&env, [Address::generate(&env), Address::generate(&env)]);
    let amounts = Vec::from_array(&env, [500i128, 0i128]); // second entry is zero

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None, &None),
        Err(Ok(BridgeError::InvalidAmount))
    );

    // No tokens must have left the user's account — validation fails before transfer.
    assert_eq!(check_balance(&env, &token_id, &user), user_balance_before);
}

// query_calculate_fee with zero gross amount — should return (fee=0, net=0).
#[test]
fn test_calculate_fee_zero_amount() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);

    let (fee, net) = bridge.query_calculate_fee(&0i128);
    assert_eq!(fee, 0i128);
    assert_eq!(net, 0i128);
}

// Confirm zero amount is rejected even with a max fee rate configured.
#[test]
fn test_fund_c_address_zero_amount_max_fee_fails() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &1000u32, &None); // max fee
    bridge.add_asset(&token_id, &None);

    let target = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &0i128, &None, &None),
        Err(Ok(BridgeError::InvalidAmount))
    );
}

// --------- Authorization enforcement tests (issue #27) ---------
// These tests verify that specific require_auth() calls are enforced.
// Setup uses register_all_contracts_mocked; auths are cleared before the
// operation under test so that auth enforcement is real, not bypassed.

#[test]
#[should_panic]
fn test_fund_c_address_requires_source_auth() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    use soroban_sdk::xdr::SorobanAuthorizationEntry;
    env.set_auths(&[] as &[SorobanAuthorizationEntry]);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);
}

#[test]
#[should_panic]
fn test_set_fee_bps_requires_admin_auth() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    use soroban_sdk::xdr::SorobanAuthorizationEntry;
    env.set_auths(&[] as &[SorobanAuthorizationEntry]);

    bridge.set_fee_bps(&200u32, &None);
}

#[test]
#[should_panic]
fn test_withdraw_fees_requires_fee_collector_auth() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None, &None);

    use soroban_sdk::xdr::SorobanAuthorizationEntry;
    env.set_auths(&[] as &[SorobanAuthorizationEntry]);

    bridge.withdraw_fees(&token_id, &5i128, &None);
}

#[test]
#[should_panic]
fn test_pause_requires_admin_auth() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts_mocked(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    use soroban_sdk::xdr::SorobanAuthorizationEntry;
    env.set_auths(&[] as &[SorobanAuthorizationEntry]);

    bridge.pause(&None);
}

// ============================================================================
// Issue #41: Concurrent / sequential operation simulation tests
//
// Soroban executes all operations in a ledger sequentially (single-threaded),
// but cross-contract call ordering and interleaved state mutations can still
// produce surprising results. These tests simulate the scenarios described in
// issue #41 within the deterministic Soroban test environment:
//
//   1. Token transfer during fee withdrawal (cross-contract edge case)
//   2. Batch funding where some targets are blocked mid-batch (sequential skips)
//   3. Multiple fee withdrawals in sequence
//   4. Contract initialization race (multiple init calls in same ledger context)
// ============================================================================

#[cfg(test)]
mod concurrent_sequential_tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Shared setup helper
    // -----------------------------------------------------------------------

    struct ConcurrentSetup {
        env: Env,
        bridge_id: Address,
        token_id: Address,
        admin: Address,
        fee_collector: Address,
        user: Address,
    }

    impl ConcurrentSetup {
        fn new() -> Self {
            let env = Env::default();
            env.mock_all_auths();

            let (bridge_id, token_id) = register_all_contracts(&env);
            let (admin, user, fee_collector) = create_test_users(&env);

            init_token(&env, &token_id, &admin);

            let bridge = create_bridge_client(&env, &bridge_id);
            bridge.initialize(&admin, &fee_collector, &100u32, &None); // 1% fee
            bridge.add_asset(&token_id, &None);

            Self { env, bridge_id, token_id, admin, fee_collector, user }
        }

        fn bridge(&self) -> crate::OnboardingBridgeClient<'_> {
            create_bridge_client(&self.env, &self.bridge_id)
        }
    }

    // -----------------------------------------------------------------------
    // Scenario 1: Token transfer during fee withdrawal
    //
    // Soroban prevents true re-entrancy via the ReentrancyGuard. This test
    // verifies that a fund_c_address followed immediately by withdraw_fees in
    // the same ledger context produces correct sequential state:
    //   - fee accrued after fund equals what withdraw_fees drains
    //   - no double-spending or ghost balance
    // -----------------------------------------------------------------------

    #[test]
    fn test_sequential_fund_then_withdraw_fees_correct_state() {
        let s = ConcurrentSetup::new();
        mint_tokens(&s.env, &s.token_id, &s.user, 10_000i128);

        let target = Address::generate(&s.env);

        // Step 1: fund — accrues 100 in fees (1% of 10_000)
        s.bridge().fund_c_address(
            &s.user, &target, &s.token_id, &10_000i128, &None, &None,
        );

        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 100i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &s.bridge_id), 100i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &target), 9_900i128);

        // Step 2: withdraw_fees in the same ledger (next sequential call)
        s.bridge().withdraw_fees(&s.token_id, &100i128, &None);

        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 0i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &s.bridge_id), 0i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &s.fee_collector), 100i128);
    }

    #[test]
    fn test_sequential_withdraw_exceeds_accrued_after_partial_withdrawal() {
        let s = ConcurrentSetup::new();
        mint_tokens(&s.env, &s.token_id, &s.user, 20_000i128);

        let target = Address::generate(&s.env);
        // Fund twice: 10_000 each → fee = 100 each → 200 total accrued
        s.bridge().fund_c_address(&s.user, &target, &s.token_id, &10_000i128, &None, &None);
        s.bridge().fund_c_address(&s.user, &target, &s.token_id, &10_000i128, &None, &None);

        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 200i128);

        // Withdraw 150 → 50 remaining
        s.bridge().withdraw_fees(&s.token_id, &150i128, &None);
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 50i128);

        // Try to withdraw 51 — should fail: InsufficientReclaimable
        assert_eq!(
            s.bridge().try_withdraw_fees(&s.token_id, &51i128, &None),
            Err(Ok(BridgeError::InsufficientReclaimable))
        );

        // Can still withdraw the remaining 50
        s.bridge().withdraw_fees(&s.token_id, &50i128, &None);
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 0i128);
    }

    // -----------------------------------------------------------------------
    // Scenario 2: Batch funding where targets change access status mid-processing
    //
    // In a single batch call the access check is evaluated per-entry in sequence.
    // If a target is blocked, its amount is refunded; others succeed.  This
    // simulates the observable effect of interleaved access changes across
    // sequential calls.
    // -----------------------------------------------------------------------

    #[test]
    fn test_batch_sequential_access_change_between_calls() {
        let s = ConcurrentSetup::new();
        mint_tokens(&s.env, &s.token_id, &s.user, 5_000i128);

        let target_a = Address::generate(&s.env);
        let target_b = Address::generate(&s.env);

        // Call 1: both targets open — both succeed
        let targets = Vec::from_array(&s.env, [target_a.clone(), target_b.clone()]);
        let amounts = Vec::from_array(&s.env, [1_000i128, 1_000i128]);
        s.bridge().batch_fund_c_address(
            &s.user, &targets, &amounts, &s.token_id, &None, &None,
        );
        assert_eq!(check_balance(&s.env, &s.token_id, &target_a), 990i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &target_b), 990i128);

        // Simulate "interleaved state change": block target_b between calls
        s.bridge().add_to_blocklist(&target_b, &None);

        // Call 2: target_a still open, target_b blocked → target_b refunded
        let targets2 = Vec::from_array(&s.env, [target_a.clone(), target_b.clone()]);
        let amounts2 = Vec::from_array(&s.env, [500i128, 500i128]);
        s.bridge().batch_fund_c_address(
            &s.user, &targets2, &amounts2, &s.token_id, &None, &None,
        );

        // target_a receives additional 495 (1% fee on 500); target_b gets nothing
        assert_eq!(check_balance(&s.env, &s.token_id, &target_a), 990 + 495);
        assert_eq!(check_balance(&s.env, &s.token_id, &target_b), 990i128); // unchanged
        // user gets back the 500 for blocked target_b
        assert_eq!(check_balance(&s.env, &s.token_id, &s.user), 5_000 - 2_000 - 500);
    }

    #[test]
    fn test_batch_sequential_all_targets_blocked_mid_sequence() {
        let s = ConcurrentSetup::new();
        mint_tokens(&s.env, &s.token_id, &s.user, 3_000i128);

        let t1 = Address::generate(&s.env);
        let t2 = Address::generate(&s.env);
        let t3 = Address::generate(&s.env);

        // Block all three targets before the batch call
        s.bridge().add_to_blocklist(&t1, &None);
        s.bridge().add_to_blocklist(&t2, &None);
        s.bridge().add_to_blocklist(&t3, &None);

        let targets = Vec::from_array(&s.env, [t1.clone(), t2.clone(), t3.clone()]);
        let amounts = Vec::from_array(&s.env, [1_000i128, 1_000i128, 1_000i128]);

        s.bridge().batch_fund_c_address(
            &s.user, &targets, &amounts, &s.token_id, &None, &None,
        );

        // Full refund: user gets all 3_000 back
        assert_eq!(check_balance(&s.env, &s.token_id, &s.user), 3_000i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &t1), 0i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &t2), 0i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &t3), 0i128);
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 0i128);
    }

    // -----------------------------------------------------------------------
    // Scenario 3: Multiple fee withdrawals in sequence
    //
    // Verifies that sequential partial withdrawals correctly decrement the
    // accrued-fees counter and never allow over-withdrawal.
    // -----------------------------------------------------------------------

    #[test]
    fn test_multiple_sequential_fee_withdrawals() {
        let s = ConcurrentSetup::new();
        mint_tokens(&s.env, &s.token_id, &s.user, 100_000i128);

        let target = Address::generate(&s.env);
        // 10 fund calls × 10_000 each @ 1% = 1_000 total fees
        for _ in 0..10 {
            s.bridge().fund_c_address(
                &s.user, &target, &s.token_id, &10_000i128, &None, &None,
            );
        }
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 1_000i128);

        // 5 sequential partial withdrawals of 200 each = 1_000 total
        for i in 0..5u64 {
            s.bridge().withdraw_fees(&s.token_id, &200i128, &None);
            let remaining = 1_000 - (200 * (i as i128 + 1));
            assert_eq!(s.bridge().query_accrued_fees(&s.token_id), remaining);
        }

        // All drained
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 0i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &s.fee_collector), 1_000i128);

        // 6th withdrawal must fail
        assert_eq!(
            s.bridge().try_withdraw_fees(&s.token_id, &1i128, &None),
            Err(Ok(BridgeError::InsufficientReclaimable))
        );
    }

    #[test]
    fn test_sequential_fund_withdraw_fund_withdraw_interleaved() {
        let s = ConcurrentSetup::new();
        mint_tokens(&s.env, &s.token_id, &s.user, 50_000i128);

        let target = Address::generate(&s.env);

        // Round 1: fund 10_000 → fee 100, then immediately withdraw 100
        s.bridge().fund_c_address(
            &s.user, &target, &s.token_id, &10_000i128, &None, &None,
        );
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 100i128);
        s.bridge().withdraw_fees(&s.token_id, &100i128, &None);
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 0i128);

        // Round 2: fund 20_000 → fee 200, withdraw 100, 50 remaining
        s.bridge().fund_c_address(
            &s.user, &target, &s.token_id, &20_000i128, &None, &None,
        );
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 200i128);
        s.bridge().withdraw_fees(&s.token_id, &100i128, &None);
        s.bridge().withdraw_fees(&s.token_id, &100i128, &None);
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 0i128);

        // Total withdrawn = 100 + 200 = 300
        assert_eq!(check_balance(&s.env, &s.token_id, &s.fee_collector), 300i128);
    }

    // -----------------------------------------------------------------------
    // Scenario 4: Contract initialization race
    //
    // Soroban processes transactions sequentially; a second initialize call in
    // the same execution context must return AlreadyInitialized regardless of
    // how quickly it follows the first. These tests prove the guard is robust.
    // -----------------------------------------------------------------------

    #[test]
    fn test_double_initialize_rejected_sequential() {
        let env = Env::default();
        env.mock_all_auths();

        let (bridge_id, _) = register_all_contracts_mocked(&env);
        let bridge = create_bridge_client(&env, &bridge_id);
        let (admin, _, fee_collector) = create_test_users(&env);

        // First init succeeds
        bridge.initialize(&admin, &fee_collector, &50u32, &None);
        assert!(bridge.query_is_initialized());

        // Immediate second call: different admin, should still be rejected
        let attacker = Address::generate(&env);
        assert_eq!(
            bridge.try_initialize(&attacker, &attacker, &50u32, &None),
            Err(Ok(BridgeError::AlreadyInitialized))
        );

        // State must reflect the original init only
        assert_eq!(bridge.query_admin(), admin);
        assert_eq!(bridge.query_fee_collector(), fee_collector);
        assert_eq!(bridge.query_fee_bps(), 50u32);
    }

    #[test]
    fn test_initialize_race_cannot_hijack_admin() {
        let env = Env::default();
        env.mock_all_auths();

        let (bridge_id, _) = register_all_contracts_mocked(&env);
        let bridge = create_bridge_client(&env, &bridge_id);
        let (admin, _, fee_collector) = create_test_users(&env);

        bridge.initialize(&admin, &fee_collector, &100u32, &None);

        // Simulate three rapid "race" init attempts
        for _ in 0..3 {
            let fake_admin = Address::generate(&env);
            assert_eq!(
                bridge.try_initialize(&fake_admin, &fake_admin, &1000u32, &None),
                Err(Ok(BridgeError::AlreadyInitialized))
            );
        }

        // Contract state is intact
        assert_eq!(bridge.query_admin(), admin);
        assert_eq!(bridge.query_fee_bps(), 100u32);
    }

    #[test]
    fn test_initialize_race_with_different_fee_bps() {
        let env = Env::default();
        env.mock_all_auths();

        let (bridge_id, _) = register_all_contracts_mocked(&env);
        let bridge = create_bridge_client(&env, &bridge_id);
        let (admin, _, fee_collector) = create_test_users(&env);

        bridge.initialize(&admin, &fee_collector, &200u32, &None);

        // Second call with lower fee should NOT succeed and overwrite
        assert_eq!(
            bridge.try_initialize(&admin, &fee_collector, &0u32, &None),
            Err(Ok(BridgeError::AlreadyInitialized))
        );

        // Fee unchanged
        assert_eq!(bridge.query_fee_bps(), 200u32);
    }

    // -----------------------------------------------------------------------
    // Scenario 5: Re-entrancy guard prevents nested calls
    //
    // The ReentrancyGuard flag is set for the duration of each mutating call.
    // This test verifies fund_c_address → the guard is cleared after return,
    // allowing the next sequential call to proceed normally.
    // -----------------------------------------------------------------------

    #[test]
    fn test_sequential_calls_after_reentrancy_guard_clears() {
        let s = ConcurrentSetup::new();
        mint_tokens(&s.env, &s.token_id, &s.user, 10_000i128);

        let t1 = Address::generate(&s.env);
        let t2 = Address::generate(&s.env);
        let t3 = Address::generate(&s.env);

        // Three sequential fund calls — each must succeed (guard clears between calls)
        s.bridge().fund_c_address(
            &s.user, &t1, &s.token_id, &3_000i128, &None, &None,
        );
        s.bridge().fund_c_address(
            &s.user, &t2, &s.token_id, &3_000i128, &None, &None,
        );
        s.bridge().fund_c_address(
            &s.user, &t3, &s.token_id, &4_000i128, &None, &None,
        );

        // Total fee: 30 + 30 + 40 = 100; net to each: 2970, 2970, 3960
        assert_eq!(check_balance(&s.env, &s.token_id, &t1), 2_970i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &t2), 2_970i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &t3), 3_960i128);
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 100i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &s.user), 0i128);
    }

    // -----------------------------------------------------------------------
    // Scenario 6: Fee counter consistency across mixed batch + single calls
    //
    // Mixing batch_fund_c_address and fund_c_address in sequence must keep
    // all counters (accrued_fees, total_bridged, total_fees_collected) consistent.
    // -----------------------------------------------------------------------

    #[test]
    fn test_mixed_batch_and_single_fee_counter_consistency() {
        let s = ConcurrentSetup::new();
        mint_tokens(&s.env, &s.token_id, &s.user, 50_000i128);

        let t1 = Address::generate(&s.env);
        let t2 = Address::generate(&s.env);
        let t3 = Address::generate(&s.env);

        // Single fund: 10_000 → fee 100, net 9_900
        s.bridge().fund_c_address(
            &s.user, &t1, &s.token_id, &10_000i128, &None, &None,
        );

        // Batch fund: [20_000, 5_000] → fees 200 + 50 = 250, nets 19_800 + 4_950
        let targets = Vec::from_array(&s.env, [t2.clone(), t3.clone()]);
        let amounts = Vec::from_array(&s.env, [20_000i128, 5_000i128]);
        s.bridge().batch_fund_c_address(
            &s.user, &targets, &amounts, &s.token_id, &None, &None,
        );

        // Another single fund: 15_000 → fee 150, net 14_850
        s.bridge().fund_c_address(
            &s.user, &t1, &s.token_id, &15_000i128, &None, &None,
        );

        // Total fees = 100 + 250 + 150 = 500
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 500i128);
        assert_eq!(s.bridge().query_total_fees_collected(&s.token_id), 500i128);
        // Total bridged = 9_900 + 19_800 + 4_950 + 14_850 = 49_500
        assert_eq!(s.bridge().query_total_bridged(&s.token_id), 49_500i128);

        // Now drain all fees sequentially in two calls
        s.bridge().withdraw_fees(&s.token_id, &300i128, &None);
        s.bridge().withdraw_fees(&s.token_id, &200i128, &None);
        assert_eq!(s.bridge().query_accrued_fees(&s.token_id), 0i128);
        assert_eq!(check_balance(&s.env, &s.token_id, &s.fee_collector), 500i128);
    }
}
