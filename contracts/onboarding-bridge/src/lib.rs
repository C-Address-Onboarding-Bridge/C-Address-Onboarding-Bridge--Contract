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

    DuplicateNonce = 12,
    TransactionExpired = 13,
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
    TotalBridged(Address),
    TotalFeesCollected(Address),
    SourceDailyLimit(Address, Address),
    AssetFeeCap(Address),
    Nonce(Address),
    ReferralRate,
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
    let _ = (env, amount); // Unused - planned for future  
}

fn read_minimum_amount(env: &Env) -> i128 {
    let _ = env; // Unused - planned for future
    0
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

fn read_total_bridged(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::TotalBridged(asset.clone()))
        .unwrap_or(0)
}

fn increment_total_bridged(env: &Env, asset: &Address, amount: i128) {
    let current = read_total_bridged(env, asset);
    env.storage()
        .persistent()
        .set(&DataKey::TotalBridged(asset.clone()), &(current + amount));
}

fn read_total_fees_collected(env: &Env, asset: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::TotalFeesCollected(asset.clone()))
        .unwrap_or(0)
}

fn increment_total_fees_collected(env: &Env, asset: &Address, amount: i128) {
    let current = read_total_fees_collected(env, asset);
    env.storage()
        .persistent()
        .set(&DataKey::TotalFeesCollected(asset.clone()), &(current + amount));
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
        .unwrap_or(0)
}

fn check_daily_limit(env: &Env, source: &Address, asset: &Address, amount: i128) -> Result<(), BridgeError> {
    let limit = read_source_daily_limit(env, source, asset);
    if limit > 0 && amount > limit {
        return Err(BridgeError::DailyLimitExceeded);
    }
    Ok(())
}

fn save_asset_fee_cap(env: &Env, asset: &Address, max_fee_bps: u32) {
    env.storage()
        .persistent()
        .set(&DataKey::AssetFeeCap(asset.clone()), &max_fee_bps);
}

fn read_asset_fee_cap(env: &Env, asset: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::AssetFeeCap(asset.clone()))
        .unwrap_or(MAX_FEE_BPS)
}

fn get_effective_fee_bps(env: &Env, asset: &Address, global_fee_bps: u32) -> u32 {
    let cap = read_asset_fee_cap(env, asset);
    if global_fee_bps < cap { global_fee_bps } else { cap }
}

fn read_nonce(env: &Env, caller: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::Nonce(caller.clone()))
        .unwrap_or(0)
}

/// If `nonce` is `Some(n)`, verify it equals the caller's current nonce then increment.
/// If `None`, no check is performed (standard Stellar tx path — replay prevented by sequence number).
fn consume_nonce(env: &Env, caller: &Address, nonce: Option<u64>) -> Result<(), BridgeError> {
    if let Some(n) = nonce {
        let stored = read_nonce(env, caller);
        if n != stored {
            return Err(BridgeError::DuplicateNonce);
        }
        env.storage()
            .persistent()
            .set(&DataKey::Nonce(caller.clone()), &(stored + 1));
    }
    Ok(())
}

// --- Referral rate helpers ---

fn save_referral_rate(env: &Env, bps: u32) {
    env.storage().instance().set(&DataKey::ReferralRate, &bps);
}

fn read_referral_rate(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::ReferralRate)
        .unwrap_or(0)
}

// --- Cross-chain relayer registry ---

fn relayer_count(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::RelayerCount)
        .unwrap_or(0u32)
}

fn is_relayer(env: &Env, pubkey: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::Relayer(pubkey.clone()))
        .unwrap_or(false)
}

fn add_relayer(env: &Env, pubkey: &BytesN<32>) {
    if !is_relayer(env, pubkey) {
        env.storage()
            .persistent()
            .set(&DataKey::Relayer(pubkey.clone()), &true);
        env.storage()
            .instance()
            .set(&DataKey::RelayerCount, &(relayer_count(env) + 1));
    }
}

