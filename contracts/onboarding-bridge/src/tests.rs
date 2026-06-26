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
    bridge.add_asset(&token_id);
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
    bridge.add_asset(&token_id);
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
    bridge.add_asset(&token_id);
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
    bridge.add_asset(&token_id);
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
    bridge.add_asset(&token_id);
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

/********** Pause / Upgrade tests **********/

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
    bridge.add_asset(&token_id);
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
    bridge.add_asset(&token_id);
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

// --------- Blocklist / Allowlist Tests ---------

fn setup_bridge(env: &Env) -> (crate::OnboardingBridgeClient, Address, Address, Address) {
    let (bridge_id, token_id) = register_all_contracts(env);
    let bridge = create_bridge_client(env, &bridge_id);
    let (admin, user, fee_collector) = create_test_users(env);
    init_token(env, &token_id, &admin);
    bridge.initialize(&admin, &fee_collector, &0u32);
    bridge.add_asset(&token_id);
    mint_tokens(env, &token_id, &user, 1000i128);
    (bridge, user, token_id, admin)
}

#[test]
fn test_blocklist_prevents_fund() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.add_to_blocklist(&target);
    assert!(bridge.query_is_blocked(&target));

    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128),
        Err(Ok(crate::BridgeError::AddressBlocked))
    );
}

#[test]
fn test_remove_from_blocklist_allows_fund() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.add_to_blocklist(&target);
    bridge.remove_from_blocklist(&target);
    assert!(!bridge.query_is_blocked(&target));

    bridge.fund_c_address(&user, &target, &token_id, &500i128);
    assert_eq!(check_balance(&env, &token_id, &target), 500i128);
}

#[test]
fn test_allowlist_mode_blocks_non_allowlisted() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.set_allowlist_mode(&true);
    assert!(bridge.query_allowlist_mode());

    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128),
        Err(Ok(crate::BridgeError::AddressNotAllowlisted))
    );
}

#[test]
fn test_allowlist_mode_allows_allowlisted() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.set_allowlist_mode(&true);
    bridge.add_to_allowlist(&target);
    assert!(bridge.query_is_allowlisted(&target));

    bridge.fund_c_address(&user, &target, &token_id, &500i128);
    assert_eq!(check_balance(&env, &token_id, &target), 500i128);
}

#[test]
fn test_remove_from_allowlist_blocks_in_allowlist_mode() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.set_allowlist_mode(&true);
    bridge.add_to_allowlist(&target);
    bridge.remove_from_allowlist(&target);
    assert!(!bridge.query_is_allowlisted(&target));

    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128),
        Err(Ok(crate::BridgeError::AddressNotAllowlisted))
    );
}

#[test]
fn test_blocklist_overrides_allowlist() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let target = Address::generate(&env);

    bridge.set_allowlist_mode(&true);
    bridge.add_to_allowlist(&target);
    bridge.add_to_blocklist(&target);

    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128),
        Err(Ok(crate::BridgeError::AddressBlocked))
    );
}

#[test]
fn test_batch_fund_blocked_address_fails() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    let t1 = Address::generate(&env);
    let t2 = Address::generate(&env);

    bridge.add_to_blocklist(&t2);

    let targets = Vec::from_array(&env, [t1, t2]);
    let amounts = Vec::from_array(&env, [200i128, 300i128]);

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id),
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
    bridge.fund_c_address(&user, &target, &token_id, &500i128);
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
    bridge.reclaim_tokens(&token_id, &500i128, &destination);

    assert_eq!(check_balance(&env, &token_id, &destination), 500i128);
    let _ = admin; // suppress unused warning
}

#[test]
fn test_reclaim_cannot_take_accrued_fees() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);

    // Fund so fees (10%) accrue in contract
    bridge.set_fee_bps(&1000u32); // 10%
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &1000i128);
    // contract now holds 100 in accrued fees, 0 reclaimable

    let destination = Address::generate(&env);
    assert_eq!(
        bridge.try_reclaim_tokens(&token_id, &1i128, &destination),
        Err(Ok(crate::BridgeError::InsufficientReclaimable))
    );
}

