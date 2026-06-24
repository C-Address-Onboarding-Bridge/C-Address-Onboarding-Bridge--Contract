#![no_std]

use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env, Vec};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum BridgeError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    InvalidAmount = 3,
    FeeTooHigh = 4,
    MismatchedArrays = 5,
}

#[contracttype]
pub enum DataKey {
    Admin,
    FeeCollector,
    FeeBps,
    Initialized,
    AccruedFees(Address),
}

const MAX_FEE_BPS: u32 = 1_000;
const FEE_DENOMINATOR: i128 = 10_000;

fn save_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

fn save_fee_collector(env: &Env, addr: &Address) {
    env.storage().instance().set(&DataKey::FeeCollector, addr);
}

fn read_fee_collector(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::FeeCollector)
        .unwrap()
}

fn save_fee_bps(env: &Env, fee_bps: &u32) {
    env.storage().instance().set(&DataKey::FeeBps, fee_bps);
}

fn read_fee_bps(env: &Env) -> u32 {
    env.storage().instance().get(&DataKey::FeeBps).unwrap_or(0)
}

fn read_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Initialized)
}

fn mark_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Initialized, &true);
}

fn check_initialized(env: &Env) {
    if !read_initialized(env) {
        panic!("not initialized");
    }
}

fn calculate_fee(amount: i128, fee_bps: u32) -> i128 {
    (amount * fee_bps as i128) / FEE_DENOMINATOR
}

fn read_accrued_fees(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::AccruedFees(asset.clone()))
        .unwrap_or(0)
}

fn increment_accrued_fees(env: &Env, asset: &Address, fee: i128) {
    let current = read_accrued_fees(env, asset);
    env.storage()
        .persistent()
        .set(&DataKey::AccruedFees(asset.clone()), &(current + fee));
}

fn decrement_accrued_fees(env: &Env, asset: &Address, amount: i128) {
    let current = read_accrued_fees(env, asset);
    env.storage()
        .persistent()
        .set(&DataKey::AccruedFees(asset.clone()), &(current - amount));
}

#[contract]
pub struct OnboardingBridge;

#[contractimpl]
impl OnboardingBridge {
    pub fn initialize(env: Env, admin: Address, fee_collector: Address, fee_bps: u32) {
        if read_initialized(&env) {
            panic!("already initialized");
        }
        if fee_bps > MAX_FEE_BPS {
            panic!("fee too high");
        }
        admin.require_auth();
        save_admin(&env, &admin);
        save_fee_collector(&env, &fee_collector);
        save_fee_bps(&env, &fee_bps);
        mark_initialized(&env);
    }

    pub fn fund_c_address(
        env: Env,
        source: Address,
        target: Address,
        asset: Address,
        amount: i128,
    ) {
        check_initialized(&env);
        if amount <= 0 {
            panic!("invalid amount");
        }
        source.require_auth();

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&source, &env.current_contract_address(), &amount);

        let fee_bps = read_fee_bps(&env);
        let fee = calculate_fee(amount, fee_bps);
        let net_amount = amount - fee;

        if net_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &target, &net_amount);
        }

        env.events()
            .publish(("CAddressFunded", source, target), (amount, fee, asset));
    }

    pub fn batch_fund_c_address(
        env: Env,
        source: Address,
        targets: Vec<Address>,
        amounts: Vec<i128>,
        asset: Address,
    ) {
        check_initialized(&env);
        if targets.len() != amounts.len() {
            panic!("mismatched arrays");
        }
        if targets.len() == 0 {
            return;
        }
        source.require_auth();

        let mut total: i128 = 0;
        for i in 0..targets.len() {
            let amount = amounts.get(i).unwrap();
            if amount <= 0 {
                panic!("invalid amount");
            }
            total += amount;
        }

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&source, &env.current_contract_address(), &total);

        let fee_bps = read_fee_bps(&env);
        let contract_addr = env.current_contract_address();

        for i in 0..targets.len() {
            let target = targets.get(i).unwrap();
            let amount = amounts.get(i).unwrap();
            let fee = calculate_fee(amount, fee_bps);
            let net_amount = amount - fee;

            if net_amount > 0 {
                token_client.transfer(&contract_addr, &target, &net_amount);
            }

            if fee > 0 {
                increment_accrued_fees(&env, &asset, fee);
            }

            env.events().publish(
                ("CAddressFunded", source.clone(), target),
                (amount, fee, asset.clone()),
            );
        }
    }

    pub fn set_fee_bps(env: Env, new_fee_bps: u32) {
        check_initialized(&env);
        if new_fee_bps > MAX_FEE_BPS {
            panic!("fee too high");
        }
        let admin = read_admin(&env);
        admin.require_auth();
        save_fee_bps(&env, &new_fee_bps);
    }

    pub fn set_fee_collector(env: Env, new_fee_collector: Address) {
        check_initialized(&env);
        let admin = read_admin(&env);
        admin.require_auth();
        save_fee_collector(&env, &new_fee_collector);
    }

    pub fn set_admin(env: Env, new_admin: Address) {
        check_initialized(&env);
        let admin = read_admin(&env);
        admin.require_auth();
        save_admin(&env, &new_admin);
    }

    pub fn withdraw_fees(env: Env, asset: Address, amount: i128) {
        check_initialized(&env);
        if amount <= 0 {
            panic!("invalid amount");
        }
        let fee_collector = read_fee_collector(&env);
        fee_collector.require_auth();

        let accrued = read_accrued_fees(&env, &asset);
        if amount > accrued {
            panic!("amount exceeds accrued fees");
        }

        decrement_accrued_fees(&env, &asset, amount);

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&env.current_contract_address(), &fee_collector, &amount);

        env.events()
            .publish(("FeesWithdrawn", fee_collector), (amount, asset));
    }

    pub fn query_fee_bps(env: Env) -> u32 {
        check_initialized(&env);
        read_fee_bps(&env)
    }

    pub fn query_fee_collector(env: Env) -> Address {
        check_initialized(&env);
        read_fee_collector(&env)
    }

    pub fn query_admin(env: Env) -> Address {
        check_initialized(&env);
        read_admin(&env)
    }

    pub fn query_balance(env: Env, c_address: Address, asset: Address) -> i128 {
        let token_client = token::Client::new(&env, &asset);
        token_client.balance(&c_address)
    }

    pub fn query_is_initialized(env: Env) -> bool {
        read_initialized(&env)
    }

    pub fn query_accrued_fees(env: Env, asset: Address) -> i128 {
        check_initialized(&env);
        read_accrued_fees(&env, &asset)
    }
}

#[cfg(test)]
mod tests;