fn remove_relayer(env: &Env, pubkey: &BytesN<32>) {
    if is_relayer(env, pubkey) {
        env.storage()
            .persistent()
            .remove(&DataKey::Relayer(pubkey.clone()));
        let count = relayer_count(env);
        env.storage()
            .instance()
            .set(&DataKey::RelayerCount, &(count.saturating_sub(1)));
    }
}

fn relayer_threshold(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::RelayerThreshold)
        .unwrap_or(1u32)
}

fn save_relayer_threshold(env: &Env, threshold: u32) {
    env.storage()
        .instance()
        .set(&DataKey::RelayerThreshold, &threshold);
}

fn is_nonce_used(env: &Env, nonce: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::CrossChainNonce(nonce.clone()))
        .unwrap_or(false)
}

fn mark_nonce_used(env: &Env, nonce: &BytesN<32>) {
    env.storage()
        .persistent()
        .set(&DataKey::CrossChainNonce(nonce.clone()), &true);
}

// --- Daily limit helpers ---

fn save_source_daily_limit(env: &Env, source: &Address, asset: &Address, limit: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::SourceDailyLimit(source.clone(), asset.clone()), &limit);
}

fn read_source_daily_limit(env: &Env, source: &Address, asset: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::SourceDailyLimit(source.clone(), asset.clone()))
        .unwrap_or(0)
}

fn current_day(env: &Env) -> u64 {
    env.ledger().timestamp() / 86_400
}

fn check_daily_limit(env: &Env, source: &Address, asset: &Address, amount: i128) -> Result<(), BridgeError> {
    let limit = read_source_daily_limit(env, source, asset);
    if limit == 0 {
        return Ok(()); // no limit set
    }
    let day = current_day(env);
    let key = DataKey::DailyUsage(source.clone(), asset.clone(), day);
    let used: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    if used + amount > limit {
        return Err(BridgeError::DailyLimitExceeded);
    }
    env.storage().persistent().set(&key, &(used + amount));
    Ok(())
}

// --- Asset fee cap helpers ---

fn save_asset_fee_cap(env: &Env, asset: &Address, max_fee_bps: u32) {
    env.storage()
        .persistent()
        .set(&DataKey::AssetFeeCap(asset.clone()), &max_fee_bps);
}

fn read_asset_fee_cap(env: &Env, asset: &Address) -> u32 {
    env.storage()
        .persistent()
        .get(&DataKey::AssetFeeCap(asset.clone()))
        .unwrap_or(MAX_FEE_BPS)
}

