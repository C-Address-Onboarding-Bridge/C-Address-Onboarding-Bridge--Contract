use crate::{OnboardingBridge, MAX_FEE_BPS};
use proptest::prelude::*;
use soroban_sdk::{
    contract, contractimpl, contracttype,
    testutils::Address as _,
    Address, Env, IntoVal,
};

#[contracttype]
enum TokenKey {
    Admin,
    Balance(Address),
    Decimal,
    Name,
    Symbol,
}

#[contract]
struct FuzzToken;

#[contractimpl]
impl FuzzToken {
    pub fn initialize(
        env: Env,
        admin: Address,
        decimal: u32,
        name: soroban_sdk::String,
        symbol: soroban_sdk::String,
    ) {
        env.storage().instance().set(&TokenKey::Admin, &admin);
        env.storage().instance().set(&TokenKey::Decimal, &decimal);
        env.storage().instance().set(&TokenKey::Name, &name);
        env.storage().instance().set(&TokenKey::Symbol, &symbol);
    }

    pub fn mint(env: Env, to: Address, amount: i128) {
        let admin: Address = env.storage().instance().get(&TokenKey::Admin).unwrap();
        admin.require_auth();
        let balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&TokenKey::Balance(to), &(balance + amount));
    }

    pub fn balance(env: Env, id: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&TokenKey::Balance(id))
            .unwrap_or(0)
    }

    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        if from == to {
            return;
        }

        let from_balance = Self::balance(env.clone(), from.clone());
        if from_balance < amount {
            panic!("insufficient balance");
        }

        let to_balance = Self::balance(env.clone(), to.clone());
        env.storage()
            .persistent()
            .set(&TokenKey::Balance(from), &(from_balance - amount));
        env.storage()
            .persistent()
            .set(&TokenKey::Balance(to), &(to_balance + amount));
    }
}

fn setup_bridge<'a>(
    env: &'a Env,
    fee_bps: u32,
) -> (
    crate::OnboardingBridgeClient<'a>,
    Address,
    Address,
    Address,
    FuzzTokenClient<'a>,
) {
    env.mock_all_auths();

    let admin = Address::generate(env);
    let user = Address::generate(env);
    let fee_collector = Address::generate(env);
    let bridge_id = env.register(OnboardingBridge, ());
    let token_id = env.register(FuzzToken, ());

    let token = FuzzTokenClient::new(env, &token_id);
    token.initialize(
        &admin,
        &7u32,
        &"Test".into_val(env),
        &"TST".into_val(env),
    );

    let bridge = crate::OnboardingBridgeClient::new(env, &bridge_id);
    bridge.initialize(&admin, &fee_collector, &fee_bps, &None);
    bridge.add_asset(&token_id, &None);

    (bridge, token_id, admin, user, token)
}

fn assert_funding_invariants(amount: i128, fee_bps: u32) -> Result<(), TestCaseError> {
    let env = Env::default();
    let (bridge, token_id, _admin, user, token) = setup_bridge(&env, fee_bps);
    let target = Address::generate(&env);

    token.mint(&user, &amount);
    let pre_accrued = bridge.query_accrued_fees(&token_id);

    let result = bridge.try_fund_c_address(&user, &target, &token_id, &amount, &None, &None);
    prop_assert!(
        matches!(result, Ok(Ok(()))),
        "fund_c_address failed for amount={amount}, fee_bps={fee_bps}: {result:?}"
    );

    let post_accrued = bridge.query_accrued_fees(&token_id);
    let target_balance = token.balance(&target);
    let accrued_delta = post_accrued - pre_accrued;

    prop_assert!(accrued_delta <= amount);
    prop_assert_eq!(accrued_delta + target_balance, amount);
    prop_assert_eq!(token.balance(&user), 0);

    Ok(())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, .. ProptestConfig::default() })]

    #[test]
    fn fund_c_address_fee_invariants_hold_for_random_amounts(
        amount in 1i128..=1_000_000_000_000i128,
        fee_bps in 0u32..=MAX_FEE_BPS,
    ) {
        assert_funding_invariants(amount, fee_bps)?;
    }
}

#[test]
fn fund_c_address_fee_invariants_hold_for_explicit_edges() {
    let cases = [
        (1i128, 0u32),
        (1i128, 1u32),
        (1i128, MAX_FEE_BPS),
        (100i128, MAX_FEE_BPS),
        (1_000_000_000_000i128, 1u32),
        (1_000_000_000_000i128, MAX_FEE_BPS),
    ];

    for (amount, fee_bps) in cases {
        assert_funding_invariants(amount, fee_bps).unwrap();
    }
}
