//! # Onboarding Bridge Contract
//!
//! A Soroban smart contract that bridges tokens to C-addresses on the Stellar network.
//! It supports single and batch funding, cross-chain onboarding via a multi-sig relayer
//! network, timelocked vesting schedules, a referral fee-split system, and a
//! governance-grade timelocked upgrade path.
//!
//! ## Architecture
//!
//! All state lives in one of two Soroban storage tiers:
//!
//! - **Instance storage** — contract-wide singletons (admin, fee config, asset whitelist,
//!   relayer threshold, pending upgrade). Every state-mutating public function (all funding
//!   paths, every admin setter, timelocked/commit-reveal/meta-tx flows, relayer and
//!   blocklist/allowlist management, etc.) calls the private `extend_instance_ttl` helper
//!   before returning, so instance storage — including the `Admin` entry — cannot expire
//!   as long as the contract keeps receiving any mutating call.
//! - **Persistent storage** — per-address or per-asset data (balances, nonces, daily
//!   usage, timelock entries). Extended explicitly via `extend_persistent_ttl`, which
//!   covers per-asset counters, `AssetStats`, `Timelock`, `Commitment`, and `Relayer`
//!   entries for a given key (see `extend_persistent_ttl` for the full key list).
//!
//! ## Fee Model
//!
//! ```text
//! fee       = floor(amount × fee_bps / 10_000)
//! net       = amount − fee
//! effective = min(global_fee_bps, asset_fee_cap)
//! tiered    = looked up by source's cumulative bridged volume
//! ```
//!
//! ## Access Control
//!
//! Three roles exist:
//!
//! | Role | Stored as | Capabilities |
//! |---|---|---|
//! | `admin` | `DataKey::Admin` | All privileged mutations |
//! | `fee_collector` | `DataKey::FeeCollector` | `withdraw_fees` only |
//! | relayer set | `DataKey::Relayer(pubkey)` | Cross-chain attestation |
//!
//! ## Replay Protection
//!
//! Two independent mechanisms exist:
//!
//! 1. **Sequential nonce** (`DataKey::Nonce`) — optional `nonce: Option<u64>` parameter
//!    on every mutating function. Pass `None` to skip (standard Stellar transaction
//!    replay protection applies). Pass `Some(n)` to enforce strict ordering.
//! 2. **Auth-entry nonce** (`DataKey::UsedAuthNonce`) — used by `verify_auth_entry` to
//!    permanently burn a `(source, nonce)` pair within a ledger-sequence window, preventing
//!    Soroban authorization-entry reuse.

#![no_std]

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, token, Address, Bytes, BytesN, Env, Map,
    Vec, IntoVal,
};

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/// All error codes that the contract may return.
///
/// Every public function that can fail returns `Result<_, BridgeError>`.
/// Callers should match on these variants to distinguish recoverable from
/// unrecoverable conditions.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum BridgeError {
    /// Contract has not been initialized yet. Call `initialize` first.
    NotInitialized = 1,
    /// `initialize` was called on an already-initialized contract.
    AlreadyInitialized = 2,
    /// A token amount was zero or negative where a positive value is required.
    InvalidAmount = 3,
    /// The requested fee in basis points exceeds `MAX_FEE_BPS` (1 000).
    FeeTooHigh = 4,
    /// The `targets` and `amounts` arrays passed to `batch_fund_c_address` have
    /// different lengths.
    MismatchedArrays = 5,
    /// A mutating operation was attempted while the contract is paused.
    ContractPaused = 6,
    /// The target address has been added to the blocklist.
    AddressBlocked = 7,
    /// The contract is in allowlist mode and the target address is not allowlisted.
    AddressNotAllowlisted = 8,
    /// The requested withdrawal or reclaim amount exceeds the available balance.
    InsufficientReclaimable = 9,
    /// The asset is not on the whitelist. Add it with `add_asset` first.
    AssetNotWhitelisted = 10,
    /// The source address has exceeded its configured daily transfer limit.
    DailyLimitExceeded = 11,
    /// The supplied sequential nonce does not match the stored value.
    DuplicateNonce = 12,
    /// The transaction deadline has passed.
    TransactionExpired = 13,
    /// No loyalty token has been configured. Call `set_loyalty_token` first.
    LoyaltyTokenNotSet = 14,
    /// A cross-chain `(chain_id, tx_hash)` pair has already been processed.
    ReplayedNonce = 15,
    /// A signature was supplied by a public key that is not a registered relayer.
    NotRelayer = 16,
    /// The number of valid relayer signatures is below the required threshold.
    BelowThreshold = 17,
    /// The threshold would exceed the total number of registered relayers.
    ThresholdExceedsRelayers = 18,
    /// No timelock entry exists for the given ID.
    TimelockNotFound = 19,
    /// The timelock's `release_time` has not been reached yet.
    TimelockNotMatured = 20,
    /// `release_time` is in the past, or `cliff_time` is after `release_time`.
    InvalidReleaseTime = 21,
    /// The caller is not authorized to perform this action (e.g. double-claim).
    Unauthorized = 22,
    /// The auth-entry nonce supplied to `verify_auth_entry` has already been used.
    AuthNonceAlreadyUsed = 23,
    /// The current ledger sequence is outside the `[valid_after, valid_before)` window.
    AuthNonceExpired = 24,
    /// `execute_upgrade` was called but no upgrade has been scheduled.
    UpgradeNotScheduled = 25,
    /// The `expected_hash` passed to `execute_upgrade` does not match the scheduled hash.
    UpgradeHashMismatch = 26,
    /// The scheduled upgrade's timelock period has not yet elapsed.
    UpgradeTimelockActive = 27,
    // Issue #23: max withdraw per tx
    WithdrawExceedsLimit = 28,
    /// An arithmetic operation overflowed i128 bounds.
    Overflow = 29,
    /// No commitment exists for the given ID.
    CommitmentNotFound = 30,
    /// The commitment has already been revealed.
    CommitmentAlreadyRevealed = 31,
    /// The reveal deadline has passed.
    CommitmentExpired = 32,
    /// The revealed amount+nonce does not match the stored hash.
    CommitmentHashMismatch = 33,
    /// The minimum delay between commit and reveal has not elapsed.
    CommitmentNotMatured = 34,
    /// The swap produced fewer target tokens than `min_target_amount`.
    SlippageExceeded = 35,
    /// A DEX pool in the swap route returned zero or failed.
    SwapFailed = 36,
    // Issue #35: EIP-712-style meta-transaction errors
    /// The meta-transaction signature is malformed or does not match the expected signer.
    MetaTxInvalidSignature = 37,
    /// The meta-transaction deadline has passed (funds not yet submitted on-chain).
    MetaTxExpired = 38,
    /// This meta-transaction nonce has already been used; replay prevented.
    MetaTxNonceAlreadyUsed = 39,
    /// The contract is deactivated (permanently paused/migrated).
    ContractDeactivated = 40,
    /// The `targets` array passed to `batch_fund_c_address` exceeds `MAX_BATCH_SIZE` (100).
    BatchTooLarge = 41,
    /// An address's strkey representation exceeds `MAX_STRKEY_LEN` (64) bytes.
    InvalidAddress = 42,
    /// The same relayer pubkey appeared more than once in `sigs`.
    DuplicateRelayerSignature = 45,
    /// A pool address in `swap_route` is not on the swap-pool whitelist.
    PoolNotWhitelisted = 46,
    /// `swap_route` contained more than one hop; multi-hop swaps are not supported.
    MultiHopNotSupported = 43,
    /// A mutating call was re-entered while another call was already in progress.
    Reentrant = 44,
    /// `tiers.len()` exceeds `MAX_FEE_TIERS`.
    TooManyFeeTiers = 47,
    /// A requested TTL is below `MIN_ALLOWED_TTL` or above the configured maximum.
    InvalidTtl = 48,
    /// The supplied pubkey is not the registered meta-signer for `source`.
    MetaTxPubkeySourceMismatch = 49,
    // Next free discriminant: 50. Always take the next unused value here and
    // never renumber an existing variant — clients match on these values.
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

/// Keys used to address every piece of contract state in Soroban storage.
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
    // Extended variants used throughout the contract
    Config,
    AssetStats(Address),
    Relayer(BytesN<32>),
    RelayerCount,
    RelayerThreshold,
    CrossChainNonce(BytesN<32>),
    DailyUsage(Address, Address, u64),
    FeeTiers,
    SourceBridgedVolume(Address),
    LoyaltyToken,
    LoyaltyAmountPerFund,
    TimelockId,
    Timelock(u64),
    UserDeposit(Address, Address),
    MaxInstanceTtl,
    MaxPersistentTtl,
    BridgeConfig,
    // Issue #95: per-address auth nonce counter and used-nonce set
    AuthNonce(Address),
    UsedAuthNonce(Address, u64),
    // Issue #72: timelocked upgrade path
    PendingUpgrade,
    CurrentWasmHash,
    // Issue #21: two-phase admin transfer
    PendingAdmin,
    // Issue #22: two-phase fee collector transfer
    PendingFeeCollector,
    // Issue #23: max withdraw per tx
    MaxWithdrawPerTx,
    // Issue #24: reentrancy guard flag
    Entered,
    // Minimum transfer amount for funded transfers
    MinimumAmount,
    // Issue #30: commit-reveal counter and entries
    CommitmentId,
    Commitment(u64),
    // Issue #35: EIP-712-style meta-transaction used nonces
    MetaTxNonce(Address, u64),
    // Registry binding a source address to the one Ed25519 pubkey it will
    // accept meta-transaction signatures from.
    MetaSigner(Address),
    Deactivated,
    // Admin-managed whitelist of DEX pool addresses usable in `swap_route`.
    PoolWhitelist,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FEE_BPS: u32 = 1_000;
const FEE_DENOMINATOR: i128 = 10_000;
const MAX_BATCH_SIZE: u32 = 100;
/// Maximum number of tiers accepted by `set_fee_tiers`. `get_tiered_fee_bps`
/// / `find_current_tier` scan the full tier list linearly on every funding
/// call, so this bounds the per-call cost of that scan.
const MAX_FEE_TIERS: u32 = 50;
const MAX_ALLOWED_TTL: u32 = 3_110_400; // ~1 year in ledgers (5s/ledger)
/// Minimum configurable value for `MaxInstanceTtl` / `MaxPersistentTtl`.
///
/// Without a floor, an admin setting either max to `0` would make
/// `extend_instance_ttl`'s `threshold = max_ttl / 4` evaluate to `0`, which
/// effectively disables TTL extension and risks near-term expiry of all
/// instance (or persistent) data. Set to roughly one week of ledgers
/// (5 s/ledger) — comfortably above `CRITICAL_ENTRY_TTL_THRESHOLD`.
const MIN_ALLOWED_TTL: u32 = 120_960;
const CRITICAL_ENTRY_TTL_THRESHOLD: u32 = 100_000;
/// Minimum ledgers that must pass before a scheduled upgrade becomes executable (~24 h at 5 s/ledger).
const UPGRADE_TIMELOCK_LEDGERS: u32 = 17_280;
/// Minimum ledgers between commit_fund and reveal_fund (~25 s at 5 s/ledger).
const COMMIT_REVEAL_MIN_DELAY_LEDGERS: u32 = 5;
/// Size of the stack buffer used to hold an address's strkey while hashing it.
/// Soroban strkeys are 56 bytes; anything longer is rejected rather than copied.
const MAX_STRKEY_LEN: usize = 64;

// ---------------------------------------------------------------------------
// Structs
// ---------------------------------------------------------------------------

/// Packed contract-wide configuration stored in a single instance-storage entry.
///
/// Reading and writing this struct as one unit is more efficient than three
/// separate storage operations.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeConfig {
    /// Bridge fee in basis points (0–1 000).
    pub fee_bps: u32,
    /// Whether the contract is paused.
    pub paused: bool,
    /// Whether only allowlisted addresses may receive funds.
    pub allowlist_mode: bool,
}

/// Snapshot of admin + fee_collector + fee_bps used during initialization and
/// cached for efficient admin-auth checks in mutating functions.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BridgeConfigData {
    pub admin: Address,
    pub fee_collector: Address,
    pub fee_bps: u32,
}

/// Packed per-asset counters stored in a single persistent-storage entry.
///
/// All three counters are updated atomically to reduce storage round-trips.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AssetCounters {
    /// Fees that have accrued but not yet been withdrawn by the fee collector.
    pub accrued_fees: i128,
    /// Cumulative net amount delivered to recipients (gross minus fees).
    pub total_bridged: i128,
    /// Cumulative gross fees collected since deployment.
    pub total_fees_collected: i128,
    /// Sum of `TimelockEntry.amount` for entries not yet claimed. Sits in the
    /// contract's token balance but is not owned by the fee collector or
    /// available for `reclaim_tokens`.
    pub locked_timelock: i128,
}

/// A volume-based fee tier.
///
/// If a source address's cumulative bridged volume falls within
/// `[min_volume, max_volume]`, its effective fee is `fee_bps` rather than the
/// global rate.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FeeTier {
    /// Inclusive lower bound on cumulative bridged volume.
    pub min_volume: i128,
    /// Inclusive upper bound on cumulative bridged volume.
    pub max_volume: i128,
    /// Fee in basis points for this tier (0–1 000).
    pub fee_bps: u32,
}

/// An Ed25519 signature from a registered relayer.
///
/// Used in `fund_c_address_crosschain` to attest that a cross-chain event
/// occurred and the payload is authentic.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RelayerSig {
    /// The relayer's Ed25519 public key (must be registered via `add_relayer`).
    pub pubkey: BytesN<32>,
    /// Ed25519 signature over the SHA-256 payload hash.
    pub signature: BytesN<64>,
}

/// A time-gated funding record created by `fund_c_address_timelocked`.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelockEntry {
    /// The address that deposited the tokens.
    pub source: Address,
    /// The address that will receive the net amount after `release_time`.
    pub target: Address,
    /// The token contract address.
    pub asset: Address,
    /// Gross amount deposited (fee is deducted at claim time).
    pub amount: i128,
    /// Unix timestamp (seconds) after which `claim_timelocked` may be called.
    pub release_time: u64,
    /// Optional cliff timestamp; informational only in the current implementation.
    pub cliff_time: u64,
    /// Set to `true` once `claim_timelocked` has been successfully called.
    pub claimed: bool,
}

/// A scheduled WASM upgrade waiting for its timelock to elapse.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingUpgrade {
    /// New WASM hash to apply once the timelock expires.
    pub new_wasm_hash: BytesN<32>,
    /// Ledger sequence at or after which `execute_upgrade` may be called.
    pub executable_after_ledger: u32,
}

/// A pending commit-reveal entry created by `commit_fund`.
///
/// The `amount_hash` is `sha256(amount_be16 || nonce_be8)`.  The `reveal_fund`
/// function verifies this hash before executing the transfer so that the
/// actual amount is never visible in the mempool.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitmentEntry {
    /// Address that will provide the tokens at reveal time.
    pub source: Address,
    /// Address that will receive the net amount at reveal time.
    pub target: Address,
    /// Whitelisted token contract address.
    pub asset: Address,
    /// sha256(amount_be16 || nonce_be8) — binds the reveal to a specific amount.
    pub amount_hash: BytesN<32>,
    /// Unix timestamp deadline; reveal must happen before this.
    pub deadline: u64,
    /// Ledger sequence when the commitment was created; used to enforce delay.
    pub committed_at_ledger: u32,
    /// Set to `true` once `reveal_fund` has been successfully called.
    pub revealed: bool,
}

// ---------------------------------------------------------------------------
// Private helpers (unchanged from original)
// ---------------------------------------------------------------------------

fn read_current_wasm_hash(env: &Env) -> BytesN<32> {
    env.storage()
        .instance()
        .get(&DataKey::CurrentWasmHash)
        .unwrap_or_else(|| BytesN::from_array(env, &[0u8; 32]))
}

fn save_current_wasm_hash(env: &Env, hash: &BytesN<32>) {
    env.storage().instance().set(&DataKey::CurrentWasmHash, hash);
}

fn read_pending_upgrade(env: &Env) -> Option<PendingUpgrade> {
    env.storage().instance().get(&DataKey::PendingUpgrade)
}

