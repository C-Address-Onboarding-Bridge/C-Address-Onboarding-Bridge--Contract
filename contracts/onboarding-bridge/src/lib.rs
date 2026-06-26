#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, BytesN, Env, Map, Vec,
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
    AssetNotWhitelisted = 10,
    DailyLimitExceeded = 11,
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
    AssetWhitelist,
    SourceDailyLimit(Address, Address),
    SourceDailyUsage(Address, Address),
    AssetFeeCap(Address),
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

fn save_minimum_amount(env: &Env, amount: &i128) {
    env.storage().instance().set(&DataKey::MinimumAmount, amount);
}

fn read_minimum_amount(env: &Env) -> i128 {
    env.storage().instance().get(&DataKey::MinimumAmount).unwrap_or(0)
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

fn read_whitelist(env: &Env) -> Map<Address, bool> {
    env.storage()
        .instance()
        .get(&DataKey::AssetWhitelist)
        .unwrap_or_else(|| Map::new(env))
}

fn save_whitelist(env: &Env, whitelist: &Map<Address, bool>) {
    env.storage()
        .instance()
        .set(&DataKey::AssetWhitelist, whitelist);
}

fn check_asset_whitelisted(env: &Env, asset: &Address) -> Result<(), BridgeError> {
    if !read_whitelist(env).get(asset.clone()).unwrap_or(false) {
        return Err(BridgeError::AssetNotWhitelisted);
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

fn save_source_daily_limit(env: &Env, source: &Address, asset: &Address, limit: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::SourceDailyLimit(source.clone(), asset.clone()), &limit);
}

fn read_source_daily_limit(env: &Env, source: &Address, asset: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::SourceDailyLimit(source.clone(), asset.clone()))
        .unwrap_or(i128::MAX)
}

fn read_source_daily_usage(env: &Env, source: &Address, asset: &Address) -> (i128, u64) {
    env.storage()
        .persistent()
        .get(&DataKey::SourceDailyUsage(source.clone(), asset.clone()))
        .unwrap_or((0, 0))
}

fn save_source_daily_usage(env: &Env, source: &Address, asset: &Address, amount: i128, timestamp: u64) {
    env.storage()
        .persistent()
        .set(&DataKey::SourceDailyUsage(source.clone(), asset.clone()), &(amount, timestamp));
}

fn check_daily_limit(env: &Env, source: &Address, asset: &Address, amount: i128) -> Result<(), BridgeError> {
    let limit = read_source_daily_limit(env, source, asset);
    let (current_usage, last_ts) = read_source_daily_usage(env, source, asset);
    let now = env.ledger().timestamp();
    
    let usage = if now - last_ts >= 86400 {
        0
    } else {
        current_usage
    };
    
    if usage + amount > limit {
        return Err(BridgeError::DailyLimitExceeded);
    }
    
    save_source_daily_usage(env, source, asset, usage + amount, now);
    Ok(())
}

fn save_asset_fee_cap(env: &Env, asset: &Address, fee_bps: u32) {
    env.storage()
        .persistent()
        .set(&DataKey::AssetFeeCap(asset.clone()), &fee_bps);
}

fn read_asset_fee_cap(env: &Env, asset: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::AssetFeeCap(asset.clone()))
        .unwrap_or(MAX_FEE_BPS)
}