#[test]
fn test_reclaim_only_excess_over_fees() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);

    bridge.set_fee_bps(&1000u32); // 10%
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &1000i128);
    // 100 accrued fees in contract; mint 200 more directly
    mint_tokens(&env, &token_id, &bridge.address, 200i128);

    let destination = Address::generate(&env);
    // Can reclaim exactly 200 (the excess)
    bridge.reclaim_tokens(&token_id, &200i128, &destination);
    assert_eq!(check_balance(&env, &token_id, &destination), 200i128);

    // Cannot reclaim 1 more
    let dest2 = Address::generate(&env);
    assert_eq!(
        bridge.try_reclaim_tokens(&token_id, &1i128, &dest2),
        Err(Ok(crate::BridgeError::InsufficientReclaimable))
    );
}

#[test]
fn test_reclaim_emits_event() {
    let env = Env::default();
    let (bridge, _user, token_id, _admin) = setup_bridge(&env);

    mint_tokens(&env, &token_id, &bridge.address, 300i128);
    let destination = Address::generate(&env);
    bridge.reclaim_tokens(&token_id, &300i128, &destination);

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

    bridge.initialize(&admin, &fee_collector, &50u32);
    assert_eq!(bridge.query_is_asset_whitelisted(&token_id), false);

    bridge.add_asset(&token_id);
    assert_eq!(bridge.query_is_asset_whitelisted(&token_id), true);
}

#[test]
fn test_remove_asset() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    bridge.add_asset(&token_id);
    assert_eq!(bridge.query_is_asset_whitelisted(&token_id), true);

    bridge.remove_asset(&token_id);
    assert_eq!(bridge.query_is_asset_whitelisted(&token_id), false);
}

#[test]
fn test_query_whitelisted_assets() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, _) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);

    let asset1 = Address::generate(&env);
    let asset2 = Address::generate(&env);
    bridge.add_asset(&asset1);
    bridge.add_asset(&asset2);

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

    bridge.initialize(&admin, &fee_collector, &50u32);
    bridge.add_asset(&token_id);
    bridge.add_asset(&token_id);

    assert_eq!(bridge.query_whitelisted_assets().len(), 1);
}

#[test]
#[should_panic]
fn test_add_asset_non_admin_rejected() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);

    env.set_auths(&[]);
    bridge.add_asset(&token_id);
}

#[test]
#[should_panic]
fn test_remove_asset_non_admin_rejected() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);

    bridge.initialize(&admin, &fee_collector, &50u32);
    bridge.add_asset(&token_id);

    env.set_auths(&[]);
    bridge.remove_asset(&token_id);
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

    bridge.initialize(&admin, &fee_collector, &100u32);
    mint_tokens(&env, &token_id, &user, 1000i128);

    let target = Address::generate(&env);
    assert_eq!(
        bridge.try_fund_c_address(&user, &target, &token_id, &500i128),
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

    bridge.initialize(&admin, &fee_collector, &100u32);
    mint_tokens(&env, &token_id, &user, 3000i128);

    let target1 = Address::generate(&env);
    let targets = Vec::from_array(&env, [target1]);
    let amounts = Vec::from_array(&env, [1000i128]);

    assert_eq!(
        bridge.try_batch_fund_c_address(&user, &targets, &amounts, &token_id),
        Err(Ok(BridgeError::AssetNotWhitelisted))
    );
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

/********** Batch Atomicity Tests (Issue #14) **********/

#[test]
fn test_batch_partial_success_blocked_address() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    
    let t1 = Address::generate(&env);
    let t2 = Address::generate(&env);
    
    bridge.add_to_blocklist(&t2);
    
    let targets = Vec::from_array(&env, [t1.clone(), t2.clone()]);
    let amounts = Vec::from_array(&env, [200i128, 300i128]);
    
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id);
    
    assert_eq!(check_balance(&env, &token_id, &t1), 200i128);
    assert_eq!(check_balance(&env, &token_id, &t2), 0i128);
    assert_eq!(check_balance(&env, &token_id, &user), 800i128);
}

#[test]
fn test_batch_refund_on_mixed_failures() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    
    let t1 = Address::generate(&env);
    let t2 = Address::generate(&env);
    let t3 = Address::generate(&env);
    
    bridge.add_to_blocklist(&t2);
    
    let targets = Vec::from_array(&env, [t1.clone(), t2.clone(), t3.clone()]);
    let amounts = Vec::from_array(&env, [100i128, 200i128, 150i128]);
    
    let user_before = check_balance(&env, &token_id, &user);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id);
    
    let user_after = check_balance(&env, &token_id, &user);
    let total_sent = 100 + 200 + 150;
    let refunded = 200;
    
    assert_eq!(check_balance(&env, &token_id, &t1), 100i128);
    assert_eq!(check_balance(&env, &token_id, &t2), 0i128);
    assert_eq!(check_balance(&env, &token_id, &t3), 150i128);
    assert_eq!(user_before - user_after, total_sent - refunded);
}