fn save_pending_upgrade(env: &Env, pending: &PendingUpgrade) {
    env.storage().instance().set(&DataKey::PendingUpgrade, pending);
}

fn clear_pending_upgrade(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingUpgrade);
}

fn save_pending_admin(env: &Env, addr: &Address) {
    env.storage().instance().set(&DataKey::PendingAdmin, addr);
}

fn read_pending_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PendingAdmin)
}

fn clear_pending_admin(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingAdmin);
}

fn save_pending_fee_collector(env: &Env, addr: &Address) {
    env.storage().instance().set(&DataKey::PendingFeeCollector, addr);
}

fn read_pending_fee_collector(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::PendingFeeCollector)
}

fn clear_pending_fee_collector(env: &Env) {
    env.storage().instance().remove(&DataKey::PendingFeeCollector);
}

fn save_max_withdraw_per_tx(env: &Env, amount: i128) {
    env.storage().instance().set(&DataKey::MaxWithdrawPerTx, &amount);
}

fn read_max_withdraw_per_tx(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::MaxWithdrawPerTx)
        .unwrap_or(0)
}

fn read_bridge_config(env: &Env) -> BridgeConfigData {
    env.storage()
        .instance()
        .get(&DataKey::BridgeConfig)
        .unwrap_or(BridgeConfigData {
            admin: read_admin(env),
            fee_collector: read_fee_collector(env),
            fee_bps: read_fee_bps(env),
        })
}

fn save_bridge_config(env: &Env, cfg: &BridgeConfigData) {
    env.storage()
        .instance()
        .set(&DataKey::BridgeConfig, cfg);
}

fn read_max_instance_ttl(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::MaxInstanceTtl)
        .unwrap_or(MAX_ALLOWED_TTL)
}

fn read_max_persistent_ttl(env: &Env) -> u32 {
    env.storage()
        .instance()
        .get(&DataKey::MaxPersistentTtl)
        .unwrap_or(MAX_ALLOWED_TTL)
}

fn extend_instance_ttl(env: &Env) {
    let max_ttl = read_max_instance_ttl(env);
    let threshold = max_ttl / 4;
    env.storage().instance().extend_ttl(threshold, max_ttl);
}

fn next_timelock_id(env: &Env) -> u64 {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::TimelockId)
        .unwrap_or(0u64);
    env.storage()
        .instance()
        .set(&DataKey::TimelockId, &(id + 1));
    id
}

fn save_timelock_entry(env: &Env, id: u64, entry: &TimelockEntry) {
    env.storage()
        .persistent()
        .set(&DataKey::Timelock(id), entry);
}

fn read_timelock_entry(env: &Env, id: u64) -> Option<TimelockEntry> {
    env.storage().persistent().get(&DataKey::Timelock(id))
}

fn increment_user_deposit(env: &Env, source: &Address, asset: &Address, amount: i128) -> Result<(), BridgeError> {
    let key = DataKey::UserDeposit(source.clone(), asset.clone());
    let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
    let updated = safe_math::safe_add(current, amount)?;
    env.storage()
        .persistent()
        .set(&key, &updated);
    Ok(())
}

#[inline(never)]
fn save_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
}

#[inline(never)]
fn read_admin(env: &Env) -> Address {
    env.storage().instance().get(&DataKey::Admin).unwrap()
}

#[inline(never)]
fn save_fee_collector(env: &Env, addr: &Address) {
    env.storage().instance().set(&DataKey::FeeCollector, addr);
}

#[inline(never)]
fn read_fee_collector(env: &Env) -> Address {
    env.storage()
        .instance()
        .get(&DataKey::FeeCollector)
        .unwrap()
}

fn read_config(env: &Env) -> BridgeConfig {
    env.storage()
        .instance()
        .get(&DataKey::Config)
        .unwrap_or(BridgeConfig {
            fee_bps: 0,
            paused: false,
            allowlist_mode: false,
        })
}

fn save_config(env: &Env, config: &BridgeConfig) {
    env.storage().instance().set(&DataKey::Config, config);
}

fn save_fee_bps(env: &Env, fee_bps: &u32) {
    let mut config = read_config(env);
    config.fee_bps = *fee_bps;
    save_config(env, &config);
    env.storage().instance().set(&DataKey::FeeBps, fee_bps);
}

fn read_fee_bps(env: &Env) -> u32 {
    read_config(env).fee_bps
}

fn read_initialized(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Initialized)
}

fn mark_initialized(env: &Env) {
    env.storage().instance().set(&DataKey::Initialized, &true);
}

#[inline(never)]
fn save_minimum_amount(env: &Env, amount: &i128) {
    env.storage().instance().set(&DataKey::MinimumAmount, amount);
}

#[inline(never)]
fn read_minimum_amount(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::MinimumAmount)
        .unwrap_or(0)
}

fn check_initialized(env: &Env) -> Result<(), BridgeError> {
    if !read_initialized(env) {
        return Err(BridgeError::NotInitialized);
    }
    Ok(())
}

fn read_paused(env: &Env) -> bool {
    read_config(env).paused
}

fn set_paused(env: &Env, paused: bool) {
    let mut config = read_config(env);
    config.paused = paused;
    save_config(env, &config);
    env.storage().instance().set(&DataKey::Paused, &paused);
}

fn is_deactivated(env: &Env) -> bool {
    env.storage().instance().has(&DataKey::Deactivated)
}

fn check_not_deactivated(env: &Env) -> Result<(), BridgeError> {
    if is_deactivated(env) {
        return Err(BridgeError::ContractDeactivated);
    }
    Ok(())
}

fn check_not_paused(env: &Env) -> Result<(), BridgeError> {
    check_not_deactivated(env)?;
    if read_paused(env) {
        return Err(BridgeError::ContractPaused);
    }
    Ok(())
}

#[inline(always)]
fn calculate_fee(amount: i128, fee_bps: u32) -> Result<i128, BridgeError> {
    if fee_bps == 0 {
        return Ok(0);
    }
    let bps = fee_bps as i128;
    let product = safe_math::safe_mul(amount, bps)?;
    safe_math::safe_div(product, FEE_DENOMINATOR)
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
    read_config(env).allowlist_mode
}