fn get_effective_fee_bps(env: &Env, asset: &Address, global_fee_bps: u32) -> u32 {
    let asset_cap = read_asset_fee_cap(env, asset);
    std::cmp::min(global_fee_bps, asset_cap)
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
        check_access(&env, &target)?;
        check_asset_whitelisted(&env, &asset)?;
        check_daily_limit(&env, &source, &asset, amount)?;
        source.require_auth();

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&source, &env.current_contract_address(), &amount);

        let global_fee_bps = read_fee_bps(&env);
        let effective_fee_bps = get_effective_fee_bps(&env, &asset, global_fee_bps);
        let fee = calculate_fee(amount, effective_fee_bps);
        let net_amount = amount - fee;

        if net_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &target, &net_amount);
        }

        increment_accrued_fees(&env, &asset, fee);
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
        check_asset_whitelisted(&env, &asset)?;
        source.require_auth();

        let min_amount = read_min_amount(&env);
        let mut total: i128 = 0;
        for i in 0..targets.len() {
            let amount = amounts.get(i).unwrap();
            if amount <= 0 {
                return Err(BridgeError::InvalidAmount);
            }
            if amount < min_amount {
                return Err(BridgeError::BelowMinimum);
            }
            total += amount;
        }

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&source, &env.current_contract_address(), &total);

        let fee_bps = read_fee_bps(&env);
        let contract_addr = env.current_contract_address();
        let mut num_success = 0u32;
        let mut num_failures = 0u32;
        let mut refund_amount = 0i128;

        for i in 0..targets.len() {
            let target = targets.get(i).unwrap();
            let amount = amounts.get(i).unwrap();
            
            let effective_fee_bps = get_effective_fee_bps(&env, &asset, fee_bps);
            let fee = calculate_fee(amount, effective_fee_bps);
            let net_amount = amount - fee;

            if check_access(&env, &target).is_err() {
                num_failures += 1;
                refund_amount += amount;
                env.events().publish(
                    ("BatchTransferFailed", source.clone(), target.clone()),
                    (amount, "access_denied"),
                );
                continue;
            }

            if net_amount > 0 {
                token_client.transfer(&contract_addr, &target, &net_amount);
            }
            num_success += 1;
            increment_accrued_fees(&env, &asset, fee);
            env.events().publish(
                ("CAddressFunded", source.clone(), target),
                (amount, fee, asset.clone()),
            );
        }

        if refund_amount > 0 {
            token_client.transfer(&contract_addr, &source, &refund_amount);
        }

        env.events().publish(
            ("BatchCompleted", source),
            (num_success, num_failures),
        );
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

    pub fn set_source_daily_limit(
        env: Env,
        source: Address,
        asset: Address,
        limit_amount: i128,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        save_source_daily_limit(&env, &source, &asset, limit_amount);
        Ok(())
    }

    pub fn query_source_daily_limit(
        env: Env,
        source: Address,
        asset: Address,
    ) -> Result<i128, BridgeError> {
        check_initialized(&env)?;
        Ok(read_source_daily_limit(&env, &source, &asset))
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

    pub fn set_minimum_amount(env: Env, amount: i128) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        if amount < 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let admin = read_admin(&env);
        admin.require_auth();
        save_minimum_amount(&env, &amount);
        Ok(())
    }

    pub fn query_minimum_amount(env: Env) -> Result<i128, BridgeError> {
        check_initialized(&env)?;
        Ok(read_minimum_amount(&env))
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

    pub fn reclaim_tokens(
        env: Env,
        asset: Address,
        amount: i128,
        to: Address,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let admin = read_admin(&env);
        admin.require_auth();

        let token_client = token::Client::new(&env, &asset);
        token_client.transfer(&env.current_contract_address(), &to, &amount);

        env.events()
            .publish(("TokensReclaimed", admin, to), (amount, asset));
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

    pub fn set_minimum_amount(env: Env, min_amount: i128) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        env.storage().instance().set(&DataKey::MinAmount, &min_amount);
        Ok(())
    }

    pub fn query_minimum_amount(env: Env) -> i128 {
        read_min_amount(&env)
    }

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

    // --- Asset Whitelist ---

    pub fn add_asset(env: Env, asset: Address) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        let mut whitelist = read_whitelist(&env);
        whitelist.set(asset, true);
        save_whitelist(&env, &whitelist);
        Ok(())
    }

    pub fn remove_asset(env: Env, asset: Address) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        let mut whitelist = read_whitelist(&env);
        whitelist.remove(asset);
        save_whitelist(&env, &whitelist);
        Ok(())
    }

    pub fn query_is_asset_whitelisted(env: Env, asset: Address) -> Result<bool, BridgeError> {
        check_initialized(&env)?;
        Ok(read_whitelist(&env).get(asset).unwrap_or(false))
    }

    pub fn query_whitelisted_assets(env: Env) -> Result<Vec<Address>, BridgeError> {
        check_initialized(&env)?;
        Ok(read_whitelist(&env).keys())
    }
}

#[cfg(test)]
mod tests;