#[test]
fn test_batch_completed_event_emitted() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    
    let t1 = Address::generate(&env);
    let t2 = Address::generate(&env);
    
    bridge.add_to_blocklist(&t2);
    
    let targets = Vec::from_array(&env, [t1, t2]);
    let amounts = Vec::from_array(&env, [100i128, 200i128]);
    
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id);
    
    let events = env.events().all();
    let (contract_id, _topics, _data) = &events.get(events.len() - 1).unwrap();
    assert_eq!(contract_id, &bridge.address);
}

#[test]
fn test_batch_all_succeed_no_refund() {
    let env = Env::default();
    let (bridge, user, token_id, _admin) = setup_bridge(&env);
    
    let t1 = Address::generate(&env);
    let t2 = Address::generate(&env);
    
    let targets = Vec::from_array(&env, [t1.clone(), t2.clone()]);
    let amounts = Vec::from_array(&env, [300i128, 400i128]);
    
    let user_before = check_balance(&env, &token_id, &user);
    bridge.batch_fund_c_address(&user, &targets, &amounts, &token_id);
    let user_after = check_balance(&env, &token_id, &user);
    
    assert_eq!(check_balance(&env, &token_id, &t1), 300i128);
    assert_eq!(check_balance(&env, &token_id, &t2), 400i128);
    assert_eq!(user_before - user_after, 700i128);
}

/********** Daily Limits Tests (Issue #15) **********/

#[test]
fn test_set_source_daily_limit() {
    let env = Env::default();
    let (admin, _user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    
    bridge.initialize(&admin, &fee_collector, &0u32);
    
    let source = Address::generate(&env);
    bridge.set_source_daily_limit(&source, &token_id, &5000i128).unwrap();
    
    let limit = bridge.query_source_daily_limit(&source, &token_id).unwrap();
    assert_eq!(limit, 5000i128);
}

#[test]
fn test_daily_limit_enforced() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);
    
    bridge.initialize(&admin, &fee_collector, &0u32);
    bridge.add_asset(&token_id);
    bridge.set_source_daily_limit(&user, &token_id, &500i128).unwrap();
    
    mint_tokens(&env, &token_id, &user, 2000i128);
    
    let t1 = Address::generate(&env);
    let t2 = Address::generate(&env);
    
    bridge.fund_c_address(&user, &t1, &token_id, &400i128).unwrap();
    
    assert_eq!(
        bridge.try_fund_c_address(&user, &t2, &token_id, &200i128),
        Err(Ok(BridgeError::DailyLimitExceeded))
    );
}

#[test]
fn test_daily_limit_allows_within_threshold() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);
    
    bridge.initialize(&admin, &fee_collector, &0u32);
    bridge.add_asset(&token_id);
    bridge.set_source_daily_limit(&user, &token_id, &1000i128).unwrap();
    
    mint_tokens(&env, &token_id, &user, 2000i128);
    
    let t1 = Address::generate(&env);
    let t2 = Address::generate(&env);
    
    bridge.fund_c_address(&user, &t1, &token_id, &400i128).unwrap();
    bridge.fund_c_address(&user, &t2, &token_id, &600i128).unwrap();
    
    assert_eq!(check_balance(&env, &token_id, &t1), 400i128);
    assert_eq!(check_balance(&env, &token_id, &t2), 600i128);
}

#[test]
fn test_daily_limit_default_unlimited() {
    let env = Env::default();
    let (admin, user, fee_collector) = create_test_users(&env);
    let (bridge_id, token_id) = register_all_contracts(&env);
    let bridge = create_bridge_client(&env, &bridge_id);
    init_token(&env, &token_id, &admin);
    
    bridge.initialize(&admin, &fee_collector, &0u32);
    bridge.add_asset(&token_id);
    
    mint_tokens(&env, &token_id, &user, 100000i128);
    
    let target = Address::generate(&env);
    bridge.fund_c_address(&user, &target, &token_id, &50000i128).unwrap();
    
    assert_eq!(check_balance(&env, &token_id, &target), 50000i128);
}
