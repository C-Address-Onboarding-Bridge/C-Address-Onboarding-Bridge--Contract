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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None);

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

    bridge.initialize(&Address::generate(&env), &Address::generate(&env), &50u32, &None);

    let b2_id = env.register(OnboardingBridge, ());
    let b2 = crate::OnboardingBridgeClient::new(&env, &b2_id);
    let target = Address::generate(&env);
    assert_eq!(
        b2.try_fund_c_address(&user, &target, &token_id, &100i128, &None),
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

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 3000i128);

    let target1 = Address::generate(&env);
    let target2 = Address::generate(&env);
    let targets = Vec::from_array(&env, [target1.clone(), target2.clone()]);
    let amounts = Vec::from_array(&env, [1000i128, 500i128]);

    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);

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

    bridge.initialize(&admin, &fee_collector, &0u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None);

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

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    assert_eq!(bridge.query_fee_bps(), 50u32);

    bridge.set_fee_bps(&200u32, &None);
    assert_eq!(bridge.query_fee_bps(), 200u32);
}

#[test]
fn test_set_fee_bps_too_high() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None);

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
    let (bridge_id, token_id) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    let token_id = Address::generate(&env);
    bridge.initialize(&admin, &fee_collector, &50u32, &None);

    let targets: Vec<Address> = Vec::new(&env);
    let amounts: Vec<i128> = Vec::new(&env);

    bridge.batch_fund_c_address(&admin, &targets, &amounts, &token_id, &None);
}

#[test]
fn test_fund_events() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None);

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

/********** Pause / Upgrade tests **********/

#[test]
fn test_pause_and_unpause() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause(&None);

    let target = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None),
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

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause(&None);

    let target = Address::generate(&env);
    let targets = Vec::from_array(&env, [target.clone()]);
    let amounts = Vec::from_array(&env, [500i128]);
    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None),
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

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.pause(&None);
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

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.pause(&None);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);
    bridge.pause(&None);
    bridge.unpause(&None);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None);

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

fn setup_bridge(env: &Env) -> (crate::OnboardingBridgeClient, Address, Address, Address) {
    let (bridge_id, token_id) = register_all_contracts(env);
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
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None),
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

    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None);
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
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None),
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

    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None);
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
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None),
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
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None),
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

    let targets = Vec::from_array(&env, [t1, t2]);
    let amounts = Vec::from_array(&env, [200i128, 300i128]);

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None),
        Err(Ok(crate::BridgeError::AddressBlocked))
    );
}

#[test]
fn test_allowlist_mode_off_allows_all() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    // allowlist mode off by default
    assert!(!bridge.query_allowlist_mode());
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None);
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
    bridge.fund_c_address(&user, &target, &token_id, &1000i128, &None);
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
    bridge.fund_c_address(&user, &target, &token_id, &1000i128, &None);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.add_asset(&token_id, &None);

    env.set_auths(&[]);
    bridge.remove_asset(&token_id, &None);
}

#[test]
fn test_whitelist_query_uninitialized() {
    let env = Env::default();
    let (bridge_id, token_id) = register_all_contracts(&env);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128, &None),
        Err(Ok(BridgeError::AssetNotWhitelisted))
    );
}

#[test]
fn test_batch_fund_rejects_non_whitelisted_asset() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    mint_tokens(&env, &token_id, &user, 3000i128);

    let target1 = Address::generate(&env);
    let targets = Vec::from_array(&env, [target1]);
    let amounts = Vec::from_array(&env, [1000i128]);

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None),
        Err(Ok(BridgeError::AssetNotWhitelisted))
    );
}

/********** query_all_balances Tests **********/

#[test]
fn test_query_all_balances_returns_contract_balances() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
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
    let (bridge_id, _token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    bridge.initialize(&admin, &fee_collector, &0u32, &None);

    let assets: Vec<Address> = Vec::new(&env);
    let balances = bridge.query_all_balances(&assets);
    assert_eq!(balances.len(), 0);
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

/********** query_calculate_fee tests **********/

#[test]
fn test_query_calculate_fee() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &500i128, &None);

    let total_bridged = bridge.query_total_bridged(&token_id);
    let total_fees = bridge.query_total_fees_collected(&token_id);

    assert_eq!(total_bridged, 495i128);
    assert_eq!(total_fees, 5i128);
}

#[test]
fn test_query_total_bridged_accumulates() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 5000i128);

    let target1 = Address::generate(&env);
    let target2 = Address::generate(&env);

    bridge.fund_c_address(&user, &target1, &token_id, &1000i128, &None);
    bridge.fund_c_address(&user, &target2, &token_id, &1000i128, &None);

    let total_bridged = bridge.query_total_bridged(&token_id);
    let total_fees = bridge.query_total_fees_collected(&token_id);

    assert_eq!(total_bridged, 1990i128);
    assert_eq!(total_fees, 10i128);
}