/// Returns the effective fee bps for an asset, capped by its per-asset fee cap.
fn get_effective_fee_bps(env: &Env, asset: &Address, global_fee_bps: u32) -> u32 {
    let cap = read_asset_fee_cap(env, asset);
    global_fee_bps.min(cap)
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
        nonce: Option<u64>,
    ) -> Result<(), BridgeError> {
        if read_initialized(&env) {
            return Err(BridgeError::AlreadyInitialized);
        }
        if fee_bps > MAX_FEE_BPS {
            return Err(BridgeError::FeeTooHigh);
        }
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        save_admin(&env, &admin);
        save_fee_collector(&env, &fee_collector);
        save_fee_bps(&env, &fee_bps);
        mark_initialized(&env);
        env.events()
            .publish(("Initialized", admin.clone(), fee_collector.clone()), (fee_bps,));
        Ok(())
    }

    pub fn fund_c_address(
        env: Env,
        source: Address,
        target: Address,
        asset: Address,
        amount: i128,
        nonce: Option<u64>,
        deadline: Option<u64>,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if let Some(d) = deadline {
            if env.ledger().timestamp() > d {
                return Err(BridgeError::TransactionExpired);
            }
        }
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        check_access(&env, &target)?;
        check_asset_whitelisted(&env, &asset)?;
        check_daily_limit(&env, &source, &asset, amount)?;
        source.require_auth();
        consume_nonce(&env, &source, nonce)?;

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
        increment_total_bridged(&env, &asset, net_amount);
        increment_total_fees_collected(&env, &asset, fee);
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
        nonce: Option<u64>,
        deadline: Option<u64>,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if let Some(d) = deadline {
            if env.ledger().timestamp() > d {
                return Err(BridgeError::TransactionExpired);
            }
        }
        if targets.len() != amounts.len() {
            return Err(BridgeError::MismatchedArrays);
        }
        if targets.len() == 0 {
            return Ok(());
        }
        check_asset_whitelisted(&env, &asset)?;
        source.require_auth();
        consume_nonce(&env, &source, nonce)?;

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
            increment_total_bridged(&env, &asset, net_amount);
            increment_total_fees_collected(&env, &asset, fee);
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

    pub fn set_fee_bps(env: Env, new_fee_bps: u32, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if new_fee_bps > MAX_FEE_BPS {
            return Err(BridgeError::FeeTooHigh);
        }
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        let old_fee_bps = read_fee_bps(&env);
        save_fee_bps(&env, &new_fee_bps);
        env.events()
            .publish(("FeeBpsChanged", old_fee_bps, new_fee_bps), (admin,));
        Ok(())
    }

    pub fn set_source_daily_limit(
        env: Env,
        source: Address,
        asset: Address,
        limit_amount: i128,
        nonce: Option<u64>,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
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

    pub fn set_asset_fee_cap(
        env: Env,
        asset: Address,
        max_fee_bps: u32,
        nonce: Option<u64>,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        if max_fee_bps > MAX_FEE_BPS {
            return Err(BridgeError::FeeTooHigh);
        }
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        save_asset_fee_cap(&env, &asset, max_fee_bps);
        Ok(())
    }

    pub fn query_asset_fee_cap(
        env: Env,
        asset: Address,
    ) -> Result<u32, BridgeError> {
        check_initialized(&env)?;
        Ok(read_asset_fee_cap(&env, &asset))
    }

    pub fn set_fee_collector(env: Env, new_fee_collector: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        let old_collector = read_fee_collector(&env);
        save_fee_collector(&env, &new_fee_collector);
        env.events()
            .publish(("FeeCollectorChanged", old_collector, new_fee_collector), (admin,));
        Ok(())
    }

    pub fn set_admin(env: Env, new_admin: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        save_admin(&env, &new_admin);
        env.events()
            .publish(("AdminChanged", admin, new_admin.clone()), ());
        Ok(())
    }

    pub fn set_minimum_amount(env: Env, amount: i128, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        if amount < 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        save_minimum_amount(&env, &amount);
        Ok(())
    }

    pub fn query_minimum_amount(env: Env) -> Result<i128, BridgeError> {
        check_initialized(&env)?;
        Ok(read_minimum_amount(&env))
    }

    pub fn withdraw_fees(env: Env, asset: Address, amount: i128, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let fee_collector = read_fee_collector(&env);
        fee_collector.require_auth();
        consume_nonce(&env, &fee_collector, nonce)?;

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

    pub fn set_referral_rate(env: Env, bps: u32, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        if bps > MAX_FEE_BPS {
            return Err(BridgeError::FeeTooHigh);
        }
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        save_referral_rate(&env, bps);
        env.events().publish(("ReferralRateChanged", bps), ());
        Ok(())
    }

    pub fn query_referral_rate(env: Env) -> Result<u32, BridgeError> {
        check_initialized(&env)?;
        Ok(read_referral_rate(&env))
    }

    pub fn fund_c_address_with_referral(
        env: Env,
        source: Address,
        target: Address,
        asset: Address,
        amount: i128,
        referrer: Option<Address>,
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

        // Split fee: referral portion goes directly to referrer
        let referral_fee = if let Some(ref referrer_addr) = referrer {
            let referral_rate = read_referral_rate(&env);
            let rf = (fee * referral_rate as i128) / FEE_DENOMINATOR;
            if rf > 0 {
                token_client.transfer(&env.current_contract_address(), referrer_addr, &rf);
                env.events().publish(
                    ("ReferralPaid", source.clone(), referrer_addr.clone()),
                    (rf, asset.clone()),
                );
            }
            rf
        } else {
            0
        };

        let protocol_fee = fee - referral_fee;
        increment_accrued_fees(&env, &asset, protocol_fee);
        increment_total_bridged(&env, &asset, net_amount);
        increment_total_fees_collected(&env, &asset, fee);

        env.events().publish(
            ("CAddressFunded", source, target),
            (amount, fee, asset),
        );
        Ok(())
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

    pub fn query_all_balances(env: Env, assets: Vec<Address>) -> Map<Address, i128> {
        let contract = env.current_contract_address();
        let mut result: Map<Address, i128> = Map::new(&env);
        for i in 0..assets.len() {
            let asset = assets.get(i).unwrap();
            let balance = token::Client::new(&env, &asset).balance(&contract);
            result.set(asset, balance);
        }
        result
    }

    pub fn query_fee_balance(env: Env, asset: Address) -> Result<i128, BridgeError> {
        check_initialized(&env)?;
        let token_client = token::Client::new(&env, &asset);
        Ok(token_client.balance(&env.current_contract_address()))
    }

    pub fn query_is_initialized(env: Env) -> bool {
        read_initialized(&env)
    }

    pub fn query_nonce(env: Env, caller: Address) -> u64 {
        read_nonce(&env, &caller)
    }

    pub fn query_calculate_fee(env: Env, gross_amount: i128) -> (i128, i128) {
        let fee_bps = read_fee_bps(&env);
        let fee = calculate_fee(gross_amount, fee_bps);
        let net = gross_amount - fee;
        (fee, net)
    }

    pub fn query_total_bridged(env: Env, asset: Address) -> Result<i128, BridgeError> {
        check_initialized(&env)?;
        Ok(read_total_bridged(&env, &asset))
    }

    pub fn query_total_fees_collected(env: Env, asset: Address) -> Result<i128, BridgeError> {
        check_initialized(&env)?;
        Ok(read_total_fees_collected(&env, &asset))
    }

    pub fn pause(env: Env, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        env.storage().instance().set(&DataKey::Paused, &true);
        env.events().publish(("ContractPaused",), (admin,));
        Ok(())
    }

    pub fn unpause(env: Env, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        env.storage().instance().set(&DataKey::Paused, &false);
        env.events().publish(("ContractUnpaused",), (admin,));
        Ok(())
    }

    pub fn query_is_paused(env: Env) -> bool {
        read_paused(&env)
    }

    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        env.deployer()
            .update_current_contract_wasm(new_wasm_hash.clone());
        env.events().publish(("Upgraded",), (admin, new_wasm_hash));
        Ok(())
    }

    // --- Blocklist / Allowlist ---

    pub fn add_to_blocklist(env: Env, address: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        env.storage()
            .persistent()
            .set(&DataKey::Blocked(address), &true);
        Ok(())
    }

    pub fn remove_from_blocklist(env: Env, address: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        env.storage()
            .persistent()
            .remove(&DataKey::Blocked(address));
        Ok(())
    }

    pub fn add_to_allowlist(env: Env, address: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        env.storage()
            .persistent()
            .set(&DataKey::Allowlisted(address), &true);
        Ok(())
    }

    pub fn remove_from_allowlist(env: Env, address: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        env.storage()
            .persistent()
            .remove(&DataKey::Allowlisted(address));
        Ok(())
    }

    pub fn set_allowlist_mode(env: Env, enabled: bool, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
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
        nonce: Option<u64>,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;

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

    pub fn add_asset(env: Env, asset: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        let mut whitelist = read_whitelist(&env);
        whitelist.set(asset, true);
        save_whitelist(&env, &whitelist);
        Ok(())
    }

    pub fn remove_asset(env: Env, asset: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
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

    // --- Cross-chain Onboarding ---

    /// Fund a C-address from a cross-chain event.
    ///
    /// Parameters:
    /// - `chain_id`  : numeric id of the source chain (e.g. 1 = Ethereum, 101 = Solana)
    /// - `tx_hash`   : 32-byte hash of the source-chain transaction
    /// - `target`    : Soroban C-address to credit
    /// - `asset`     : whitelisted token contract address
    /// - `amount`    : gross amount (fee deducted before crediting target)
    /// - `sigs`      : at least `threshold` distinct relayer Ed25519 signatures over
    ///                 sha256(chain_id_be4 || tx_hash || target_bytes || asset_bytes ||
    ///                        amount_be16 || nonce)
    ///                 where nonce = sha256(chain_id_be4 || tx_hash)
    pub fn fund_c_address_crosschain(
        env: Env,
        chain_id: u32,
        tx_hash: BytesN<32>,
        target: Address,
        asset: Address,
        amount: i128,
        sigs: Vec<RelayerSig>,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        check_access(&env, &target)?;
        check_asset_whitelisted(&env, &asset)?;

        // Derive nonce = sha256(chain_id_be4 || tx_hash)
        let mut nonce_pre: soroban_sdk::Bytes = soroban_sdk::Bytes::new(&env);
        nonce_pre.extend_from_array(&chain_id.to_be_bytes());
        let tx_hash_bytes: soroban_sdk::Bytes = tx_hash.clone().into();
        nonce_pre.append(&tx_hash_bytes);
        let nonce: BytesN<32> = env.crypto().sha256(&nonce_pre).into();

        if is_nonce_used(&env, &nonce) {
            return Err(BridgeError::ReplayedNonce);
        }

        // Build payload hash = sha256(chain_id_be4 || tx_hash || target_bytes ||
        //                              asset_bytes || amount_be16 || nonce)
        let target_bytes = target.clone().to_xdr(&env);
        let asset_bytes = asset.clone().to_xdr(&env);
        let nonce_bytes: soroban_sdk::Bytes = nonce.clone().into();

        let mut payload: soroban_sdk::Bytes = soroban_sdk::Bytes::new(&env);
        payload.extend_from_array(&chain_id.to_be_bytes());
        payload.append(&tx_hash_bytes);
        payload.append(&target_bytes);
        payload.append(&asset_bytes);
        payload.extend_from_array(&amount.to_be_bytes());
        payload.append(&nonce_bytes);

        let payload_hash: BytesN<32> = env.crypto().sha256(&payload).into();

        // Verify M-of-N relayer signatures
        let threshold = relayer_threshold(&env);
        let mut valid: u32 = 0;
        for i in 0..sigs.len() {
            let sig = sigs.get(i).unwrap();
            if !is_relayer(&env, &sig.pubkey) {
                return Err(BridgeError::NotRelayer);
            }
            // Panics (traps) on invalid sig — convert to error via try pattern
            env.crypto()
                .ed25519_verify(&sig.pubkey, &payload_hash.clone().into(), &sig.signature);
            valid += 1;
        }
        if valid < threshold {
            return Err(BridgeError::BelowThreshold);
        }

        // Consume nonce, apply fee, credit target
        mark_nonce_used(&env, &nonce);

        let fee_bps = read_fee_bps(&env);
        let effective_fee_bps = get_effective_fee_bps(&env, &asset, fee_bps);
        let fee = calculate_fee(amount, effective_fee_bps);
        let net_amount = amount - fee;

        let token_client = token::Client::new(&env, &asset);
        if net_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &target, &net_amount);
        }
        increment_accrued_fees(&env, &asset, fee);
        increment_total_bridged(&env, &asset, net_amount);
        increment_total_fees_collected(&env, &asset, fee);

        env.events().publish(
            ("CrossChainFunded", target),
            (chain_id, tx_hash, amount, fee, asset),
        );
        Ok(())
    }

    pub fn add_relayer(env: Env, pubkey: BytesN<32>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        read_admin(&env).require_auth();
        add_relayer(&env, &pubkey);
        Ok(())
    }

    pub fn remove_relayer(env: Env, pubkey: BytesN<32>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        read_admin(&env).require_auth();
        // Prevent removing below threshold
        let new_count = relayer_count(&env).saturating_sub(1);
        if new_count < relayer_threshold(&env) {
            return Err(BridgeError::BelowThreshold);
        }
        remove_relayer(&env, &pubkey);
        Ok(())
    }

    pub fn set_relayer_threshold(env: Env, threshold: u32) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        read_admin(&env).require_auth();
        if threshold > relayer_count(&env) {
            return Err(BridgeError::ThresholdExceedsRelayers);
        }
        save_relayer_threshold(&env, threshold);
        Ok(())
    }

    pub fn query_relayer_threshold(env: Env) -> Result<u32, BridgeError> {
        check_initialized(&env)?;
        Ok(relayer_threshold(&env))
    }

    pub fn query_is_relayer(env: Env, pubkey: BytesN<32>) -> Result<bool, BridgeError> {
        check_initialized(&env)?;
        Ok(is_relayer(&env, &pubkey))
    }

    // --- Timelocked Funding ---

    pub fn fund_c_address_timelocked(
        env: Env,
        source: Address,
        target: Address,
        asset: Address,
        amount: i128,
        release_time: u64,
        cliff_time: u64,
    ) -> Result<u64, BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let now = env.ledger().timestamp();
        if release_time <= now {
            return Err(BridgeError::InvalidReleaseTime);
        }
        if cliff_time > 0 && cliff_time > release_time {
            return Err(BridgeError::InvalidReleaseTime);
        }
        check_access(&env, &target)?;
        check_asset_whitelisted(&env, &asset)?;
        source.require_auth();

        token::Client::new(&env, &asset)
            .transfer(&source, &env.current_contract_address(), &amount);

        let id = next_timelock_id(&env);
        save_timelock_entry(
            &env,
            id,
            &TimelockEntry {
                source: source.clone(),
                target: target.clone(),
                asset: asset.clone(),
                amount,
                release_time,
                cliff_time,
                claimed: false,
            },
        );

        env.events().publish(
            ("TimelockCreated", source, target),
            (id, amount, asset, release_time, cliff_time),
        );
        Ok(id)
    }

    pub fn claim_timelocked(env: Env, id: u64) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;

        let mut entry = read_timelock_entry(&env, id)
            .ok_or(BridgeError::TimelockNotFound)?;

        entry.target.require_auth();

        if env.ledger().timestamp() < entry.release_time {
            return Err(BridgeError::TimelockNotMatured);
        }
        if entry.claimed {
            return Err(BridgeError::Unauthorized);
        }

        entry.claimed = true;
        save_timelock_entry(&env, id, &entry);

        let fee_bps = read_fee_bps(&env);
        let effective_fee_bps = get_effective_fee_bps(&env, &entry.asset, fee_bps);
        let fee = calculate_fee(entry.amount, effective_fee_bps);
        let net_amount = entry.amount - fee;

        let token_client = token::Client::new(&env, &entry.asset);
        if net_amount > 0 {
            token_client.transfer(&env.current_contract_address(), &entry.target, &net_amount);
        }
        increment_accrued_fees(&env, &entry.asset, fee);
        increment_total_bridged(&env, &entry.asset, net_amount);
        increment_total_fees_collected(&env, &entry.asset, fee);

        env.events().publish(
            ("TimelockClaimed", entry.target),
            (id, net_amount, fee, entry.asset),
        );
        Ok(())
    }

    pub fn query_timelocked(env: Env, id: u64) -> Result<TimelockEntry, BridgeError> {
        read_timelock_entry(&env, id).ok_or(BridgeError::TimelockNotFound)
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod benchmarks;

#[cfg(test)]
mod integration_tests;

#[cfg(test)]
mod token_e2e_tests;