fn set_allowlist_mode_flag(env: &Env, enabled: bool) {
    let mut config = read_config(env);
    config.allowlist_mode = enabled;
    save_config(env, &config);
    env.storage()
        .instance()
        .set(&DataKey::AllowlistMode, &enabled);
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

#[inline(never)]
fn read_whitelist(env: &Env) -> Map<Address, bool> {
    env.storage()
        .instance()
        .get(&DataKey::AssetWhitelist)
        .unwrap_or_else(|| Map::new(env))
}

#[inline(never)]
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

// fund_c_address_with_swap must not invoke arbitrary caller-supplied pool
// addresses. Mirrors the asset whitelist pattern above.
#[inline(never)]
fn read_pool_whitelist(env: &Env) -> Map<Address, bool> {
    env.storage()
        .instance()
        .get(&DataKey::PoolWhitelist)
        .unwrap_or_else(|| Map::new(env))
}

#[inline(never)]
fn save_pool_whitelist(env: &Env, whitelist: &Map<Address, bool>) {
    env.storage()
        .instance()
        .set(&DataKey::PoolWhitelist, whitelist);
}

fn check_pool_whitelisted(env: &Env, pool: &Address) -> Result<(), BridgeError> {
    if !read_pool_whitelist(env).get(pool.clone()).unwrap_or(false) {
        return Err(BridgeError::PoolNotWhitelisted);
    }
    Ok(())
}

// Issue #96: SAC native token (XLM) support
//
// Native SAC tokens (e.g., XLM) use the same token interface but may have
// different behavior in the Soroban environment. This helper detects native
// tokens so we can handle them appropriately if needed in the future.
#[inline]
fn is_native_sac_token(env: &Env, asset: &Address) -> bool {
    // In Soroban testnet/mainnet, the native XLM token has a canonical address.
    // We can use env.invoker() to determine if this is the native SAC.
    // For now, we treat all assets uniformly through token::Client.
    // Future enhancement: detect native token via stellar contract protocol.
    let _ = (env, asset);
    false
}

fn read_asset_counters(env: &Env, asset: &Address) -> AssetCounters {
    env.storage()
        .persistent()
        .get(&DataKey::AssetStats(asset.clone()))
        .unwrap_or(AssetCounters {
            accrued_fees: 0,
            total_bridged: 0,
            total_fees_collected: 0,
            locked_timelock: 0,
        })
}

fn increment_locked_timelock(env: &Env, asset: &Address, amount: i128) {
    let mut c = read_asset_counters(env, asset);
    c.locked_timelock += amount;
    save_asset_counters(env, asset, &c);
}

fn decrement_locked_timelock(env: &Env, asset: &Address, amount: i128) {
    let mut c = read_asset_counters(env, asset);
    c.locked_timelock -= amount;
    save_asset_counters(env, asset, &c);
}

fn save_asset_counters(env: &Env, asset: &Address, counters: &AssetCounters) {
    env.storage()
        .persistent()
        .set(&DataKey::AssetStats(asset.clone()), counters);
    env.storage()
        .persistent()
        .set(&DataKey::AccruedFees(asset.clone()), &counters.accrued_fees);
    env.storage()
        .persistent()
        .set(&DataKey::TotalBridged(asset.clone()), &counters.total_bridged);
    env.storage()
        .persistent()
        .set(
            &DataKey::TotalFeesCollected(asset.clone()),
            &counters.total_fees_collected,
        );
}

fn read_accrued_fees(env: &Env, asset: &Address) -> i128 {
    read_asset_counters(env, asset).accrued_fees
}

fn increment_accrued_fees(env: &Env, asset: &Address, amount: i128) -> Result<(), BridgeError> {
    let mut c = read_asset_counters(env, asset);
    c.accrued_fees = safe_math::safe_add(c.accrued_fees, amount)?;
    save_asset_counters(env, asset, &c);
    Ok(())
}

fn decrement_accrued_fees(env: &Env, asset: &Address, amount: i128) {
    let mut c = read_asset_counters(env, asset);
    c.accrued_fees -= amount;
    save_asset_counters(env, asset, &c);
}

fn read_total_bridged(env: &Env, asset: &Address) -> i128 {
    read_asset_counters(env, asset).total_bridged
}

fn increment_total_bridged(env: &Env, asset: &Address, amount: i128) -> Result<(), BridgeError> {
    let mut c = read_asset_counters(env, asset);
    c.total_bridged = safe_math::safe_add(c.total_bridged, amount)?;
    save_asset_counters(env, asset, &c);
    Ok(())
}

fn read_total_fees_collected(env: &Env, asset: &Address) -> i128 {
    read_asset_counters(env, asset).total_fees_collected
}

fn increment_total_fees_collected(env: &Env, asset: &Address, amount: i128) -> Result<(), BridgeError> {
    let mut c = read_asset_counters(env, asset);
    c.total_fees_collected = safe_math::safe_add(c.total_fees_collected, amount)?;
    save_asset_counters(env, asset, &c);
    Ok(())
}

/// Atomically update all three counters in a single storage read+write
fn update_asset_counters(env: &Env, asset: &Address, fees: i128, bridged: i128) -> Result<(), BridgeError> {
    let mut c = read_asset_counters(env, asset);
    c.accrued_fees = safe_math::safe_add(c.accrued_fees, fees)?;
    c.total_bridged = safe_math::safe_add(c.total_bridged, bridged)?;
    c.total_fees_collected = safe_math::safe_add(c.total_fees_collected, fees)?;
    save_asset_counters(env, asset, &c);
    Ok(())
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

// --- Issue #95: Replay protection for Soroban authorization entries ---
//
// An "auth nonce" is a monotonically increasing u64 counter per source address.
// A caller commits to a specific nonce **and** a ledger-sequence window
// [valid_after_ledger, valid_before_ledger).  The contract:
//   1. Binds the nonce to the current contract ID (implicitly — stored under this
//      contract's own persistent storage, keyed by source address).
//   2. Checks that the current ledger sequence is within the caller-supplied window.
//   3. Records the (source, nonce) pair as used, preventing replay in any future
//      transaction regardless of ledger sequence.
//   4. Emits `AuthUsed(source, nonce)` so off-chain indexers can track usage.

fn read_auth_nonce(env: &Env, source: &Address) -> u64 {
    env.storage()
        .persistent()
        .get(&DataKey::AuthNonce(source.clone()))
        .unwrap_or(0)
}

fn is_auth_nonce_used(env: &Env, source: &Address, nonce: u64) -> bool {
    env.storage()
        .persistent()
        .get(&DataKey::UsedAuthNonce(source.clone(), nonce))
        .unwrap_or(false)
}

fn mark_auth_nonce_used(env: &Env, source: &Address, nonce: u64) {
    env.storage()
        .persistent()
        .set(&DataKey::UsedAuthNonce(source.clone(), nonce), &true);
    // Advance the per-address counter so clients can always discover the next
    // expected nonce without scanning storage.
    let current = read_auth_nonce(env, source);
    if nonce >= current {
        env.storage()
            .persistent()
            .set(&DataKey::AuthNonce(source.clone()), &(nonce + 1));
    }
}

/// Validate and consume a Soroban authorization-entry nonce.
///
/// Parameters
/// - `source`              : address whose auth entry is being validated
/// - `nonce`               : caller-supplied nonce (must not have been used before)
/// - `valid_after_ledger`  : inclusive lower bound on `env.ledger().sequence()`
/// - `valid_before_ledger` : exclusive upper bound on `env.ledger().sequence()`
///
/// On success the nonce is marked used and `AuthUsed(source, nonce)` is emitted.
fn consume_auth_nonce(
    env: &Env,
    source: &Address,
    nonce: u64,
    valid_after_ledger: u32,
    valid_before_ledger: u32,
) -> Result<(), BridgeError> {
    // 1. Ledger-sequence window check (guards against stale / premature replays)
    let seq = env.ledger().sequence();
    if seq < valid_after_ledger || seq >= valid_before_ledger {
        return Err(BridgeError::AuthNonceExpired);
    }

    // 2. Used-nonce check (prevents exact replay of this (source, nonce) pair)
    if is_auth_nonce_used(env, source, nonce) {
        return Err(BridgeError::AuthNonceAlreadyUsed);
    }

    // 3. Mark as used and advance the per-address counter
    mark_auth_nonce_used(env, source, nonce);

    // 4. Emit AuthUsed event for off-chain indexers
    env.events()
        .publish(("AuthUsed", source.clone()), (nonce,));

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

// --- Meta-transaction signer registry ---
//
// `execute_meta_fund` authenticates purely via Ed25519 signature (no
// `require_auth`), so nothing inherently ties the supplied `pubkey` to
// `params.source`. This registry lets `source` bind the one pubkey it will
// accept meta-tx signatures from, via `register_meta_signer` (which itself
// requires `source.require_auth()` once, on-chain).

fn save_meta_signer(env: &Env, source: &Address, pubkey: &BytesN<32>) {
    env.storage()
        .persistent()
        .set(&DataKey::MetaSigner(source.clone()), pubkey);
}

fn read_meta_signer(env: &Env, source: &Address) -> Option<BytesN<32>> {
    env.storage()
        .persistent()
        .get(&DataKey::MetaSigner(source.clone()))
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
    let updated = safe_math::safe_add(used, amount)?;
    if updated > limit {
        return Err(BridgeError::DailyLimitExceeded);
    }
    env.storage().persistent().set(&key, &updated);
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

#[inline(always)]
fn get_effective_fee_bps(env: &Env, asset: &Address, global_fee_bps: u32) -> u32 {
    if global_fee_bps == 0 {
        return 0;
    }
    let cap = read_asset_fee_cap(env, asset);
    global_fee_bps.min(cap)
}

// --- Fee tier helpers ---

fn save_fee_tiers(env: &Env, tiers: &Vec<FeeTier>) {
    env.storage().instance().set(&DataKey::FeeTiers, tiers);
}

fn read_fee_tiers(env: &Env) -> Option<Vec<FeeTier>> {
    env.storage().instance().get(&DataKey::FeeTiers)
}

fn read_source_bridged_volume(env: &Env, source: &Address) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::SourceBridgedVolume(source.clone()))
        .unwrap_or(0)
}

fn increment_source_bridged_volume(env: &Env, source: &Address, amount: i128) -> Result<(), BridgeError> {
    let current = read_source_bridged_volume(env, source);
    let updated = safe_math::safe_add(current, amount)?;
    env.storage()
        .persistent()
        .set(&DataKey::SourceBridgedVolume(source.clone()), &updated);
    Ok(())
}

fn get_tiered_fee_bps(env: &Env, source: &Address, fallback_bps: u32) -> u32 {
    if let Some(tiers) = read_fee_tiers(env) {
        let volume = read_source_bridged_volume(env, source);
        for i in 0..tiers.len() {
            let tier = tiers.get(i).unwrap();
            if volume >= tier.min_volume && volume <= tier.max_volume {
                return tier.fee_bps;
            }
        }
    }
    fallback_bps
}

fn find_current_tier(env: &Env, source: &Address) -> Option<FeeTier> {
    if let Some(tiers) = read_fee_tiers(env) {
        let volume = read_source_bridged_volume(env, source);
        for i in 0..tiers.len() {
            let tier = tiers.get(i).unwrap();
            if volume >= tier.min_volume && volume <= tier.max_volume {
                return Some(tier);
            }
        }
    }
    None
}

// --- Loyalty token helpers ---

fn save_loyalty_token(env: &Env, token: &Address) {
    env.storage().instance().set(&DataKey::LoyaltyToken, token);
}

fn read_loyalty_token(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::LoyaltyToken)
}

fn save_loyalty_amount_per_fund(env: &Env, amount: &i128) {
    env.storage()
        .instance()
        .set(&DataKey::LoyaltyAmountPerFund, amount);
}

fn read_loyalty_amount_per_fund(env: &Env) -> i128 {
    env.storage()
        .instance()
        .get(&DataKey::LoyaltyAmountPerFund)
        .unwrap_or(0)
}

// Loyalty minting policy: every funding path that pulls tokens from a
// caller-controlled `source` and delivers them to a `target` mints loyalty
// tokens to the funder (`source`), matching the advertised "general funding
// incentive". This covers: `fund_c_address`, `batch_fund_c_address` (once per
// call, not per recipient), `fund_c_address_with_referral`,
// `fund_c_address_with_swap`, `reveal_fund`, and `execute_meta_fund`.
// `fund_c_address_timelocked` mints at deposit time (when `source` is known
// and authorises the call) rather than at `claim_timelocked` time, since the
// claim is authorised by `target`, not `source`, and minting once at deposit
// avoids ambiguity about which ledger a delayed claim should credit.
// `fund_c_address_crosschain` has no on-chain `source` (funds originate on a
// different chain and are attested by relayers), so the reward is minted to
// `target`, the only address party to that call.
/// Mints (transfers) the configured loyalty reward to `recipient`, unless the
/// contract's loyalty-token reserve is insufficient.
///
/// The contract's own loyalty-token balance is checked before attempting the
/// transfer. If the reserve is depleted, minting is skipped and a
/// `LoyaltyMintSkipped` event is emitted instead of letting the underlying
/// token transfer trap — a depleted loyalty reserve must never revert the
/// funding call that triggered it.
fn mint_loyalty_tokens(env: &Env, recipient: &Address) {
    if let Some(loyalty_token) = read_loyalty_token(env) {
        let amount = read_loyalty_amount_per_fund(env);
        if amount > 0 {
            let token_client = token::Client::new(env, &loyalty_token);
            let contract_addr = env.current_contract_address();
            let reserve = token_client.balance(&contract_addr);
            if reserve < amount {
                env.events().publish(
                    ("LoyaltyMintSkipped", recipient.clone()),
                    (amount, reserve),
                );
                return;
            }
            token_client.transfer(&contract_addr, recipient, &amount);
        }
    }
}

// ---------------------------------------------------------------------------
// Commit-reveal helpers (issue #30)
// ---------------------------------------------------------------------------

fn next_commitment_id(env: &Env) -> u64 {
    let id: u64 = env
        .storage()
        .instance()
        .get(&DataKey::CommitmentId)
        .unwrap_or(0u64);
    env.storage().instance().set(&DataKey::CommitmentId, &(id + 1));
    id
}

fn save_commitment(env: &Env, id: u64, entry: &CommitmentEntry) {
    env.storage()
        .persistent()
        .set(&DataKey::Commitment(id), entry);
}

fn read_commitment(env: &Env, id: u64) -> Option<CommitmentEntry> {
    env.storage().persistent().get(&DataKey::Commitment(id))
}

// ---------------------------------------------------------------------------
// Overflow-safe arithmetic (issue #26)
// ---------------------------------------------------------------------------

mod safe_math {
    use super::BridgeError;

    #[inline(always)]
    pub fn safe_add(a: i128, b: i128) -> Result<i128, BridgeError> {
        a.checked_add(b).ok_or(BridgeError::Overflow)
    }

    #[inline(always)]
    pub fn safe_sub(a: i128, b: i128) -> Result<i128, BridgeError> {
        a.checked_sub(b).ok_or(BridgeError::Overflow)
    }

    #[inline(always)]
    pub fn safe_mul(a: i128, b: i128) -> Result<i128, BridgeError> {
        a.checked_mul(b).ok_or(BridgeError::Overflow)
    }

    #[inline(always)]
    pub fn safe_div(a: i128, b: i128) -> Result<i128, BridgeError> {
        a.checked_div(b).ok_or(BridgeError::Overflow)
    }
}

struct ReentrancyGuard {
    env: Env,
}

impl ReentrancyGuard {
    fn enter(env: &Env) -> Result<Self, BridgeError> {
        let entered: bool = env.storage()
            .instance()
            .get(&DataKey::Entered)
            .unwrap_or(false);
        if entered {
            return Err(BridgeError::Reentrant);
        }
        env.storage().instance().set(&DataKey::Entered, &true);
        Ok(Self { env: env.clone() })
    }
}

impl Drop for ReentrancyGuard {
    fn drop(&mut self) {
        self.env.storage().instance().remove(&DataKey::Entered);
    }
}

#[contract]
pub struct OnboardingBridge;

#[contractimpl]
impl OnboardingBridge {
    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    /// Initialises the bridge contract. Must be called exactly once before any
    /// other function.
    ///
    /// Sets the admin, fee collector, and initial fee rate, then marks the
    /// contract as initialised and extends the instance TTL.
    ///
    /// # Arguments
    ///
    /// * `admin` (`Address`) — Address that will hold administrative privileges.
    ///   Must authorise this call.
    /// * `fee_collector` (`Address`) — Address entitled to call `withdraw_fees`.
    /// * `fee_bps` (`u32`) — Initial fee in basis points. Must be ≤ 1 000 (10 %).
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///   Pass `None` to skip nonce enforcement.
    ///
    /// # Authorization
    ///
    /// Requires `admin.require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::AlreadyInitialized`] — Contract has already been initialised.
    /// * [`BridgeError::FeeTooHigh`] — `fee_bps` exceeds 1 000.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` does not match the stored value.
    ///
    /// # Events
    ///
    /// * `("Initialized", admin, fee_collector)` — data: `(fee_bps,)`
    ///
    /// # Security Considerations
    ///
    /// This function is the single gate that prevents double-initialisation.
    /// The check is performed before `require_auth` so that the initialised flag
    /// is always respected regardless of authorisation state. Deploy and call
    /// `initialize` atomically (e.g. in the same transaction) to prevent
    /// front-running by a third party who could set themselves as admin.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // bridge.initialize(&admin, &fee_collector, &50u32, &None);
    /// // assert_eq!(bridge.query_fee_bps(), 50u32);
    /// ```
    pub fn initialize(
        env: Env,
        admin: Address,
        fee_collector: Address,
        fee_bps: u32,
        nonce: Option<u64>,
    ) -> Result<(), BridgeError> {
        todo!("implement: initialize")
    }

    // -----------------------------------------------------------------------
    // Core bridging
    // -----------------------------------------------------------------------

    /// Funds a C-address with tokens from a source account.
    ///
    /// Transfers `amount` from `source` into the contract, deducts the
    /// effective fee, then forwards the net amount to `target`.  The effective
    /// fee is the minimum of the global fee rate, the per-asset cap, and any
    /// volume-based tier that applies to `source`.
    ///
    /// If a loyalty token has been configured, the contract mints a loyalty
    /// reward to `source` after the transfer.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The account providing the tokens. Must authorise.
    /// * `target` (`Address`) — The C-address receiving the net amount.
    /// * `asset` (`Address`) — The whitelisted token contract address.
    /// * `amount` (`i128`) — Gross amount to transfer. Must be > 0.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for `source`.
    /// * `deadline` (`Option<u64>`) — Optional Unix timestamp (seconds) after
    ///   which the call is rejected. Pass `None` for no expiry.
    ///
    /// # Authorization
    ///
    /// Requires `source.require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::TransactionExpired`] — `deadline` is in the past.
    /// * [`BridgeError::InvalidAmount`] — `amount` ≤ 0.
    /// * [`BridgeError::AddressBlocked`] — `target` is on the blocklist.
    /// * [`BridgeError::AddressNotAllowlisted`] — Allowlist mode is on and
    ///   `target` is not allowlisted.
    /// * [`BridgeError::AssetNotWhitelisted`] — `asset` has not been added.
    /// * [`BridgeError::DailyLimitExceeded`] — Transfer would exceed `source`'s
    ///   daily limit for this asset.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("CAddressFunded", asset, source, target)` — data: `(amount, fee)`
    ///
    /// # Security Considerations
    ///
    /// Access checks (`check_access`) are evaluated before `require_auth` so
    /// that blocked/non-allowlisted targets are rejected without consuming the
    /// caller's authorization budget. The fee is floored (integer division), so
    /// for very small amounts the effective fee may be 0.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // Fund 500 stroops to `target` with no deadline or nonce:
    /// // bridge.fund_c_address(&source, &target, &usdc, &500i128, &None, &None);
    /// ```
    pub fn fund_c_address(
        env: Env,
        source: Address,
        target: Address,
        asset: Address,
        amount: i128,
        nonce: Option<u64>,
        deadline: Option<u64>,
    ) -> Result<(), BridgeError> {
        todo!("implement: fund_c_address")
    }

    /// Funds multiple C-addresses in a single transaction from one source account.
    ///
    /// Pulls `sum(amounts)` from `source` in one token transfer, then iterates
    /// over each `(target, amount)` pair. Blocked or non-allowlisted targets are
    /// **skipped** (their amount is refunded to `source`) rather than aborting
    /// the entire batch. A single `BatchCompleted` event summarises successes
    /// and failures at the end.
    ///
    /// Transfers to the same target address are aggregated into a single token
    /// transfer to reduce fee consumption.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The account providing all tokens. Must authorise.
    /// * `targets` (`Vec<Address>`) — Ordered list of recipient C-addresses.
    /// * `amounts` (`Vec<i128>`) — Gross amount for each recipient. Must be the
    ///   same length as `targets`. Every element must be > 0.
    /// * `asset` (`Address`) — The whitelisted token contract address.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for `source`.
    /// * `deadline` (`Option<u64>`) — Optional Unix timestamp cutoff.
    ///
    /// # Authorization
    ///
    /// Requires `source.require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::BatchTooLarge`] — `targets.len()` exceeds `MAX_BATCH_SIZE` (100).
    /// * [`BridgeError::TransactionExpired`] — `deadline` is in the past.
    /// * [`BridgeError::MismatchedArrays`] — `targets.len() != amounts.len()`.
    /// * [`BridgeError::AssetNotWhitelisted`] — `asset` has not been added.
    /// * [`BridgeError::InvalidAmount`] — Any element of `amounts` is ≤ 0 or below
    ///   the configured minimum transfer amount.
    /// * [`BridgeError::DailyLimitExceeded`] — The aggregate batch amount would
    ///   exceed `source`'s daily limit for this asset.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("CAddressFunded", asset, source, target)` — Emitted per successful entry;
    ///   data: `(amount, fee)`.
    /// * `("BatchTransferFailed", source, target)` — Emitted per skipped entry;
    ///   data: `(amount, "access_denied")`.
    /// * `("BatchCompleted", source)` — Emitted once at the end;
    ///   data: `(num_success, num_failures)`.
    ///
    /// # Security Considerations
    ///
    /// The full batch total is pulled from `source` upfront. If any entries are
    /// blocked, those amounts are returned to `source` at the end of execution.
    /// The validation loop that checks for zero/negative amounts runs before
    /// the initial token pull, so no tokens are moved on validation failures.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // let targets = Vec::from_array(&env, [addr1, addr2]);
    /// // let amounts = Vec::from_array(&env, [1000i128, 500i128]);
    /// // bridge.batch_fund_c_address(&source, &targets, &amounts, &usdc, &None, &None);
    /// ```
    pub fn batch_fund_c_address(
        env: Env,
        source: Address,
        targets: Vec<Address>,
        amounts: Vec<i128>,
        asset: Address,
        nonce: Option<u64>,
        deadline: Option<u64>,
    ) -> Result<(), BridgeError> {
        todo!("implement: batch_fund_c_address")
    }

    // -----------------------------------------------------------------------
    // Fee configuration
    // -----------------------------------------------------------------------

    /// Updates the global fee rate in basis points.
    ///
    /// The new rate applies to all subsequent `fund_c_address` and
    /// `batch_fund_c_address` calls. Per-asset caps and volume tiers further
    /// constrain the effective rate downward.
    ///
    /// # Arguments
    ///
    /// * `new_fee_bps` (`u32`) — New fee rate. Must be ≤ 1 000 (10 %).
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::FeeTooHigh`] — `new_fee_bps` exceeds 1 000.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("FeeBpsChanged", old_fee_bps, new_fee_bps)` — data: `(admin,)`
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // bridge.set_fee_bps(&200u32, &None); // set to 2 %
    /// // assert_eq!(bridge.query_fee_bps(), 200u32);
    /// ```
    pub fn set_fee_bps(env: Env, new_fee_bps: u32, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: set_fee_bps")
    }

    /// Sets a maximum daily transfer limit for a specific `(source, asset)` pair.
    ///
    /// Once set, any `fund_c_address` call from `source` using `asset` that
    /// would push the day's cumulative volume past `limit_amount` is rejected.
    /// Set `limit_amount` to `0` to disable the limit entirely.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The address whose daily throughput is being capped.
    /// * `asset` (`Address`) — The asset the limit applies to.
    /// * `limit_amount` (`i128`) — Maximum gross tokens allowed per calendar day
    ///   (UTC, measured in ledger timestamp / 86 400). Use `0` to disable.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // Allow user to move at most 10 000 USDC per day:
    /// // bridge.set_source_daily_limit(&user, &usdc, &10_000i128, &None);
    /// ```
    pub fn set_source_daily_limit(
        env: Env,
        source: Address,
        asset: Address,
        limit_amount: i128,
        nonce: Option<u64>,
    ) -> Result<(), BridgeError> {
        todo!("implement: set_source_daily_limit")
    }

    /// Returns the daily transfer limit for a `(source, asset)` pair.
    ///
    /// Returns `0` if no limit has been configured, meaning transfers are
    /// unrestricted for that pair.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The address to query.
    /// * `asset` (`Address`) — The asset to query.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_source_daily_limit(
        env: Env,
        source: Address,
        asset: Address,
    ) -> Result<i128, BridgeError> {
        todo!("implement: query_source_daily_limit")
    }

    /// Sets a per-asset maximum fee cap in basis points.
    ///
    /// The effective fee for `asset` is `min(global_fee_bps, cap)`.
    /// Useful for stablecoins or high-value assets where the global rate
    /// would otherwise be too aggressive.
    ///
    /// # Arguments
    ///
    /// * `asset` (`Address`) — The token contract whose fee is being capped.
    /// * `max_fee_bps` (`u32`) — Cap in basis points. Must be ≤ 1 000.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::FeeTooHigh`] — `max_fee_bps` exceeds 1 000.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // Cap USDC fees at 0.5 % regardless of global rate:
    /// // bridge.set_asset_fee_cap(&usdc, &50u32, &None);
    /// ```
    pub fn set_asset_fee_cap(
        env: Env,
        asset: Address,
        max_fee_bps: u32,
        nonce: Option<u64>,
    ) -> Result<(), BridgeError> {
        todo!("implement: set_asset_fee_cap")
    }

    /// Returns the fee cap configured for `asset`.
    ///
    /// Returns the contract-wide `MAX_FEE_BPS` (1 000) if no cap has been set,
    /// meaning the global rate applies uncapped.
    ///
    /// # Arguments
    ///
    /// * `asset` (`Address`) — The token contract to query.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_asset_fee_cap(
        env: Env,
        asset: Address,
    ) -> Result<u32, BridgeError> {
        todo!("implement: query_asset_fee_cap")
    }

    /// Changes the address that is entitled to call `withdraw_fees`.
    ///
    /// # Arguments
    ///
    /// * `new_fee_collector` (`Address`) — Replacement fee collector.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("FeeCollectorChanged", old_collector, new_fee_collector)` — data: `(admin,)`
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // bridge.set_fee_collector(&new_collector, &None);
    /// // assert_eq!(bridge.query_fee_collector(), new_collector);
    /// ```
    pub fn set_fee_collector(env: Env, new_fee_collector: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: set_fee_collector")
    }

    /// Proposes a fee-collector handoff that must be accepted by `new_collector`.
    ///
    /// This two-step path is preferred over `set_fee_collector` for normal
    /// operations because it proves the proposed collector controls the key
    /// before the role is moved.
    pub fn propose_new_fee_collector(env: Env, new_collector: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: propose_new_fee_collector")
    }

    /// Accepts a pending fee-collector handoff.
    pub fn accept_fee_collector(env: Env) -> Result<(), BridgeError> {
        todo!("implement: accept_fee_collector")
    }

    pub fn query_pending_fee_collector(env: Env) -> Option<Address> {

        todo!("implement: query_pending_fee_collector")

    }

    pub fn set_admin(env: Env, new_admin: Address, nonce: Option<u64>) -> Result<(), BridgeError> {

        todo!("implement: set_admin")

    }

    /// Proposes an admin handoff that must be accepted by `new_admin`.
    ///
    /// This two-step path is preferred over `set_admin` for normal operations
    /// because it prevents accidentally transferring control to an unusable key.
    pub fn propose_new_admin(env: Env, new_admin: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: propose_new_admin")
    }

    /// Accepts a pending admin handoff.
    pub fn accept_admin(env: Env) -> Result<(), BridgeError> {
        todo!("implement: accept_admin")
    }

    pub fn query_pending_admin(env: Env) -> Option<Address> {

        todo!("implement: query_pending_admin")

    }

    pub fn set_minimum_amount(env: Env, amount: i128, nonce: Option<u64>) -> Result<(), BridgeError> {

        todo!("implement: set_minimum_amount")

    }

    /// Returns the configured minimum transfer amount.
    ///
    /// Returns the value last stored by `set_minimum_amount`, or `0` (no
    /// minimum) if it has never been called. The minimum is enforced by
    /// `fund_c_address`, which rejects amounts below it with
    /// [`BridgeError::InvalidAmount`].
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_minimum_amount(env: Env) -> Result<i128, BridgeError> {
        todo!("implement: query_minimum_amount")
    }

    /// Withdraws accrued protocol fees to the fee collector.
    ///
    /// Transfers `amount` of `asset` from the contract to the fee collector and
    /// decrements the on-chain accrued-fees counter.
    ///
    /// # Arguments
    ///
    /// * `asset` (`Address`) — The token contract whose accrued fees are being withdrawn.
    /// * `amount` (`i128`) — Amount to withdraw. Must be > 0 and ≤ accrued balance.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the fee collector.
    ///
    /// # Authorization
    ///
    /// Requires the current fee collector's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::InvalidAmount`] — `amount` ≤ 0.
    /// * [`BridgeError::InsufficientReclaimable`] — `amount` exceeds the
    ///   accrued fee balance for `asset`.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("FeesWithdrawn", fee_collector)` — data: `(amount, asset)`
    ///
    /// # Security Considerations
    ///
    /// Only the fee collector may call this function. Accrued fees are tracked
    /// separately from the contract's token balance, so this function can never
    /// withdraw tokens that were sent to the contract for other purposes (use
    /// `reclaim_tokens` for that).
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // Withdraw all 5 accrued fee tokens:
    /// // bridge.withdraw_fees(&usdc, &5i128, &None);
    /// ```
    pub fn withdraw_fees(env: Env, asset: Address, amount: i128, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: withdraw_fees")
    }

    pub fn set_max_withdraw_per_tx(env: Env, amount: i128, nonce: Option<u64>) -> Result<(), BridgeError> {

        todo!("implement: set_max_withdraw_per_tx")

    }

    pub fn query_max_withdraw_per_tx(env: Env) -> Result<i128, BridgeError> {

        todo!("implement: query_max_withdraw_per_tx")

    }

    pub fn query_fee_bps(env: Env) -> Result<u32, BridgeError> {

        todo!("implement: query_fee_bps")

    }

    /// Sets the referral fee rate as a share of the protocol fee.
    ///
    /// When `fund_c_address_with_referral` is called with a referrer, the
    /// referrer receives `fee × referral_rate / 10_000` of the protocol fee,
    /// and the remainder accrues to the contract.
    ///
    /// # Arguments
    ///
    /// * `bps` (`u32`) — Referral share in basis points relative to the fee
    ///   (0–10 000). E.g. `2000` means the referrer gets 20 % of the fee.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::FeeTooHigh`] — `bps` exceeds 10 000.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("ReferralRateChanged", bps)` — no additional data.
    pub fn set_referral_rate(env: Env, bps: u32, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: set_referral_rate")
    }

    /// Returns the current referral rate in basis points.
    ///
    /// Returns `0` (no referral split) if `set_referral_rate` has never been called.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_referral_rate(env: Env) -> Result<u32, BridgeError> {
        todo!("implement: query_referral_rate")
    }

    /// Funds a C-address with an optional referrer that receives a share of the fee.
    ///
    /// Behaves identically to `fund_c_address` except that when `referrer` is
    /// `Some(addr)`, the referral portion of the protocol fee is transferred
    /// directly to that address immediately. The remainder accrues in the
    /// contract as usual.
    ///
    /// ```text
    /// fee          = floor(amount × effective_fee_bps / 10_000)
    /// referral_fee = floor(fee × referral_rate / 10_000)   (0 if referrer is None)
    /// protocol_fee = fee − referral_fee
    /// net          = amount − fee
    /// ```
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The account providing the tokens. Must authorise.
    /// * `target` (`Address`) — The C-address receiving `net` tokens.
    /// * `asset` (`Address`) — The whitelisted token contract.
    /// * `amount` (`i128`) — Gross amount. Must be > 0.
    /// * `referrer` (`Option<Address>`) — Address to receive the referral cut,
    ///   or `None` for no referral.
    ///
    /// # Authorization
    ///
    /// Requires `source.require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::InvalidAmount`] — `amount` ≤ 0.
    /// * [`BridgeError::AddressBlocked`] — `target` is on the blocklist.
    /// * [`BridgeError::AddressNotAllowlisted`] — Allowlist mode on and `target`
    ///   is not allowlisted.
    /// * [`BridgeError::AssetNotWhitelisted`] — `asset` has not been added.
    /// * [`BridgeError::DailyLimitExceeded`] — Daily limit exceeded for
    ///   `(source, asset)`.
    ///
    /// # Events
    ///
    /// * `("ReferralPaid", source, referrer)` — Emitted only when `referrer` is
    ///   `Some` and `referral_fee > 0`; data: `(rf, asset)`.
    /// * `("CAddressFunded", asset, source, target)` — data: `(amount, fee)`.
    ///
    /// # Security Considerations
    ///
    /// Unlike `fund_c_address`, this function does not accept a `nonce` or
    /// `deadline` parameter. Callers relying on replay protection should use
    /// `verify_auth_entry` in conjunction with this call, or use the standard
    /// Stellar transaction sequence-number mechanism.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // bridge.fund_c_address_with_referral(
    /// //     &source, &target, &usdc, &1000i128, &Some(referrer),
    /// // );
    /// ```
    pub fn fund_c_address_with_referral(
        env: Env,
        source: Address,
        target: Address,
        asset: Address,
        amount: i128,
        referrer: Option<Address>,
    ) -> Result<(), BridgeError> {
        todo!("implement: fund_c_address_with_referral")
    }

    // -----------------------------------------------------------------------
    // Query helpers
    // -----------------------------------------------------------------------

    /// Returns the current fee collector address.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_fee_collector(env: Env) -> Result<Address, BridgeError> {
        todo!("implement: query_fee_collector")
    }

    /// Returns the current admin address.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_admin(env: Env) -> Result<Address, BridgeError> {
        todo!("implement: query_admin")
    }

    /// Returns the token balance of `c_address` for `asset`.
    ///
    /// This is a pure read-through to the token contract; it does not require
    /// the contract to be initialised and has no access-control checks.
    ///
    /// # Arguments
    ///
    /// * `c_address` (`Address`) — The address whose balance is queried.
    /// * `asset` (`Address`) — The token contract address.
    pub fn query_balance(env: Env, c_address: Address, asset: Address) -> i128 {
        todo!("implement: query_balance")
    }

    /// Returns the bridge contract's own balance for each asset in `assets`.
    ///
    /// Useful for monitoring the contract's total holdings across multiple tokens
    /// in a single call.
    ///
    /// # Arguments
    ///
    /// * `assets` (`Vec<Address>`) — List of token contract addresses to query.
    ///   Must contain at most `MAX_BATCH_SIZE` (100) entries.
    ///
    /// # Returns
    ///
    /// A `Map<Address, i128>` mapping each asset address to the contract's balance.
    /// Assets with a zero balance are included.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::BatchTooLarge`] — `assets.len()` exceeds `MAX_BATCH_SIZE` (100).
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // let assets = Vec::from_array(&env, [usdc, xlm]);
    /// // let balances = bridge.query_all_balances(&assets);
    /// ```
    pub fn query_all_balances(
        env: Env,
        assets: Vec<Address>,
    ) -> Result<Map<Address, i128>, BridgeError> {
        todo!("implement: query_all_balances")
    }

    /// Returns the contract's total token balance for `asset`.
    ///
    /// This includes both accrued fees and any tokens held for other purposes
    /// (e.g. timelocked funds). Use `query_accrued_fees` to isolate just the
    /// fee portion.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_fee_balance(env: Env, asset: Address) -> Result<i128, BridgeError> {
        todo!("implement: query_fee_balance")
    }

    /// Returns `true` if the contract has been initialised.
    pub fn query_is_initialized(env: Env) -> bool {
        todo!("implement: query_is_initialized")
    }

    /// Returns the current sequential nonce value for `caller`.
    ///
    /// The returned value is the next nonce that must be passed to succeed if
    /// the caller chooses to enforce nonce checking. Returns `0` for addresses
    /// that have never used a nonce.
    ///
    /// # Arguments
    ///
    /// * `caller` (`Address`) — The address whose nonce is queried.
    pub fn query_nonce(env: Env, caller: Address) -> u64 {
        todo!("implement: query_nonce")
    }

    /// Simulates the fee and net amount for a given gross amount at the current
    /// global fee rate.
    ///
    /// Does not account for per-asset caps or volume tiers; use this for a
    /// quick estimate only.
    ///
    /// # Arguments
    ///
    /// * `gross_amount` (`i128`) — The hypothetical gross transfer amount.
    ///
    /// # Returns
    ///
    /// `(fee, net)` where `fee = floor(gross × fee_bps / 10_000)` and
    /// `net = gross − fee`.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // At fee_bps = 100 (1 %):
    /// // let (fee, net) = bridge.query_calculate_fee(&1000i128);
    /// // assert_eq!(fee, 10i128);
    /// // assert_eq!(net, 990i128);
    /// ```
    pub fn query_calculate_fee(env: Env, gross_amount: i128) -> Result<(i128, i128), BridgeError> {
        todo!("implement: query_calculate_fee")
    }

    /// Returns the real effective fee that would be charged for a specific
    /// `(source, asset, amount)` combination, taking into account the global
    /// fee rate, any volume-based tier applicable to `source`, and the
    /// per-asset fee cap.
    ///
    /// Unlike [`Self::query_calculate_fee`], which only uses the flat global
    /// fee rate, this function runs the full fee-resolution pipeline:
    ///
    /// 1. **Global rate** — the contract-wide fee_bps.
    /// 2. **Volume tier** — if `source`&#39;s cumulative bridged volume falls
    ///    within a configured `FeeTier`, that tier&#39;s rate is used instead.
    /// 3. **Asset cap** — the per-asset maximum fee cap is applied as an
    ///    upper bound on the tiered rate.
    ///
    /// The referral fee split does **not** affect the gross fee amount;
    /// it only determines how the fee is distributed between the fee
    /// collector and the referrer.
    ///
    /// # Arguments
    ///
    /// * `source` — The address that would provide the tokens.
    /// * `asset` — The whitelisted token contract address.
    /// * `amount` — The hypothetical gross transfer amount.
    ///
    /// # Returns
    ///
    /// `(effective_fee_bps, fee, net)` where:
    /// - `effective_fee_bps` is the resolved basis-point rate after cap + tier.
    /// - `fee = floor(amount × effective_fee_bps / 10_000)`.
    /// - `net = amount − fee`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::Overflow`] — Arithmetic overflow in fee calculation.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // At fee_bps = 100 (1 %), no asset cap, no tiers:
    /// // let (bps, fee, net) = bridge.query_effective_fee(&source, &usdc, &1000i128);
    /// // assert_eq!(bps, 100u32);
    /// // assert_eq!(fee, 10i128);
    /// // assert_eq!(net, 990i128);
    /// ```
    pub fn query_effective_fee(
        env: Env,
        source: Address,
        asset: Address,
        amount: i128,
    ) -> Result<(u32, i128, i128), BridgeError> {
        todo!("implement: query_effective_fee")
    }

    /// Returns the cumulative net amount of `asset` that has been delivered to
    /// recipients since deployment.
    ///
    /// "Total bridged" counts only the net portion (gross minus fee), not the
    /// gross transferred by sources.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_total_bridged(env: Env, asset: Address) -> Result<i128, BridgeError> {
        todo!("implement: query_total_bridged")
    }

    /// Returns the cumulative gross fees collected for `asset` since deployment.
    ///
    /// This counter only increases and is not decremented when fees are
    /// withdrawn. To see the currently *pending* (not yet withdrawn) fee
    /// balance, use `query_accrued_fees`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_total_fees_collected(env: Env, asset: Address) -> Result<i128, BridgeError> {
        todo!("implement: query_total_fees_collected")
    }

    // -----------------------------------------------------------------------
    // Pause / Unpause
    // -----------------------------------------------------------------------

    /// Pauses the contract, disabling all mutating operations.
    ///
    /// While paused, calls to `fund_c_address`, `batch_fund_c_address`,
    /// `withdraw_fees`, `set_fee_bps`, `set_fee_collector`, `set_admin`, and
    /// several other state-modifying functions return
    /// [`BridgeError::ContractPaused`]. Read-only `query_*` functions are
    /// unaffected.
    ///
    /// # Arguments
    ///
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("ContractPaused",)` — data: `(admin,)`
    ///
    /// # Security Considerations
    ///
    /// Pausing is an emergency mechanism. It does not prevent the admin from
    /// scheduling or executing upgrades, which are intentionally not pause-gated
    /// so that an upgrade can fix whatever condition required the pause.
    pub fn pause(env: Env, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: pause")
    }

    /// Resumes normal contract operation after a pause.
    ///
    /// # Arguments
    ///
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("ContractUnpaused",)` — data: `(admin,)`
    pub fn unpause(env: Env, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: unpause")
    }

    /// Returns `true` if the contract is currently paused.
    pub fn query_is_paused(env: Env) -> bool {
        todo!("implement: query_is_paused")
    }

    // -----------------------------------------------------------------------
    // Upgrade (immediate)
    // -----------------------------------------------------------------------

    /// Immediately upgrades the contract WASM to `new_wasm_hash`.
    ///
    /// This is the **untimelocked** upgrade path retained for development,
    /// testnet, and controlled break-glass operations. For production
    /// deployments, prefer `schedule_upgrade` + `execute_upgrade` which
    /// enforces a ~24-hour delay, giving users time to react.
    ///
    /// # Arguments
    ///
    /// * `new_wasm_hash` (`BytesN<32>`) — The hash of the new WASM blob, which
    ///   must already have been uploaded to the network via
    ///   `Deployer::upload_contract_wasm`.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("ContractUpgraded",)` — data: `(old_hash, new_wasm_hash, admin)`
    ///
    /// # Security Considerations
    ///
    /// After this call the contract executes new code in the same transaction.
    /// The `old_hash` in the event lets off-chain monitors detect unexpected
    /// upgrades. Consider using the timelocked path for mainnet deployments.
    pub fn upgrade(env: Env, new_wasm_hash: BytesN<32>, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: upgrade")
    }

    // -----------------------------------------------------------------------
    // Timelocked upgrade path (issue #72)
    // -----------------------------------------------------------------------

    /// Schedules a WASM upgrade that becomes executable after a ~24-hour timelock.
    ///
    /// The upgrade is executable once
    /// `env.ledger().sequence() ≥ current_sequence + UPGRADE_TIMELOCK_LEDGERS`
    /// (17 280 ledgers at 5 s/ledger ≈ 24 hours).
    ///
    /// Only one pending upgrade may exist at a time. Call `cancel_upgrade`
    /// first if you need to replace a pending upgrade.
    ///
    /// # Arguments
    ///
    /// * `new_wasm_hash` (`BytesN<32>`) — Hash of the new WASM blob to apply
    ///   after the timelock elapses.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Returns
    ///
    /// The ledger sequence number at or after which `execute_upgrade` may be
    /// called (`executable_after_ledger`).
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("UpgradeScheduled",)` — data: `(new_wasm_hash, executable_after_ledger, admin)`
    ///
    /// # Security Considerations
    ///
    /// Off-chain monitoring tools should watch for `UpgradeScheduled` events
    /// and alert stakeholders so they can review the proposed WASM before the
    /// timelock expires. Use `cancel_upgrade` to abort if the scheduled hash
    /// turns out to be malicious.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // let unlock_ledger = bridge.schedule_upgrade(&new_wasm_hash, &None);
    /// // // wait until env.ledger().sequence() >= unlock_ledger, then:
    /// // bridge.execute_upgrade(&new_wasm_hash, &None);
    /// ```
    pub fn schedule_upgrade(
        env: Env,
        new_wasm_hash: BytesN<32>,
        nonce: Option<u64>,
    ) -> Result<u32, BridgeError> {
        todo!("implement: schedule_upgrade")
    }

    /// Executes a previously scheduled upgrade once its timelock has elapsed.
    ///
    /// `expected_hash` must match the hash that was passed to `schedule_upgrade`.
    /// This prevents a race condition where the admin could change the pending
    /// hash between scheduling and execution by requiring the caller to commit
    /// to the exact hash they are applying.
    ///
    /// The pending upgrade record is cleared **before** calling
    /// `update_current_contract_wasm` to prevent re-entrant replay.
    ///
    /// # Arguments
    ///
    /// * `expected_hash` (`BytesN<32>`) — Must match `PendingUpgrade::new_wasm_hash`.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::UpgradeNotScheduled`] — No pending upgrade exists.
    /// * [`BridgeError::UpgradeHashMismatch`] — `expected_hash` does not match
    ///   the scheduled hash.
    /// * [`BridgeError::UpgradeTimelockActive`] — The timelock has not yet elapsed.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("ContractUpgraded",)` — data: `(old_hash, new_wasm_hash, admin)`
    pub fn execute_upgrade(
        env: Env,
        expected_hash: BytesN<32>,
        nonce: Option<u64>,
    ) -> Result<(), BridgeError> {
        todo!("implement: execute_upgrade")
    }

    /// Cancels a pending scheduled upgrade.
    ///
    /// After cancellation, `execute_upgrade` will return
    /// [`BridgeError::UpgradeNotScheduled`] until a new upgrade is scheduled.
    ///
    /// # Arguments
    ///
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::UpgradeNotScheduled`] — No pending upgrade to cancel.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("UpgradeCancelled",)` — data: `(cancelled_wasm_hash, admin)`
    pub fn cancel_upgrade(env: Env, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: cancel_upgrade")
    }

    /// Returns the pending scheduled upgrade, if any.
    ///
    /// Returns `None` if no upgrade has been scheduled or if a previous
    /// upgrade has already been executed or cancelled.
    pub fn query_pending_upgrade(env: Env) -> Option<PendingUpgrade> {
        todo!("implement: query_pending_upgrade")
    }

    /// Migrates the contract state to a new contract address in case of emergency.
    ///
    /// # Arguments
    ///
    /// * `new_contract` (`Address`) — The address of the new contract.
    /// * `migrate_data` (`bool`) — If true, emits all contract state as events.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    pub fn emergency_migrate(
        env: Env,
        new_contract: Address,
        migrate_data: bool,
    ) -> Result<(), BridgeError> {
        todo!("implement: emergency_migrate")
    }

    // -----------------------------------------------------------------------
    // Blocklist / Allowlist
    // -----------------------------------------------------------------------

    /// Adds `address` to the blocklist.
    ///
    /// Blocked addresses cannot be used as `target` in any funding call.
    /// Existing timelocked entries for a blocked address are not affected
    /// retroactively; however, `claim_timelocked` itself is not blocked (the
    /// recipient calls it directly). Blocking takes effect immediately for all
    /// new funding calls.
    ///
    /// # Arguments
    ///
    /// * `address` (`Address`) — The address to block.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
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

    /// Removes `address` from the blocklist, restoring its ability to receive funds.
    ///
    /// # Arguments
    ///
    /// * `address` (`Address`) — The address to unblock.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    pub fn remove_from_blocklist(env: Env, address: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: remove_from_blocklist")
    }

    /// Adds `address` to the allowlist.
    ///
    /// Only relevant when the contract is in allowlist mode
    /// (`set_allowlist_mode(true)`). In that mode, only allowlisted addresses
    /// may be used as `target` in funding calls.
    ///
    /// # Arguments
    ///
    /// * `address` (`Address`) — The address to allowlist.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
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

    /// Removes `address` from the allowlist.
    ///
    /// If the contract is in allowlist mode, the address will no longer be
    /// able to receive funds until re-added.
    ///
    /// # Arguments
    ///
    /// * `address` (`Address`) — The address to remove from the allowlist.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    pub fn remove_from_allowlist(env: Env, address: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: remove_from_allowlist")
    }

    /// Enables or disables allowlist mode.
    ///
    /// When `enabled` is `true`, only addresses that have been explicitly added
    /// via `add_to_allowlist` may receive tokens. When `false` (the default),
    /// any non-blocked address may receive tokens.
    ///
    /// The blocklist is **always** enforced regardless of this setting.
    ///
    /// # Arguments
    ///
    /// * `enabled` (`bool`) — `true` to enable allowlist mode, `false` to disable.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    pub fn set_allowlist_mode(env: Env, enabled: bool, nonce: Option<u64>) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        let admin = read_admin(&env);
        admin.require_auth();
        consume_nonce(&env, &admin, nonce)?;
        set_allowlist_mode_flag(&env, enabled);
        Ok(())
    }

    /// Returns `true` if `address` is on the blocklist.
    pub fn query_is_blocked(env: Env, address: Address) -> bool {
        is_blocked(&env, &address)
    }

    /// Returns `true` if `address` is on the allowlist.
    pub fn query_is_allowlisted(env: Env, address: Address) -> bool {
        todo!("implement: query_is_allowlisted")
    }

    /// Returns `true` if allowlist mode is currently enabled.
    pub fn query_allowlist_mode(env: Env) -> bool {
        todo!("implement: query_allowlist_mode")
    }

    // -----------------------------------------------------------------------
    // Token reclaim
    // -----------------------------------------------------------------------

    /// Allows the admin to recover tokens that were accidentally sent to the
    /// contract and are not owed as fees.
    ///
    /// The reclaimable amount is `contract_token_balance − accrued_fees`.
    /// This ensures the admin cannot drain fee reserves that belong to the
    /// fee collector.
    ///
    /// # Arguments
    ///
    /// * `asset` (`Address`) — The token to reclaim.
    /// * `amount` (`i128`) — Amount to recover. Must be > 0 and ≤ reclaimable.
    /// * `destination` (`Address`) — Address to send the recovered tokens to.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::InvalidAmount`] — `amount` ≤ 0.
    /// * [`BridgeError::InsufficientReclaimable`] — `amount` exceeds
    ///   `contract_balance − accrued_fees`.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("TokensReclaimed", admin, asset)` — data: `(amount, destination)`
    ///
    /// # Security Considerations
    ///
    /// The check `reclaimable = balance − accrued_fees − locked_timelock`
    /// ensures that both fee reserves and unclaimed `TimelockEntry` deposits
    /// are ring-fenced: `locked_timelock` is a running per-asset total
    /// incremented in `fund_c_address_timelocked` and decremented in
    /// `claim_timelocked`, so admins cannot drain tokens that are owed to a
    /// pending timelock claim. Unrevealed `CommitmentEntry` records created
    /// by `commit_fund` never hold contract balance in the first place —
    /// `reveal_fund` pulls the tokens from `source` and forwards them to
    /// `target` atomically within a single call — so no separate accounting
    /// is required for them.
    pub fn reclaim_tokens(
        env: Env,
        asset: Address,
        amount: i128,
        destination: Address,
        nonce: Option<u64>,
    ) -> Result<(), BridgeError> {
        todo!("implement: reclaim_tokens")
    }

    // -----------------------------------------------------------------------
    // Asset whitelist
    // -----------------------------------------------------------------------

    /// Adds `asset` to the token whitelist.
    ///
    /// Only whitelisted assets may be used in `fund_c_address`,
    /// `batch_fund_c_address`, and related funding functions. Adding an asset
    /// that is already whitelisted is idempotent.
    ///
    /// # Arguments
    ///
    /// * `asset` (`Address`) — The token contract address to whitelist.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    pub fn add_asset(env: Env, asset: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: add_asset")
    }

    /// Removes `asset` from the token whitelist.
    ///
    /// After removal, any funding call that references this asset returns
    /// [`BridgeError::AssetNotWhitelisted`]. Existing accrued fee counters
    /// and historical stats for the asset are retained in storage.
    ///
    /// # Arguments
    ///
    /// * `asset` (`Address`) — The token contract address to remove.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    pub fn remove_asset(env: Env, asset: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: remove_asset")
    }

    /// Returns `true` if `asset` is currently on the whitelist.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_is_asset_whitelisted(env: Env, asset: Address) -> Result<bool, BridgeError> {
        todo!("implement: query_is_asset_whitelisted")
    }

    /// Returns a page of currently whitelisted asset addresses.
    ///
    /// The whitelist can grow without bound over the contract's lifetime, so
    /// results are paginated rather than returned in a single unbounded call.
    ///
    /// # Arguments
    ///
    /// * `offset` (`u32`) — Number of whitelist entries to skip.
    /// * `limit` (`u32`) — Maximum number of entries to return. Capped at
    ///   `MAX_BATCH_SIZE` (100); values above that are silently clamped.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_whitelisted_assets(
        env: Env,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<Address>, BridgeError> {
        todo!("implement: query_whitelisted_assets")
    }

    // -----------------------------------------------------------------------
    // Swap pool whitelist
    // -----------------------------------------------------------------------

    /// Adds `pool` to the DEX swap-pool whitelist.
    ///
    /// Only whitelisted pool addresses may appear in the `swap_route` passed
    /// to `fund_c_address_with_swap`. Adding a pool that is already
    /// whitelisted is idempotent.
    ///
    /// # Arguments
    ///
    /// * `pool` (`Address`) — The DEX pool contract address to whitelist.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    pub fn add_swap_pool(env: Env, pool: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: add_swap_pool")
    }

    /// Removes `pool` from the DEX swap-pool whitelist.
    ///
    /// After removal, any `fund_c_address_with_swap` call whose `swap_route`
    /// references this pool returns [`BridgeError::PoolNotWhitelisted`].
    ///
    /// # Arguments
    ///
    /// * `pool` (`Address`) — The DEX pool contract address to remove.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for the admin.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    pub fn remove_swap_pool(env: Env, pool: Address, nonce: Option<u64>) -> Result<(), BridgeError> {
        todo!("implement: remove_swap_pool")
    }

    /// Returns `true` if `pool` is currently on the swap-pool whitelist.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_is_pool_whitelisted(env: Env, pool: Address) -> Result<bool, BridgeError> {
        todo!("implement: query_is_pool_whitelisted")
    }

    // -----------------------------------------------------------------------
    // Loyalty token
    // -----------------------------------------------------------------------

    /// Configures the loyalty token and the fixed reward minted to the source
    /// on every successful `fund_c_address` call.
    ///
    /// The contract must already hold a balance of `token` equal to or greater
    /// than the rewards it intends to distribute. There is no automatic minting;
    /// the contract transfers from its own balance.
    ///
    /// # Arguments
    ///
    /// * `token` (`Address`) — The loyalty token contract address.
    /// * `amount_per_fund` (`i128`) — Fixed amount transferred to `source` on
    ///   each `fund_c_address` call. Use `0` to effectively disable rewards.
    ///   Must be ≥ 0.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::InvalidAmount`] — `amount_per_fund` < 0.
    ///
    /// # Events
    ///
    /// * `("LoyaltyTokenSet", admin)` — data: `(token, amount_per_fund)`
    pub fn set_loyalty_token(
        env: Env,
        token: Address,
        amount_per_fund: i128,
    ) -> Result<(), BridgeError> {
        todo!("implement: set_loyalty_token")
    }

    /// Returns the loyalty token address and reward amount per fund.
    ///
    /// # Returns
    ///
    /// `(token_address, amount_per_fund)`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::LoyaltyTokenNotSet`] — No loyalty token has been configured.
    pub fn query_loyalty_token(env: Env) -> Result<(Address, i128), BridgeError> {
        todo!("implement: query_loyalty_token")
    }

    // -----------------------------------------------------------------------
    // Tiered fees
    // -----------------------------------------------------------------------

    /// Configures volume-based fee tiers for the bridge.
    ///
    /// Once tiers are set, the fee applied to a `fund_c_address` call is
    /// determined by the source address's cumulative bridged volume:
    ///
    /// ```text
    /// for each tier in tiers:
    ///     if source_volume ∈ [tier.min_volume, tier.max_volume]:
    ///         effective_fee_bps = tier.fee_bps
    ///         break
    /// else:
    ///     effective_fee_bps = global_fee_bps  (fallback)
    /// ```
    ///
    /// The per-asset cap still applies on top of the tiered rate.
    ///
    /// # Arguments
    ///
    /// * `tiers` (`Vec<FeeTier>`) — Ordered list of fee tiers. Must contain at
    ///   most `MAX_FEE_TIERS` (50) entries. Each tier's `fee_bps` must be ≤ 1 000.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::TooManyFeeTiers`] — `tiers.len()` exceeds `MAX_FEE_TIERS` (50).
    /// * [`BridgeError::FeeTooHigh`] — Any tier's `fee_bps` exceeds 1 000.
    ///
    /// # Events
    ///
    /// * `("FeeTiersSet", admin)` — data: `(tiers.len(),)`
    pub fn set_fee_tiers(env: Env, tiers: Vec<FeeTier>) -> Result<(), BridgeError> {
        todo!("implement: set_fee_tiers")
    }

    /// Returns the configured fee tiers.
    ///
    /// If no tiers have been set, returns a single synthetic tier covering the
    /// full volume range `[0, i128::MAX]` at the current global fee rate.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_fee_tiers(env: Env) -> Result<Vec<FeeTier>, BridgeError> {
        todo!("implement: query_fee_tiers")
    }

    /// Returns the fee tier that currently applies to `source`, based on their
    /// cumulative bridged volume.
    ///
    /// If no tier matches, returns a synthetic default tier using the global
    /// fee rate, covering the full volume range.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The address to look up.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_current_tier(env: Env, source: Address) -> Result<FeeTier, BridgeError> {
        todo!("implement: query_current_tier")
    }

    // -----------------------------------------------------------------------
    // Cross-chain onboarding
    // -----------------------------------------------------------------------

    /// Credits a C-address from a cross-chain event, verified by M-of-N relayer signatures.
    ///
    /// This function allows off-chain relayers to bridge tokens that arrived
    /// on another chain (e.g. Ethereum, Solana) to a Soroban C-address.
    /// The contract must already hold a sufficient balance of `asset` to pay
    /// out `net_amount` to the target.
    ///
    /// ## Payload Construction
    ///
    /// Relayers must sign `sha256(payload)` where:
    ///
    /// ```text
    /// nonce   = sha256(chain_id_be4 || tx_hash)
    /// payload = chain_id_be4
    ///        || tx_hash
    ///        || sha256(target_strkey_bytes)
    ///        || sha256(asset_strkey_bytes)
    ///        || amount_be16
    ///        || nonce
    /// ```
    ///
    /// ## Parameters
    ///
    /// * `chain_id` (`u32`) — Numeric source-chain ID (e.g. 1 = Ethereum mainnet,
    ///   101 = Solana mainnet).
    /// * `tx_hash` (`BytesN<32>`) — The 32-byte hash of the source-chain transaction.
    /// * `target` (`Address`) — The Soroban C-address to credit.
    /// * `asset` (`Address`) — Whitelisted token contract address.
    /// * `amount` (`i128`) — Gross amount (fee is deducted before crediting `target`).
    /// * `sigs` (`Vec<RelayerSig>`) — At least `threshold` distinct relayer Ed25519
    ///   signatures over the payload hash (see above).
    ///
    /// # Authorization
    ///
    /// No Soroban `require_auth` — authentication is via Ed25519 signatures from
    /// registered relayers. The caller may be any account.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::InvalidAmount`] — `amount` ≤ 0.
    /// * [`BridgeError::AddressBlocked`] — `target` is on the blocklist.
    /// * [`BridgeError::AddressNotAllowlisted`] — Allowlist mode on and `target`
    ///   is not allowlisted.
    /// * [`BridgeError::AssetNotWhitelisted`] — `asset` has not been added.
    /// * [`BridgeError::ReplayedNonce`] — This `(chain_id, tx_hash)` combination
    ///   has already been processed.
    /// * [`BridgeError::NotRelayer`] — A signature's pubkey is not a registered relayer.
    /// * [`BridgeError::DuplicateRelayerSignature`] — The same relayer pubkey
    ///   appears more than once in `sigs`.
    /// * [`BridgeError::BelowThreshold`] — Fewer than `threshold` valid signatures.
    /// * [`BridgeError::InvalidAddress`] — A strkey exceeds `MAX_STRKEY_LEN` (64) bytes.
    ///
    /// # Events
    ///
    /// * `("CrossChainFunded", target)` — data: `(chain_id, tx_hash, amount, fee, asset)`
    ///
    /// # Security Considerations
    ///
    /// The nonce is derived deterministically from `(chain_id, tx_hash)` and
    /// marked used before the token transfer, preventing replay attacks. An
    /// invalid Ed25519 signature causes a host-level trap (panic) rather than
    /// returning an error code, so callers should pre-validate signatures
    /// off-chain. The contract verifies that `sigs` contains distinct
    /// pubkeys — a relayer submitting the same signature twice only counts
    /// once toward the threshold; duplicates are rejected with
    /// [`BridgeError::DuplicateRelayerSignature`].
    pub fn fund_c_address_crosschain(
        env: Env,
        chain_id: u32,
        tx_hash: BytesN<32>,
        target: Address,
        asset: Address,
        amount: i128,
        sigs: Vec<RelayerSig>,
    ) -> Result<(), BridgeError> {
        todo!("implement: fund_c_address_crosschain")
    }

    /// Registers an Ed25519 public key as a trusted relayer.
    ///
    /// Registered relayers may contribute signatures to `fund_c_address_crosschain`.
    /// Adding the same public key twice is idempotent.
    ///
    /// # Arguments
    ///
    /// * `pubkey` (`BytesN<32>`) — Ed25519 public key of the relayer.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn add_relayer(env: Env, pubkey: BytesN<32>) -> Result<(), BridgeError> {
        todo!("implement: add_relayer")
    }

    /// Removes a relayer from the trusted set.
    ///
    /// The removal is rejected if it would reduce the active relayer count
    /// below the current threshold, which would make cross-chain funding
    /// impossible.
    ///
    /// # Arguments
    ///
    /// * `pubkey` (`BytesN<32>`) — Ed25519 public key of the relayer to remove.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::BelowThreshold`] — Removing this relayer would drop the
    ///   count below the required threshold.
    pub fn remove_relayer(env: Env, pubkey: BytesN<32>) -> Result<(), BridgeError> {
        todo!("implement: remove_relayer")
    }

    /// Sets the minimum number of relayer signatures required to process a
    /// cross-chain funding event.
    ///
    /// # Arguments
    ///
    /// * `threshold` (`u32`) — Must be ≤ the current number of registered relayers.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ThresholdExceedsRelayers`] — `threshold` is greater than
    ///   the number of registered relayers.
    pub fn set_relayer_threshold(env: Env, threshold: u32) -> Result<(), BridgeError> {
        todo!("implement: set_relayer_threshold")
    }

    /// Returns the current M-of-N relayer signature threshold.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_relayer_threshold(env: Env) -> Result<u32, BridgeError> {
        todo!("implement: query_relayer_threshold")
    }

    /// Returns `true` if `pubkey` is a registered relayer.
    ///
    /// # Arguments
    ///
    /// * `pubkey` (`BytesN<32>`) — Ed25519 public key to check.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_is_relayer(env: Env, pubkey: BytesN<32>) -> Result<bool, BridgeError> {
        todo!("implement: query_is_relayer")
    }

    // -----------------------------------------------------------------------
    // Timelocked funding
    // -----------------------------------------------------------------------

    /// Creates a time-gated funding record.
    ///
    /// Transfers `amount` from `source` into the contract immediately. The
    /// tokens remain locked until `release_time`, at which point `target` may
    /// call `claim_timelocked` to receive the net amount (after fee deduction).
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The address depositing the tokens. Must authorise.
    /// * `target` (`Address`) — The address that may claim the tokens after
    ///   `release_time`.
    /// * `asset` (`Address`) — The whitelisted token contract.
    /// * `amount` (`i128`) — Gross amount to lock. Must be > 0.
    /// * `release_time` (`u64`) — Unix timestamp (seconds) after which the
    ///   tokens may be claimed. Must be strictly in the future.
    /// * `cliff_time` (`u64`) — Optional cliff timestamp. If > 0 it must be
    ///   ≤ `release_time`. Currently informational only; not enforced by
    ///   `claim_timelocked`.
    /// * `nonce` (`Option<u64>`) — Optional sequential nonce for `source`.
    /// * `deadline` (`Option<u64>`) — Optional Unix timestamp (seconds) after
    ///   which the call is rejected. Pass `None` for no expiry.
    ///
    /// # Authorization
    ///
    /// Requires `source.require_auth()`.
    ///
    /// # Returns
    ///
    /// The numeric ID of the newly created timelock entry. Use this ID with
    /// `claim_timelocked` and `query_timelocked`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::TransactionExpired`] — `deadline` is in the past.
    /// * [`BridgeError::InvalidAmount`] — `amount` ≤ 0.
    /// * [`BridgeError::InvalidReleaseTime`] — `release_time` ≤ current timestamp,
    ///   or `cliff_time > release_time`.
    /// * [`BridgeError::AddressBlocked`] — `target` is on the blocklist.
    /// * [`BridgeError::AddressNotAllowlisted`] — Allowlist mode on and `target`
    ///   is not allowlisted.
    /// * [`BridgeError::AssetNotWhitelisted`] — `asset` has not been added.
    /// * [`BridgeError::DuplicateNonce`] — `nonce` mismatch.
    ///
    /// # Events
    ///
    /// * `("TimelockCreated", source, target)` — data:
    ///   `(id, amount, asset, release_time, cliff_time)`
    ///
    /// # Security Considerations
    ///
    /// The fee rate applied is the rate at **claim time**, not deposit time.
    /// If the global fee rate changes between deposit and claim, the net amount
    /// received by `target` may differ from the amount at deposit time.
    pub fn fund_c_address_timelocked(
        env: Env,
        source: Address,
        target: Address,
        asset: Address,
        amount: i128,
        release_time: u64,
        cliff_time: u64,
        nonce: Option<u64>,
        deadline: Option<u64>,
    ) -> Result<u64, BridgeError> {
        todo!("implement: fund_c_address_timelocked")
    }

    /// Claims a matured timelock entry, releasing the net tokens to `target`.
    ///
    /// The effective fee at the time of claiming is deducted from `amount` and
    /// the net is transferred to `target`. The timelock entry is marked
    /// `claimed = true` to prevent double-claims.
    ///
    /// # Arguments
    ///
    /// * `id` (`u64`) — The timelock entry ID returned by `fund_c_address_timelocked`.
    ///
    /// # Authorization
    ///
    /// Requires `target.require_auth()` (the recipient of the timelock entry).
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::TimelockNotFound`] — No entry exists for `id`.
    /// * [`BridgeError::TimelockNotMatured`] — `release_time` has not passed yet.
    /// * [`BridgeError::Unauthorized`] — The entry has already been claimed.
    ///
    /// # Events
    ///
    /// * `("TimelockClaimed", target)` — data: `(id, net_amount, fee, asset)`
    ///
    /// # Security Considerations
    ///
    /// The `claimed` flag is persisted before the token transfer. Because
    /// Soroban execution is single-threaded within a ledger, this effectively
    /// prevents re-entrancy. The fee rate is the **current** global rate at
    /// claim time, which may differ from the rate at deposit time.
    pub fn claim_timelocked(env: Env, id: u64) -> Result<(), BridgeError> {
        todo!("implement: claim_timelocked")
    }

    /// Returns the timelock entry for `id`.
    ///
    /// # Arguments
    ///
    /// * `id` (`u64`) — The timelock entry ID.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::TimelockNotFound`] — No entry exists for `id`.
    pub fn query_timelocked(env: Env, id: u64) -> Result<TimelockEntry, BridgeError> {
        todo!("implement: query_timelocked")
    }

    // -----------------------------------------------------------------------
    // TTL management
    // -----------------------------------------------------------------------

    /// Extends the instance-storage TTL to ensure contract state does not expire.
    ///
    /// `ttl` is capped at `MAX_ALLOWED_TTL` (3 110 400 ledgers, ~1 year).
    /// The threshold used to trigger extension is `ttl / 4`.
    ///
    /// # Arguments
    ///
    /// * `ttl` (`u32`) — Desired TTL in ledgers (capped at `MAX_ALLOWED_TTL`).
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    ///
    /// # Events
    ///
    /// * `("InstanceTtlExtended",)` — data: `(admin, actual_ttl)`
    pub fn extend_instance_ttl(env: Env, ttl: u32) -> Result<(), BridgeError> {
        todo!("implement: extend_instance_ttl")
    }

    /// Extends the persistent-storage TTL for the three per-asset counter keys
    /// (`AccruedFees`, `TotalBridged`, `TotalFeesCollected`) of `key_asset`.
    ///
    /// Only keys that already exist in storage are extended; missing keys are
    /// silently skipped.
    ///
    /// # Arguments
    ///
    /// * `key_asset` (`Address`) — The asset whose persistent counters should
    ///   have their TTL extended.
    /// * `ttl` (`u32`) — Desired TTL in ledgers (capped at `MAX_ALLOWED_TTL`).
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    ///
    /// # Events
    ///
    /// * `("PersistentTtlExtended",)` — data: `(admin, key_asset, actual_ttl)`
    pub fn extend_persistent_ttl(
        env: Env,
        key_asset: Address,
        ttl: u32,
    ) -> Result<(), BridgeError> {
        todo!("implement: extend_persistent_ttl")
    }

    /// Extends the persistent-storage TTL for a specific timelock entry.
    ///
    /// `extend_persistent_ttl` only ever covered per-asset counter keys, so a
    /// long-dated `TimelockEntry` (see `fund_c_address_timelocked`) had no way
    /// to have its TTL refreshed and could be archived by the network before
    /// `release_time`, making it permanently unclaimable. Call this
    /// periodically for any timelock whose `release_time` is far in the future.
    ///
    /// # Arguments
    ///
    /// * `id` (`u64`) — The timelock entry ID, as returned by
    ///   `fund_c_address_timelocked`.
    /// * `ttl` (`u32`) — Desired TTL in ledgers (capped at `MAX_ALLOWED_TTL`).
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::TimelockNotFound`] — No entry exists for `id`.
    ///
    /// # Events
    ///
    /// * `("TimelockTtlExtended",)` — data: `(admin, id, actual_ttl)`
    pub fn extend_timelock_ttl(env: Env, id: u64, ttl: u32) -> Result<(), BridgeError> {
        todo!("implement: extend_timelock_ttl")
    }

    /// Extends the persistent-storage TTL for a specific commit-reveal entry.
    ///
    /// # Arguments
    ///
    /// * `id` (`u64`) — The commitment ID, as returned by `commit_fund`.
    /// * `ttl` (`u32`) — Desired TTL in ledgers (capped at `MAX_ALLOWED_TTL`).
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::CommitmentNotFound`] — No entry exists for `id`.
    ///
    /// # Events
    ///
    /// * `("CommitmentTtlExtended",)` — data: `(admin, id, actual_ttl)`
    pub fn extend_commitment_ttl(env: Env, id: u64, ttl: u32) -> Result<(), BridgeError> {
        todo!("implement: extend_commitment_ttl")
    }

    /// Extends the persistent-storage TTL for a registered relayer's entry.
    ///
    /// # Arguments
    ///
    /// * `pubkey` (`BytesN<32>`) — The relayer's Ed25519 public key.
    /// * `ttl` (`u32`) — Desired TTL in ledgers (capped at `MAX_ALLOWED_TTL`).
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::NotRelayer`] — `pubkey` is not a registered relayer.
    ///
    /// # Events
    ///
    /// * `("RelayerTtlExtended",)` — data: `(admin, pubkey, actual_ttl)`
    pub fn extend_relayer_ttl(env: Env, pubkey: BytesN<32>, ttl: u32) -> Result<(), BridgeError> {
        todo!("implement: extend_relayer_ttl")
    }

    /// Extends the persistent-storage TTL for all per-`(source, asset)` and
    /// per-`source` keys used by the core funding paths: `SourceDailyLimit`,
    /// the current day's `DailyUsage`, `UserDeposit`, `SourceBridgedVolume`,
    /// the sequential `Nonce`, and the auth-entry `AuthNonce` counter.
    ///
    /// Only keys that already exist in storage are extended; missing keys are
    /// silently skipped, mirroring `extend_persistent_ttl`.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The address whose per-source entries should
    ///   have their TTL extended.
    /// * `asset` (`Address`) — The asset half of the `(source, asset)` keys.
    /// * `ttl` (`u32`) — Desired TTL in ledgers (capped at `MAX_ALLOWED_TTL`).
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    ///
    /// # Events
    ///
    /// * `("SourcePersistentTtlExtended",)` — data: `(admin, source, asset, actual_ttl)`
    pub fn extend_source_persistent_ttl(
        env: Env,
        source: Address,
        asset: Address,
        ttl: u32,
    ) -> Result<(), BridgeError> {
        todo!("implement: extend_source_persistent_ttl")
    }

    /// Overrides the maximum instance-storage TTL used by the internal
    /// `extend_instance_ttl` helper called on every mutating operation.
    ///
    /// Values above `MAX_ALLOWED_TTL` are silently capped. Values below
    /// `MIN_ALLOWED_TTL` are rejected outright: `extend_instance_ttl` derives
    /// its extension threshold as `max_ttl / 4`, so a max of `0` (or any very
    /// small value) would make the threshold `0` too, effectively disabling
    /// TTL extension and risking near-term expiry of all instance data.
    ///
    /// # Arguments
    ///
    /// * `ttl` (`u32`) — New maximum in ledgers. Must be ≥ `MIN_ALLOWED_TTL`.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::InvalidTtl`] — `ttl` is below `MIN_ALLOWED_TTL`.
    pub fn set_max_instance_ttl(env: Env, ttl: u32) -> Result<(), BridgeError> {
        todo!("implement: set_max_instance_ttl")
    }

    /// Overrides the maximum persistent-storage TTL used by `extend_persistent_ttl`.
    ///
    /// Values above `MAX_ALLOWED_TTL` are silently capped. Values below
    /// `MIN_ALLOWED_TTL` are rejected for the same reason as
    /// `set_max_instance_ttl`: a near-zero max would collapse the extension
    /// threshold to zero and disable TTL extension entirely.
    ///
    /// # Arguments
    ///
    /// * `ttl` (`u32`) — New maximum in ledgers. Must be ≥ `MIN_ALLOWED_TTL`.
    ///
    /// # Authorization
    ///
    /// Requires the current admin's `require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::InvalidTtl`] — `ttl` is below `MIN_ALLOWED_TTL`.
    pub fn set_max_persistent_ttl(env: Env, ttl: u32) -> Result<(), BridgeError> {
        todo!("implement: set_max_persistent_ttl")
    }

    /// Returns the four TTL configuration values.
    ///
    /// # Returns
    ///
    /// `(max_instance_ttl, max_persistent_ttl, hard_ceiling, critical_threshold)`
    /// where:
    /// - `max_instance_ttl` — current configurable max for instance storage
    /// - `max_persistent_ttl` — current configurable max for persistent storage
    /// - `hard_ceiling` — `MAX_ALLOWED_TTL` constant (3 110 400 ledgers)
    /// - `critical_threshold` — `CRITICAL_ENTRY_TTL_THRESHOLD` (100 000 ledgers)
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_ttl_config(env: Env) -> Result<(u32, u32, u32, u32), BridgeError> {
        todo!("implement: query_ttl_config")
    }

    // -----------------------------------------------------------------------
    // Auth-entry replay protection (issue #95)
    // -----------------------------------------------------------------------

    /// Validates and permanently consumes a Soroban authorization-entry nonce.
    ///
    /// This prevents Soroban authorization-entry reuse attacks by:
    ///
    /// 1. Requiring the current ledger sequence to be within
    ///    `[valid_after_ledger, valid_before_ledger)`.
    /// 2. Checking that `(source, nonce)` has not been used before.
    /// 3. Permanently marking the pair as used in persistent storage.
    /// 4. Emitting `AuthUsed(source, nonce)` for off-chain tracking.
    ///
    /// The nonce is scoped to this contract's own persistent storage, so the
    /// same numeric nonce may be used with a different contract without conflict.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The address whose authorization entry is consumed.
    /// * `nonce` (`u64`) — The nonce to burn. Must not have been used before.
    /// * `valid_after_ledger` (`u32`) — Inclusive lower bound on the current
    ///   ledger sequence number.
    /// * `valid_before_ledger` (`u32`) — Exclusive upper bound on the current
    ///   ledger sequence number.
    ///
    /// # Authorization
    ///
    /// Requires `source.require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::AuthNonceExpired`] — Current ledger sequence is outside
    ///   the `[valid_after_ledger, valid_before_ledger)` window.
    /// * [`BridgeError::AuthNonceAlreadyUsed`] — This `(source, nonce)` pair has
    ///   already been consumed.
    ///
    /// # Events
    ///
    /// * `("AuthUsed", source)` — data: `(nonce,)`
    ///
    /// # Security Considerations
    ///
    /// The window `[valid_after_ledger, valid_before_ledger)` should be kept
    /// narrow (e.g. current ledger ± a few hundred blocks) to minimise the
    /// replay window. Once consumed, a `(source, nonce)` pair can never be
    /// re-used regardless of how much time passes.
    ///
    /// # Examples
    ///
    /// ```rust,no_run
    /// // let nonce = bridge.query_auth_nonce(&source);
    /// // let seq = env.ledger().sequence();
    /// // bridge.verify_auth_entry(&source, &nonce, &seq, &(seq + 100));
    /// ```
    pub fn verify_auth_entry(
        env: Env,
        source: Address,
        nonce: u64,
        valid_after_ledger: u32,
        valid_before_ledger: u32,
    ) -> Result<(), BridgeError> {
        todo!("implement: verify_auth_entry")
    }

    /// Returns the next unused auth nonce for `source`.
    ///
    /// This is the lowest nonce value that has not yet been consumed for this
    /// address. Callers should use this value when constructing a new
    /// authorization entry to pass to `verify_auth_entry`.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The address to query.
    pub fn query_auth_nonce(env: Env, source: Address) -> u64 {
        todo!("implement: query_auth_nonce")
    }

    /// Returns `true` if a specific auth nonce has already been consumed for `source`.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The address to query.
    /// * `nonce` (`u64`) — The nonce to check.
    pub fn query_auth_nonce_used(env: Env, source: Address, nonce: u64) -> bool {
        is_auth_nonce_used(&env, &source, nonce)
    }

    /// Returns the accrued (pending, not yet withdrawn) fee balance for `asset`.
    ///
    /// Accrued fees accumulate on every `fund_c_address` call and are
    /// decremented when `withdraw_fees` is called. This value is always
    /// ≤ `query_fee_balance` (the contract's actual token balance).
    ///
    /// # Arguments
    ///
    /// * `asset` (`Address`) — The token to query.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    pub fn query_accrued_fees(env: Env, asset: Address) -> Result<i128, BridgeError> {
        check_initialized(&env)?;
        Ok(read_accrued_fees(&env, &asset))
    }

    // -----------------------------------------------------------------------
    // Commit-reveal funding (issue #30)
    // -----------------------------------------------------------------------

    /// Stores a blinded funding commitment without revealing the amount.
    ///
    /// The caller commits to a specific `(source, target, asset, amount)` by
    /// providing `amount_hash = sha256(amount_be16 || nonce_be8)`.  The actual
    /// amount stays hidden until `reveal_fund` is called, preventing
    /// front-runners from observing the value before the commitment is settled.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The account that will supply the tokens.
    /// * `target` (`Address`) — The C-address that will receive the net amount.
    /// * `asset` (`Address`) — Whitelisted token contract address.
    /// * `amount_hash` (`BytesN<32>`) — `sha256(amount_be16 || nonce_be8)`.
    /// * `deadline` (`u64`) — Unix timestamp; `reveal_fund` must be called
    ///   before this time.
    ///
    /// # Authorization
    ///
    /// Requires `source.require_auth()`.
    ///
    /// # Returns
    ///
    /// A numeric commitment ID used to reference this entry in `reveal_fund`
    /// and `query_commitment`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::TransactionExpired`] — `deadline` is in the past.
    /// * [`BridgeError::AddressBlocked`] — `target` is on the blocklist.
    /// * [`BridgeError::AddressNotAllowlisted`] — Allowlist mode on and `target`
    ///   is not allowlisted.
    /// * [`BridgeError::AssetNotWhitelisted`] — `asset` has not been added.
    ///
    /// # Events
    ///
    /// * `("CommitFund", source, target)` — data: `(id, amount_hash, asset, deadline)`
    pub fn commit_fund(
        env: Env,
        source: Address,
        target: Address,
        asset: Address,
        amount_hash: BytesN<32>,
        deadline: u64,
    ) -> Result<u64, BridgeError> {
        let _guard = ReentrancyGuard::enter(&env)?;
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if env.ledger().timestamp() >= deadline {
            return Err(BridgeError::TransactionExpired);
        }
        check_access(&env, &target)?;
        check_asset_whitelisted(&env, &asset)?;
        source.require_auth();
        extend_instance_ttl(&env);

        let id = next_commitment_id(&env);
        let committed_at_ledger = env.ledger().sequence();

        save_commitment(
            &env,
            id,
            &CommitmentEntry {
                source: source.clone(),
                target: target.clone(),
                asset: asset.clone(),
                amount_hash: amount_hash.clone(),
                deadline,
                committed_at_ledger,
                revealed: false,
            },
        );

        env.events().publish(
            ("CommitFund", source, target),
            (id, amount_hash, asset, deadline),
        );
        Ok(id)
    }

    /// Executes a previously committed fund transfer after the minimum delay.
    ///
    /// Verifies `sha256(amount_be16 || nonce_be8) == stored_amount_hash` before
    /// transferring tokens, ensuring the caller cannot substitute a different
    /// amount from the one committed.
    ///
    /// # Arguments
    ///
    /// * `commitment_id` (`u64`) — ID returned by `commit_fund`.
    /// * `source` (`Address`) — Must match the committed source.
    /// * `target` (`Address`) — Must match the committed target.
    /// * `asset` (`Address`) — Must match the committed asset.
    /// * `amount` (`i128`) — Actual gross amount; must satisfy the hash.
    /// * `nonce` (`u64`) — Blinding nonce used when computing `amount_hash`.
    ///
    /// # Authorization
    ///
    /// Requires `source.require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::CommitmentNotFound`] — No entry for `commitment_id`.
    /// * [`BridgeError::CommitmentAlreadyRevealed`] — Already revealed.
    /// * [`BridgeError::CommitmentExpired`] — Past the reveal deadline.
    /// * [`BridgeError::CommitmentNotMatured`] — Minimum delay not yet elapsed.
    /// * [`BridgeError::Unauthorized`] — `source`, `target`, or `asset` do not
    ///   match the commitment.
    /// * [`BridgeError::CommitmentHashMismatch`] — Hash does not match.
    /// * [`BridgeError::InvalidAmount`] — `amount` ≤ 0.
    /// * [`BridgeError::Overflow`] — Fee arithmetic overflowed.
    ///
    /// # Events
    ///
    /// * `("CommitRevealFunded", asset, source, target)` — data:
    ///   `(commitment_id, amount, fee)`
    pub fn reveal_fund(
        env: Env,
        commitment_id: u64,
        source: Address,
        target: Address,
        asset: Address,
        amount: i128,
        nonce: u64,
    ) -> Result<(), BridgeError> {
        let _guard = ReentrancyGuard::enter(&env)?;
        check_initialized(&env)?;
        check_not_paused(&env)?;

        let mut entry = read_commitment(&env, commitment_id)
            .ok_or(BridgeError::CommitmentNotFound)?;

        if entry.revealed {
            return Err(BridgeError::CommitmentAlreadyRevealed);
        }

        if env.ledger().timestamp() > entry.deadline {
            return Err(BridgeError::CommitmentExpired);
        }

        if env.ledger().sequence()
            < entry
                .committed_at_ledger
                .saturating_add(COMMIT_REVEAL_MIN_DELAY_LEDGERS)
        {
            return Err(BridgeError::CommitmentNotMatured);
        }

        if entry.source != source || entry.target != target || entry.asset != asset {
            return Err(BridgeError::Unauthorized);
        }

        // Verify hash: sha256(amount_be16 || nonce_be8)
        let mut preimage = Bytes::new(&env);
        preimage.extend_from_array(&amount.to_be_bytes());
        preimage.extend_from_array(&nonce.to_be_bytes());
        let computed_hash: BytesN<32> = env.crypto().sha256(&preimage).into();
        if computed_hash != entry.amount_hash {
            return Err(BridgeError::CommitmentHashMismatch);
        }

        if amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let minimum_amount = read_minimum_amount(&env);
        if amount < minimum_amount {
            return Err(BridgeError::InvalidAmount);
        }

        source.require_auth();

        // Mark revealed before the transfer to prevent re-entrancy replay.
        entry.revealed = true;
        save_commitment(&env, commitment_id, &entry);

        let token_client = token::Client::new(&env, &asset);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&source, &contract_addr, &amount);

        let global_fee_bps = read_fee_bps(&env);
        let tiered_fee_bps = get_tiered_fee_bps(&env, &source, global_fee_bps);
        let effective_fee_bps = get_effective_fee_bps(&env, &asset, tiered_fee_bps);
        let fee = calculate_fee(amount, effective_fee_bps)?;
        let net_amount = safe_math::safe_sub(amount, fee)?;

        if net_amount > 0 {
            token_client.transfer(&contract_addr, &target, &net_amount);
        }

        increment_accrued_fees(&env, &asset, fee)?;
        increment_total_bridged(&env, &asset, net_amount)?;
        increment_total_fees_collected(&env, &asset, fee)?;
        increment_source_bridged_volume(&env, &source, amount)?;
        extend_instance_ttl(&env);

        mint_loyalty_tokens(&env, &source);

        env.events().publish(
            ("CommitRevealFunded", asset, source, target),
            (commitment_id, amount, fee),
        );
        Ok(())
    }

    /// Returns a commitment entry by ID.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::CommitmentNotFound`] — No entry for `id`.
    pub fn query_commitment(env: Env, id: u64) -> Result<CommitmentEntry, BridgeError> {
        read_commitment(&env, id).ok_or(BridgeError::CommitmentNotFound)
    }

    // -----------------------------------------------------------------------
    // Swap-and-bridge (#100)
    // -----------------------------------------------------------------------

    /// Fund a C-address by swapping `source_asset` into `target_asset` first.
    ///
    /// Flow:
    /// 1. Pull `source_amount` of `source_asset` from `source` into the contract.
    /// 2. Invoke the single whitelisted pool in `swap_route` using the standard
    ///    two-token `swap(min_amount_out, to)` interface.
    /// 3. Verify the final `target_asset` balance received ≥ `min_target_amount`.
    /// 4. Deduct the fee (in `target_asset`) and transfer the net amount to
    ///    `target`.
    ///
    /// # Arguments
    ///
    /// * `source` — Account providing `source_asset`. Must authorise.
    /// * `target` — Destination C-address to receive `target_asset`.
    /// * `source_asset` — Token contract the source holds (e.g. USDC).
    /// * `target_asset` — Token contract the target should receive (e.g. XLM).
    /// * `source_amount` — Gross amount of `source_asset` to pull from source.
    /// * `min_target_amount` — Slippage guard: revert if the swap yields less.
    /// * `swap_route` — Must contain exactly one DEX pool contract address,
    ///   and that address must be on the swap-pool whitelist (see
    ///   `add_swap_pool`). The pool must implement:
    ///   `swap(min_amount_out: i128, to: Address) -> i128`.
    ///
    /// # Authorization
    ///
    /// Requires `source.require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::InvalidAmount`] — `source_amount` or `min_target_amount` ≤ 0.
    /// * [`BridgeError::AddressBlocked`] — `target` is on the blocklist.
    /// * [`BridgeError::AddressNotAllowlisted`] — Allowlist mode is on and `target` is not listed.
    /// * [`BridgeError::AssetNotWhitelisted`] — `target_asset` is not whitelisted.
    /// * [`BridgeError::MultiHopNotSupported`] — `swap_route` does not contain
    ///   exactly one pool.
    /// * [`BridgeError::PoolNotWhitelisted`] — The pool in `swap_route` is not
    ///   on the swap-pool whitelist.
    /// * [`BridgeError::SwapFailed`] — The pool returned zero tokens out.
    /// * [`BridgeError::SlippageExceeded`] — Swap output < `min_target_amount`.
    ///
    /// # Security Considerations
    ///
    /// `swap_route` addresses are invoked with `env.invoke_contract` after
    /// the contract has already transferred tokens to them. Without a
    /// whitelist, a malicious or unvetted pool could keep the transferred
    /// tokens and return a fabricated `amount_out`, effectively stealing
    /// from the source. Every address in `swap_route` is therefore required
    /// to be present in the admin-managed pool whitelist (`add_swap_pool` /
    /// `remove_swap_pool`), which mirrors the existing asset whitelist
    /// pattern. Only the admin should whitelist pools, and only after
    /// auditing their `swap` implementation and token-return behavior.
    ///
    /// Multi-hop routes are intentionally out of scope: the contract cannot
    /// generally know which token an intermediate pool actually returns, and
    /// assuming it equals `target_asset` mid-route can cause the contract to
    /// transfer the wrong token into the next pool. `swap_route` is therefore
    /// restricted to exactly one hop; longer routes return
    /// [`BridgeError::MultiHopNotSupported`] rather than silently
    /// miscomputing the swap.
    pub fn fund_c_address_with_swap(
        env: Env,
        source: Address,
        target: Address,
        source_asset: Address,
        target_asset: Address,
        source_amount: i128,
        min_target_amount: i128,
        swap_route: Vec<Address>,
        nonce: Option<u64>,
        deadline: Option<u64>,
    ) -> Result<(), BridgeError> {
        let _guard = ReentrancyGuard::enter(&env)?;
        check_initialized(&env)?;
        check_not_paused(&env)?;
        if let Some(d) = deadline {
            if env.ledger().timestamp() > d {
                return Err(BridgeError::TransactionExpired);
            }
        }

        if source_amount <= 0 || min_target_amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }

        check_access(&env, &target)?;
        // Only the output asset needs to be whitelisted (what arrives at target).
        check_asset_whitelisted(&env, &target_asset)?;

        // Multi-hop routes are out of scope: the contract cannot verify which
        // token an intermediate pool returns, so only a single, whitelisted
        // pool is permitted. See "Security Considerations" above.
        if swap_route.len() != 1 {
            return Err(BridgeError::MultiHopNotSupported);
        }
        let pool = swap_route.get(0).unwrap();
        check_pool_whitelisted(&env, &pool)?;

        source.require_auth();
        consume_nonce(&env, &source, nonce)?;
        extend_instance_ttl(&env);

        let contract_addr = env.current_contract_address();

        // Step 1: pull source_asset into the contract.
        let source_token = token::Client::new(&env, &source_asset);
        source_token.transfer(&source, &contract_addr, &source_amount);

        // Step 2: invoke the single whitelisted pool.
        // Each pool must implement: swap(min_amount_out: i128, to: Address) -> i128
        // The contract uses a push model: transfer source_amount to the pool
        // first, then call swap. The pool detects its received balance and
        // performs the swap, transferring target_asset back to `to`.
        source_token.transfer(&contract_addr, &pool, &source_amount);

        let swap_sym = soroban_sdk::Symbol::new(&env, "swap");
        let swap_args: Vec<soroban_sdk::Val> = soroban_sdk::vec![
            &env,
            min_target_amount.into_val(&env),
            contract_addr.into_val(&env),
        ];
        let amount_out: i128 = env.invoke_contract(&pool, &swap_sym, swap_args);

        if amount_out <= 0 {
            return Err(BridgeError::SwapFailed);
        }

        let amount_in = amount_out;

        // Step 3: slippage check on final output.
        if amount_in < min_target_amount {
            return Err(BridgeError::SlippageExceeded);
        }

        let received_amount = amount_in;

        // Step 4: deduct fee in target_asset and forward net to target.
        let global_fee_bps = read_fee_bps(&env);
        let tiered_fee_bps = get_tiered_fee_bps(&env, &source, global_fee_bps);
        let effective_fee_bps = get_effective_fee_bps(&env, &target_asset, tiered_fee_bps);
        let fee = calculate_fee(received_amount, effective_fee_bps)?;
        let net_amount = safe_math::safe_sub(received_amount, fee)?;

        let target_token = token::Client::new(&env, &target_asset);
        if net_amount > 0 {
            target_token.transfer(&contract_addr, &target, &net_amount);
        }

        increment_accrued_fees(&env, &target_asset, fee)?;
        increment_total_bridged(&env, &target_asset, net_amount)?;
        increment_total_fees_collected(&env, &target_asset, fee)?;
        increment_source_bridged_volume(&env, &source, source_amount)?;

        mint_loyalty_tokens(&env, &source);

        env.events().publish(
            ("SwapAndFunded", source_asset, target_asset, source, target),
            (source_amount, received_amount, fee),
        );

        Ok(())
    }

    // -----------------------------------------------------------------------
    // Issue #35: EIP-712-style meta-transaction (gasless / relayer-submitted)
    // -----------------------------------------------------------------------

    /// Binds an Ed25519 public key to `source` for use with `execute_meta_fund`.
    ///
    /// `execute_meta_fund` authenticates purely via an Ed25519 signature check —
    /// it never calls `require_auth`. Without this registry, verifying that
    /// *some* keypair signed the payload proves nothing about whose funds are
    /// being moved: any keypair holder could submit a validly-signed meta-tx
    /// naming an arbitrary `params.source`. Calling this once (authorised by
    /// `source` itself) establishes the binding that `execute_meta_fund` then
    /// enforces on every subsequent call.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The account this pubkey is allowed to sign for.
    /// * `pubkey` (`BytesN<32>`) — The Ed25519 public key to bind to `source`.
    ///
    /// # Authorization
    ///
    /// Requires `source.require_auth()`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not yet initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    ///
    /// # Events
    ///
    /// * `("MetaSignerRegistered", source)` — data: `(pubkey,)`
    pub fn register_meta_signer(
        env: Env,
        source: Address,
        pubkey: BytesN<32>,
    ) -> Result<(), BridgeError> {
        check_initialized(&env)?;
        check_not_paused(&env)?;
        source.require_auth();
        save_meta_signer(&env, &source, &pubkey);
        env.events()
            .publish(("MetaSignerRegistered", source), (pubkey,));
        Ok(())
    }

    /// Returns the Ed25519 public key currently bound to `source` via
    /// `register_meta_signer`, or `None` if no key has been registered.
    ///
    /// # Arguments
    ///
    /// * `source` (`Address`) — The address to query.
    pub fn query_meta_signer(env: Env, source: Address) -> Option<BytesN<32>> {
        read_meta_signer(&env, &source)
    }

    /// Execute a fund_c_address on behalf of a user who signed the parameters
    /// off-chain.
    ///
    /// Pattern (EIP-712-style adapted for Stellar / Soroban):
    ///
    /// 1. The *user* constructs a `MetaFundParams` struct, serialises it as:
    ///    ```text
    ///    payload = sha256(
    ///        "meta_fund"           (8 bytes, ASCII)
    ///        || source_strkey      (sha256 of strkey bytes, 32 bytes)
    ///        || target_strkey      (sha256 of strkey bytes, 32 bytes)
    ///        || asset_strkey       (sha256 of strkey bytes, 32 bytes)
    ///        || amount_be16        (i128 big-endian, 16 bytes)
    ///        || nonce_be8          (u64 big-endian,  8 bytes)
    ///        || deadline_be8       (u64 big-endian,  8 bytes)
    ///    )
    ///    ```
    /// 2. The user signs `payload` with their Ed25519 key and gives
    ///    `(signature, pubkey, params)` to a relayer.
    /// 3. The relayer calls `execute_meta_fund` — it verifies the signature,
    ///    checks the deadline and nonce, then performs the same token-transfer
    ///    flow as `fund_c_address`.
    ///
    /// This enables gas abstraction: the user never needs XLM for fees; the
    /// relayer covers the Stellar transaction fee.
    ///
    /// # Arguments
    ///
    /// * `params` — Funding parameters signed by the user.
    /// * `pubkey` — The user's Ed25519 public key (`BytesN<32>`). Must already be
    ///   bound to `params.source` via `register_meta_signer`.
    /// * `signature` — Ed25519 signature over the canonical payload hash.
    ///
    /// # Authorization
    ///
    /// No `require_auth()` — authentication is entirely via Ed25519 signature.
    /// The relayer submits this transaction; the user's identity is proven by
    /// `pubkey` and `signature`.
    ///
    /// # Errors
    ///
    /// * [`BridgeError::NotInitialized`] — Contract not initialised.
    /// * [`BridgeError::ContractPaused`] — Contract is paused.
    /// * [`BridgeError::MetaTxExpired`] — `params.deadline` is in the past.
    /// * [`BridgeError::MetaTxNonceAlreadyUsed`] — Nonce already consumed.
    /// * [`BridgeError::MetaTxInvalidSignature`] — Signature verification failed
    ///   (host will trap on invalid Ed25519 — this variant is for structural errors).
    /// * [`BridgeError::InvalidAmount`] — `params.amount` ≤ 0.
    /// * [`BridgeError::AddressBlocked`] — `params.target` is blocked.
    /// * [`BridgeError::AddressNotAllowlisted`] — Allowlist mode and target not listed.
    /// * [`BridgeError::AssetNotWhitelisted`] — Asset not whitelisted.
    /// * [`BridgeError::DailyLimitExceeded`] — Daily limit exceeded.
    /// * [`BridgeError::InvalidAddress`] — A strkey exceeds `MAX_STRKEY_LEN` (64) bytes.
    /// * [`BridgeError::MetaTxPubkeySourceMismatch`] — `pubkey` is not the key
    ///   `params.source` registered via `register_meta_signer`.
    ///
    /// # Events
    ///
    /// * `("MetaFundExecuted", asset, source, target)` — data: `(amount, fee, nonce)`
    pub fn execute_meta_fund(
        env: Env,
        params: MetaFundParams,
        pubkey: BytesN<32>,
        signature: BytesN<64>,
    ) -> Result<(), BridgeError> {
        let _guard = ReentrancyGuard::enter(&env)?;
        check_initialized(&env)?;
        check_not_paused(&env)?;

        // 1. Deadline check
        if env.ledger().timestamp() > params.deadline {
            return Err(BridgeError::MetaTxExpired);
        }

        // 2. Nonce replay check
        let nonce_key = DataKey::MetaTxNonce(params.source.clone(), params.nonce);
        let already_used: bool = env.storage()
            .persistent()
            .get(&nonce_key)
            .unwrap_or(false);
        if already_used {
            return Err(BridgeError::MetaTxNonceAlreadyUsed);
        }

        // 3. Validate amount before touching storage
        if params.amount <= 0 {
            return Err(BridgeError::InvalidAmount);
        }
        let minimum_amount = read_minimum_amount(&env);
        if params.amount < minimum_amount {
            return Err(BridgeError::InvalidAmount);
        }

        // 4. Access / whitelist checks
        check_access(&env, &params.target)?;
        check_asset_whitelisted(&env, &params.asset)?;
        check_daily_limit(&env, &params.source, &params.asset, params.amount)?;

        // 4b. Bind the signature to `params.source`: verifying the Ed25519
        //     signature alone only proves *some* keypair signed the payload,
        //     not that it belongs to `params.source`. Require `pubkey` to be
        //     the one `params.source` registered via `register_meta_signer`.
        match read_meta_signer(&env, &params.source) {
            Some(registered) if registered == pubkey => {}
            _ => return Err(BridgeError::MetaTxPubkeySourceMismatch),
        }

        // 5. Build canonical payload hash and verify signature
        //    payload = sha256(domain || source_hash || target_hash || asset_hash
        //                     || amount_be16 || nonce_be8 || deadline_be8)
        let domain: soroban_sdk::Bytes = soroban_sdk::Bytes::from_slice(&env, b"meta_fund");

        let mut addr_buf = [0u8; MAX_STRKEY_LEN];

        let src_str = params.source.clone().to_string();
        let slen = src_str.len() as usize;
        if slen > MAX_STRKEY_LEN {
            return Err(BridgeError::InvalidAddress);
        }
        src_str.copy_into_slice(&mut addr_buf[..slen]);
        let src_raw = soroban_sdk::Bytes::from_slice(&env, &addr_buf[..slen]);
        let src_hash: BytesN<32> = env.crypto().sha256(&src_raw).into();

        let tgt_str = params.target.clone().to_string();
        let tlen = tgt_str.len() as usize;
        if tlen > MAX_STRKEY_LEN {
            return Err(BridgeError::InvalidAddress);
        }
        tgt_str.copy_into_slice(&mut addr_buf[..tlen]);
        let tgt_raw = soroban_sdk::Bytes::from_slice(&env, &addr_buf[..tlen]);
        let tgt_hash: BytesN<32> = env.crypto().sha256(&tgt_raw).into();

        let ast_str = params.asset.clone().to_string();
        let alen = ast_str.len() as usize;
        if alen > MAX_STRKEY_LEN {
            return Err(BridgeError::InvalidAddress);
        }
        ast_str.copy_into_slice(&mut addr_buf[..alen]);
        let ast_raw = soroban_sdk::Bytes::from_slice(&env, &addr_buf[..alen]);
        let ast_hash: BytesN<32> = env.crypto().sha256(&ast_raw).into();

        let mut payload = soroban_sdk::Bytes::new(&env);
        payload.append(&domain);
        payload.append(&src_hash.into());
        payload.append(&tgt_hash.into());
        payload.append(&ast_hash.into());
        payload.extend_from_array(&params.amount.to_be_bytes());
        payload.extend_from_array(&params.nonce.to_be_bytes());
        payload.extend_from_array(&params.deadline.to_be_bytes());

        let payload_hash: BytesN<32> = env.crypto().sha256(&payload).into();

        // ed25519_verify traps on invalid sig — this is the intended behaviour
        // (same as fund_c_address_crosschain). The MetaTxInvalidSignature error
        // is reserved for future structural checks.
        env.crypto().ed25519_verify(&pubkey, &payload_hash.into(), &signature);

        // 6. Mark nonce used (before any transfer to prevent re-entrancy)
        env.storage().persistent().set(&nonce_key, &true);

        // 7. Execute the transfer (same logic as fund_c_address)
        let token_client = token::Client::new(&env, &params.asset);
        let contract_addr = env.current_contract_address();
        token_client.transfer(&params.source, &contract_addr, &params.amount);

        let global_fee_bps = read_fee_bps(&env);
        let tiered_fee_bps = get_tiered_fee_bps(&env, &params.source, global_fee_bps);
        let effective_fee_bps = get_effective_fee_bps(&env, &params.asset, tiered_fee_bps);
        let fee = calculate_fee(params.amount, effective_fee_bps)?;
        let net_amount = safe_math::safe_sub(params.amount, fee)?;

        if net_amount > 0 {
            token_client.transfer(&contract_addr, &params.target, &net_amount);
        }

        increment_user_deposit(&env, &params.source, &params.asset, params.amount)?;
        increment_accrued_fees(&env, &params.asset, fee)?;
        increment_total_bridged(&env, &params.asset, net_amount)?;
        increment_total_fees_collected(&env, &params.asset, fee)?;
        increment_source_bridged_volume(&env, &params.source, params.amount)?;

        extend_instance_ttl(&env);

        // execute_meta_fund replays the same transfer flow as fund_c_address on
        // the user's behalf, so it earns the same loyalty reward.
        mint_loyalty_tokens(&env, &params.source);

        env.events().publish(
            ("MetaFundExecuted", params.asset, params.source, params.target),
            (params.amount, fee, params.nonce),
        );
        Ok(())
    }

    /// Returns `true` if the given meta-transaction nonce has already been used
    /// for `source`.
    ///
    /// Call this before constructing a `MetaFundParams` to get the next safe nonce,
    /// or to verify a pending meta-tx has not been replayed.
    ///
    /// # Arguments
    ///
    /// * `source` — The user's Stellar address.
    /// * `nonce` — The nonce to check.
    pub fn query_meta_tx_nonce_used(env: Env, source: Address, nonce: u64) -> bool {
        env.storage()
            .persistent()
            .get(&DataKey::MetaTxNonce(source, nonce))
            .unwrap_or(false)
    }
}

/// Parameters for an EIP-712-style meta-transaction fund request.
///
/// The user fills this struct, signs the canonical payload hash off-chain,
/// and hands `(params, pubkey, signature)` to a relayer who submits
/// `execute_meta_fund` on-chain.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MetaFundParams {
    /// The user's Stellar address (source of funds). `pubkey` must be the key
    /// registered for this address via `register_meta_signer` — enforced by
    /// `execute_meta_fund`, not merely documented here.
    pub source: Address,
    /// Destination C-address.
    pub target: Address,
    /// Whitelisted token contract address.
    pub asset: Address,
    /// Gross amount to transfer (fee deducted from this).
    pub amount: i128,
    /// Monotonically-increasing per-user nonce; prevents replay.
    pub nonce: u64,
    /// Unix timestamp (seconds) after which this meta-tx is rejected.
    pub deadline: u64,
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod overflow_accumulator_tests;

#[cfg(test)]
mod fee_fuzz_tests;

#[cfg(test)]
mod fund_amount_fuzz_tests;

#[cfg(test)]
mod benchmarks;

#[cfg(test)]
mod integration_tests;


#[cfg(test)]
mod explicit_auth_tests;

#[cfg(test)]
mod smoke_tests;
