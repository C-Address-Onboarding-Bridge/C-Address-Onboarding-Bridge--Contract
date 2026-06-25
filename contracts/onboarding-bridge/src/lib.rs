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
    AddressBlocked = 7,
    AddressNotAllowlisted = 8,
    InsufficientReclaimable = 9,
}

#[contracttype]
pub enum DataKey {
    Admin,
    FeeCollector,
    FeeBps,
    Initialized,
    Paused,
    Blocked(Address),
    Allowlisted(Address),
    AllowlistMode,
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

fn is_blocked(env: &Env, addr: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Blocked(addr.clone()))
        .unwrap_or(false)
}

fn is_allowlisted(env: &Env, addr: &Address) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Allowlisted(addr.clone()))
        .unwrap_or(false)
}

fn allowlist_mode(env: &Env) -> bool {
    env.storage()
        .instance()
        .get(&DataKey::AllowlistMode)
        .unwrap_or(false)
}

fn check_access(env: &Env, target: &Address) -> Result<(), BridgeError> {
    if is_blocked(env, target) {
        return Err(BridgeError::AddressBlocked);
    }
    if allowlist_mode(env) && !is_allowlisted(env, target) {
        return Err(BridgeError::AddressNotAllowlisted);
    }
    Ok(())
}

fn read_accrued_fees(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::AccruedFees(asset.clone()))
        .unwrap_or(0)
}

fn increment_accrued_fees(env: &Env, asset: &Address, amount: i128) {
    let current = read_accrued_fees(env, asset);
    env.storage()
        .persistent()
        .set(&DataKey::AccruedFees(asset.clone()), &(current + amount));
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

    /// Funds a single C-address with tokens from a source account.
    ///
    /// The contract transfers the gross amount from `source`, deducts the configured fee, sends the net amount to `target`, and records the fee balance on the contract.
    ///
    /// # Arguments
    /// * `env` - Soroban environment for token calls and events.
    /// * `source` - Account providing tokens; must authorize the transfer.
    /// * `target` - C-address receiving the net amount.
    /// * `asset` - Token contract address.
    /// * `amount` - Gross amount before fee deduction.
    ///
    /// # Authorization
    /// Requires authorization from `source`.
    ///
    /// # Events
    /// Emits `CAddressFunded` with source, target, asset, net amount, and fee.
    ///
    /// # Panics
    /// Panics if the contract is not initialized, amount is non-positive, auth fails, or the token transfer fails.
    ///
    /// # Security
    /// Validate the target C-address and asset before asking a user to sign.
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
        check_access(&env, &target)?;
        source.require_auth();

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&source, &env.current_contract_address(), &amount);

        let fee_bps = read_fee_bps(&env);
        let fee = calculate_fee(amount, fee_bps);
        let net_amount = amount - fee;

        if net_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &target, &net_amount);
        }

        increment_accrued_fees(&env, &asset, fee);
        env.events()
            .publish(("CAddressFunded", source, target), (amount, fee, asset));
        Ok(())
    }

    /// Funds multiple C-addresses in one transaction.
    ///
    /// # Arguments
    /// * `env` - Soroban environment for token calls and events.
    /// * `source` - Account providing tokens for every transfer; must authorize once.
    /// * `targets` - C-address recipients.
    /// * `asset` - Token contract address shared by the batch.
    /// * `amounts` - Gross amounts matching the `targets` order.
    ///
    /// # Authorization
    /// Requires authorization from `source`.
    ///
    /// # Events
    /// Emits one `CAddressFunded` event for each successful target transfer.
    ///
    /// # Panics
    /// Panics if the contract is not initialized, array lengths differ, an amount is invalid, authorization fails, or token transfer fails.
    ///
    /// # Security
    /// Callers should cap batch sizes at the UI or service layer to keep fees and execution costs predictable.
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
            check_access(&env, &target)?;
            let fee = calculate_fee(amount, fee_bps);
            let net_amount = amount - fee;

            if net_amount > 0 {
                token_client.transfer(&contract_addr, &target, &net_amount);
            }

            increment_accrued_fees(&env, &asset, fee);
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

        decrement_accrued_fees(&env, &asset, amount);
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

    /// Reads a token balance for an address.
    ///
    /// # Arguments
    /// * `env` - Soroban environment for token client calls.
    /// * `c_address` - Address whose balance should be read.
    /// * `asset` - Token contract address.
    ///
    /// # Returns
    /// Token balance as an `i128` amount.
    ///
    /// # Panics
    /// Panics if the token contract call fails.
    pub fn query_balance(env: Env, c_address: Address, asset: Address) -> i128 {
        let token_client = token::Client::new(&env, &asset);
        token_client.balance(&c_address)
    }

    pub fn query_fee_balance(env: Env, asset: Address) -> Result<i128, BridgeError> {
        check_initialized(&env)?;
        let token_client = token::Client::new(&env, &asset);
        Ok(token_client.balance(&env.current_contract_address()))
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

    // --- Blocklist / Allowlist ---

    pub fn add_to_blocklist(env: Env, address: Address) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        read_admin(&env).require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::Blocked(address), &true);
        Ok(())
    }

    pub fn remove_from_blocklist(env: Env, address: Address) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        read_admin(&env).require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Blocked(address));
        Ok(())
    }

    pub fn add_to_allowlist(env: Env, address: Address) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        read_admin(&env).require_auth();
        env.storage()
            .persistent()
            .set(&DataKey::Allowlisted(address), &true);
        Ok(())
    }

    pub fn remove_from_allowlist(env: Env, address: Address) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        read_admin(&env).require_auth();
        env.storage()
            .persistent()
            .remove(&DataKey::Allowlisted(address));
        Ok(())
    }

    pub fn set_allowlist_mode(env: Env, enabled: bool) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        read_admin(&env).require_auth();
        env.storage()
            .instance()
            .set(&DataKey::AllowlistMode, &enabled);
        Ok(())
    }

    pub fn query_is_blocked(env: Env, address: Address) -> bool {
        is_blocked(&env, &address)
    }

    pub fn query_is_allowlisted(env: Env, address: Address) -> bool {
        is_allowlisted(&env, &address)
    }

    pub fn query_allowlist_mode(env: Env) -> bool {
        allowlist_mode(&env)
    }

    pub fn reclaim_tokens(
        env: Env,
        asset: Address,
        amount: i128,
        destination: Address,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let admin = read_admin(&env);
        admin.require_auth();

        let token_client = token::Client::new(&env, &asset);
        let contract_balance = token_client.balance(&env.current_contract_address());
        let accrued = read_accrued_fees(&env, &asset);
        let reclaimable = contract_balance - accrued;

        if reclaimable < amount {
            return Err(BridgeError::InsufficientReclaimable);
        }

        token_client.transfer(&env.current_contract_address(), &destination, &amount);
        env.events()
            .publish(("TokensReclaimed", admin, asset), (amount, destination));
        Ok(())
    }
}

#[cfg(test)]
mod tests;