#[test]
fn test_query_total_bridged_batch() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);

    bridge.initialize(&admin, &fee_collector, &100u32, &None);
    bridge.add_asset(&token_id, &None);
    mint_tokens(&env, &token_id, &user, 3000i128);

    let target1 = Address::generate(&env);
    let target2 = Address::generate(&env);
    let targets = Vec::from_array(&env, [target1, target2]);
    let amounts = Vec::from_array(&env, [1000i128, 500i128]);

    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);

    let total_bridged = bridge.query_total_bridged(&token_id);
    let total_fees = bridge.query_total_fees_collected(&token_id);

    assert_eq!(total_bridged, 1485i128);
    assert_eq!(total_fees, 15i128);
}

#[test]
fn test_query_total_bridged_zero() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
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
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32, &None);
    let new_admin = Address::generate(&env);
    bridge.set_admin(&new_admin, &None);

    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge_id);
}

// --------- batch_fund_c_address edge case tests ---------

fn setup_batch(env: &Env) -> (crate::OnboardingBridgeClient, Address, Address, Address) {
    let (bridge_id, token_id) = register_all_contracts(env);
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
    use soroban_sdk::IntoVal;
    let topic_val: soroban_sdk::Val = topic.into_val(env);
    let mut count = 0u32;
    for event in env.events().all().iter() {
        let (cid, topics, _) = event;
        if &cid == bridge_id && topics.len() > 0 {
            if let Ok(t) = topics.get(0) {
                if t == topic_val {
                    count += 1;
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
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);

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
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);

    assert_eq!(check_balance(&env, &token_id, &target), 990i128); // 1% fee
    assert_eq!(check_balance(&env, &token_id, &user), 999_000i128);

    // Exactly 1 CAddressFunded and 1 BatchCompleted emitted.
    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 1);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
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
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);

    // Net: 990 + 1980 + 2970 = 5940
    assert_eq!(check_balance(&env, &token_id, &target), 5940i128);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 3);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
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
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);

    // Started with 1_000_000. Paid 1000, received 990. Net: 999_990.
    assert_eq!(check_balance(&env, &token_id, &user), 999_990i128);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 1);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
}

/// Target is the contract itself — contract receives the net amount.
#[test]
fn test_batch_target_is_contract() {
    let env = Env::default();
    let (bridge, user, token_id, _) = setup_batch(&env);
    let bridge_id = bridge.address.clone();

    let targets = Vec::from_array(&env, [bridge_id.clone()]);
    let amounts = Vec::from_array(&env, [1000i128]);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);

    // Contract should hold 1000 total (990 transferred to itself as target + 10 accrued fee).
    assert_eq!(check_balance(&env, &token_id, &bridge_id), 1000i128);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 1);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
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
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None),
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
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None),
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
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);

    assert_eq!(check_balance(&env, &token_id, &target), 1i128);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 1);
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
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &None),
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
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);

    // Good target receives net amount (1% fee on 1000 = 990).
    assert_eq!(check_balance(&env, &token_id, &good), 990i128);
    // Blocked target receives nothing; 500 refunded to source.
    assert_eq!(check_balance(&env, &token_id, &blocked), 0i128);
    // Source paid 1500 total, got 500 back: net cost 1000.
    assert_eq!(check_balance(&env, &token_id, &user), 999_000i128);

    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 1);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchTransferFailed"), 1);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
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
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);

    // Full refund — source balance unchanged.
    assert_eq!(check_balance(&env, &token_id, &user), 1_000_000i128);
    assert_eq!(check_balance(&env, &token_id, &t1), 0i128);
    assert_eq!(check_balance(&env, &token_id, &t2), 0i128);

    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 0);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchTransferFailed"), 2);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
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

    bridge.batch_fund_c_address(&user, &targets_vec, &amounts_vec, &token_id, &None);

    // Each target receives 990 (1% fee on 1000).
    for i in 0..100 {
        assert_eq!(check_balance(&env, &token_id, &target_addrs.get(i).unwrap()), 990i128);
    }
    // Source spent 100_000 tokens from the extra mint.
    assert_eq!(check_balance(&env, &token_id, &user), 1_000_000i128); // original unchanged
    assert_eq!(count_events_with_topic(&env, &bridge_id, "CAddressFunded"), 100);
    assert_eq!(count_events_with_topic(&env, &bridge_id, "BatchCompleted"), 1);
}

/********** Nonce tests **********/

#[test]
fn test_nonce_starts_at_zero() {
    let env = Env::default();
    let (bridge_id, _) = register_all_contracts(&env);
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
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &Some(0u64));

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
    bridge.batch_fund_c_address(&user, &targets1, &amounts, &token_id, &Some(0u64));

    // Replaying nonce=0 rejected.
    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets2, &amounts, &token_id, &Some(0u64)),
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
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &None);
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
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id, &Some(1u64)),
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
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id, &Some(0u64));
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
    bridge.fund_c_address(&user, &target, &token_id, &100i128, &Some(0u64));
    assert_eq!(bridge.query_nonce(&user), 1u64);

    // Reuse nonce=0 on fund_c_address rejected.
    let target2 = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target2, &token_id, &100i128, &Some(0u64)),
        Err(Ok(BridgeError::DuplicateNonce))
    );
}
