#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Vec,
};

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum BridgeError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    InvalidAmount = 3,
    FeeTooHigh = 4,
    MismatchedArrays = 5,
    ContractPaused = 6,
}

#[contracttype]
pub enum DataKey {
    Admin,
    FeeCollector,
    FeeBps,
    Initialized,
    Paused,
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

fn check_initialized(env: &Env) -> Result<(), BridgeError> {
    if !read_initialized(env) {
        return Err(BridgeError::NotInitialized);
    }
    Ok(())
}

fn read_paused(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::Paused)
        .unwrap_or(false)
}

fn check_not_paused(env: &Env) -> Result<(), BridgeError> {
    if read_paused(env) {
        return Err(BridgeError::ContractPaused);
    }
    Ok(())
}

fn calculate_fee(amount: i128, fee_bps: u32) -> i128 {
    (amount * fee_bps as i128) / FEE_DENOMINATOR
}

#[contract]
pub struct OnboardingBridge;

#[contractimpl]
impl OnboardingBridge {
    pub fn initialize(
        env: Env,
        admin: Address,
        fee_collector: Address,
        fee_bps: u32,
    ) -> Result<(), BridgeError> {
        if read_initialized(&env) {
            return Err(BridgeError::AlreadyInitialized);
        }
        if fee_bps > MAX_FEE_BPS {
            return Err(BridgeError::FeeTooHigh);
        }
        admin.require_auth();
        save_admin(&env, &admin);
        save_fee_collector(&env, &fee_collector);
        save_fee_bps(&env, &fee_bps);
        mark_initialized(&env);
        Ok(())
    }

    pub fn fund_c_address(
        env: Env,
        source: Address,
        target: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
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
        Ok(())
    }

    pub fn batch_fund_c_address(
        env: Env,
        source: Address,
        targets: Vec<Address>,
        amounts: Vec<i128>,
        asset: Address,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if targets.len() != amounts.len() {
            return Err(BridgeError::MismatchedArrays);
        }
        if targets.len() == 0 {
            return Ok(());
        }
        source.require_auth();

        let mut total: i128 = 0;
        for i in 0..targets.len() {
            let amount = amounts.get(i).unwrap();
            if amount <= 0 {
                return Err(BridgeError::InvalidAmount);
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

            env.events().publish(
                ("CAddressFunded", source.clone(), target),
                (amount, fee, asset.clone()),
            );
        }
        Ok(())
    }

    pub fn set_fee_bps(env: Env, new_fee_bps: u32) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if new_fee_bps > MAX_FEE_BPS {
            return Err(BridgeError::FeeTooHigh);
        }
        let admin = read_admin(&env);
        admin.require_auth();
        save_fee_bps(&env, &new_fee_bps);
        Ok(())
    }

    pub fn set_fee_collector(env: Env, new_fee_collector: Address) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        save_fee_collector(&env, &new_fee_collector);
        Ok(())
    }

    pub fn set_admin(env: Env, new_admin: Address) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        save_admin(&env, &new_admin);
        Ok(())
    }

    pub fn withdraw_fees(env: Env, asset: Address, amount: i128) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let fee_collector = read_fee_collector(&env);
        fee_collector.require_auth();

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&env.current_contract_address(), &fee_collector, &amount);

        env.events()
            .publish(("FeesWithdrawn", fee_collector), (amount, asset));
        Ok(())
    }

    pub fn query_fee_bps(env: Env) -> Result<u32, BridgeError> {
        check_initialized(&env)?;
        Ok(read_fee_bps(&env))
    }

    pub fn query_fee_collector(env: Env) -> Result<Address, BridgeError> {
        check_initialized(&env)?;
        Ok(read_fee_collector(&env))
    }

    pub fn query_admin(env: Env) -> Result<Address, BridgeError> {
        check_initialized(&env)?;
        Ok(read_admin(&env))
    }

    pub fn query_balance(env: Env, c_address: Address, asset: Address) -> i128 {
        let token_client = token::Client::new(&env, &asset);
        token_client.balance(&c_address)
    }

    pub fn query_is_initialized(env: Env) -> bool {
        read_initialized(&env)
    }

    pub fn pause(env: Env) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish(("ContractPaused",), (admin,));
        Ok(())
    }

    pub fn unpause(env: Env) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(("ContractUnpaused",), (admin,));
        Ok(())
    }

    pub fn query_is_paused(env: Env) -> bool {
        read_paused(&env)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.events().publish(("Upgraded",), (admin, new_wasm_hash));
        Ok(())
    }
}

#[cfg(test)]
mod tests;
