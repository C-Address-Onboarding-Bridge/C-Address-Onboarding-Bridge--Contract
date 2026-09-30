use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexedEvent {
    pub id: String,
    pub event_type: String,
    pub ledger_sequence: i64,
    pub contract_id: String,
    pub tx_hash: String,
    pub timestamp: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct EventQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// Hard ceiling on `limit` for any paginated route. SQLite treats a negative
/// `LIMIT` as "no limit", and an oversized positive one has the same
/// practical effect (dumping the whole table in one response), so every
/// route clamps into `1..=MAX_PAGE_LIMIT` instead of trusting the caller.
/// See #648.
pub const MAX_PAGE_LIMIT: i64 = 500;

/// Clamps a user-supplied `limit` into `1..=MAX_PAGE_LIMIT`, falling back to
/// `default` when absent.
pub fn clamp_limit(limit: Option<i64>, default: i64) -> i64 {
    limit.unwrap_or(default).clamp(1, MAX_PAGE_LIMIT)
}

/// Clamps a user-supplied `offset` to be non-negative.
pub fn clamp_offset(offset: Option<i64>) -> i64 {
    offset.unwrap_or(0).max(0)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum BridgeEventType {
    CAddressFunded,
    FeesWithdrawn,
    AdminChanged,
    FeeCollectorChanged,
    FeeBpsChanged,
    ContractPaused,
    ContractUnpaused,
    EmergencyWithdrawal,
    BatchCompleted,
    CrossChainFunded,
    TimelockCreated,
    TimelockClaimed,
    AssetAdded,
    AssetFeeCapChanged,
    SourceDailyLimitChanged,
    MinimumAmountChanged,
    MaxWithdrawPerTxChanged,
    MaxPersistentTtlChanged,
    AddressBlocklisted,
    AddressUnblocklisted,
    AddressAllowlisted,
    AddressUnallowlisted,
    AllowlistModeChanged,
    Initialized,
    UpgradeScheduled,
    UpgradeCancelled,
    ContractUpgraded,
    EmergencyMigrated,
    ReferralRateChanged,
}

impl BridgeEventType {
    pub fn from_topic(topic: &str) -> Option<Self> {
        match topic {
            "CAddressFunded" => Some(Self::CAddressFunded),
            "FeesWithdrawn" => Some(Self::FeesWithdrawn),
            "AdminChanged" => Some(Self::AdminChanged),
            "FeeCollectorChanged" => Some(Self::FeeCollectorChanged),
            "FeeBpsChanged" => Some(Self::FeeBpsChanged),
            "ContractPaused" => Some(Self::ContractPaused),
            "ContractUnpaused" => Some(Self::ContractUnpaused),
            "TokensReclaimed" => Some(Self::EmergencyWithdrawal),
            "BatchCompleted" => Some(Self::BatchCompleted),
            "CrossChainFunded" => Some(Self::CrossChainFunded),
            "TimelockCreated" => Some(Self::TimelockCreated),
            "TimelockClaimed" => Some(Self::TimelockClaimed),
            "AssetAdded" => Some(Self::AssetAdded),
            "AssetFeeCapChanged" => Some(Self::AssetFeeCapChanged),
            "SourceDailyLimitChanged" => Some(Self::SourceDailyLimitChanged),
            "MinimumAmountChanged" => Some(Self::MinimumAmountChanged),
            "MaxWithdrawPerTxChanged" => Some(Self::MaxWithdrawPerTxChanged),
            "MaxPersistentTtlChanged" => Some(Self::MaxPersistentTtlChanged),
            "AddressBlocklisted" => Some(Self::AddressBlocklisted),
            "AddressUnblocklisted" => Some(Self::AddressUnblocklisted),
            "AddressAllowlisted" => Some(Self::AddressAllowlisted),
            "AddressUnallowlisted" => Some(Self::AddressUnallowlisted),
            "AllowlistModeChanged" => Some(Self::AllowlistModeChanged),
            "Initialized" => Some(Self::Initialized),
            "UpgradeScheduled" => Some(Self::UpgradeScheduled),
            "UpgradeCancelled" => Some(Self::UpgradeCancelled),
            "ContractUpgraded" => Some(Self::ContractUpgraded),
            "EmergencyMigrated" => Some(Self::EmergencyMigrated),
            "ReferralRateChanged" => Some(Self::ReferralRateChanged),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Self::CAddressFunded => "CAddressFunded",
            Self::FeesWithdrawn => "FeesWithdrawn",
            Self::AdminChanged => "AdminChanged",
            Self::FeeCollectorChanged => "FeeCollectorChanged",
            Self::FeeBpsChanged => "FeeBpsChanged",
            Self::ContractPaused => "ContractPaused",
            Self::ContractUnpaused => "ContractUnpaused",
            Self::EmergencyWithdrawal => "EmergencyWithdrawal",
            Self::BatchCompleted => "BatchCompleted",
            Self::CrossChainFunded => "CrossChainFunded",
            Self::TimelockCreated => "TimelockCreated",
            Self::TimelockClaimed => "TimelockClaimed",
            Self::AssetAdded => "AssetAdded",
            Self::AssetFeeCapChanged => "AssetFeeCapChanged",
            Self::SourceDailyLimitChanged => "SourceDailyLimitChanged",
            Self::MinimumAmountChanged => "MinimumAmountChanged",
            Self::MaxWithdrawPerTxChanged => "MaxWithdrawPerTxChanged",
            Self::MaxPersistentTtlChanged => "MaxPersistentTtlChanged",
            Self::AddressBlocklisted => "AddressBlocklisted",
            Self::AddressUnblocklisted => "AddressUnblocklisted",
            Self::AddressAllowlisted => "AddressAllowlisted",
            Self::AddressUnallowlisted => "AddressUnallowlisted",
            Self::AllowlistModeChanged => "AllowlistModeChanged",
            Self::Initialized => "Initialized",
            Self::UpgradeScheduled => "UpgradeScheduled",
            Self::UpgradeCancelled => "UpgradeCancelled",
            Self::ContractUpgraded => "ContractUpgraded",
            Self::EmergencyMigrated => "EmergencyMigrated",
            Self::ReferralRateChanged => "ReferralRateChanged",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // Issue 4 — BridgeEventType::from_topic
    // -----------------------------------------------------------------------

    /// Every documented topic string must resolve to the correct variant.
    #[test]
    fn test_from_topic_recognises_all_known_topics() {
        let cases: &[(&str, &str)] = &[
            ("CAddressFunded", "CAddressFunded"),
            ("FeesWithdrawn", "FeesWithdrawn"),
            ("AdminChanged", "AdminChanged"),
            ("FeeCollectorChanged", "FeeCollectorChanged"),
            ("FeeBpsChanged", "FeeBpsChanged"),
            ("ContractPaused", "ContractPaused"),
            ("ContractUnpaused", "ContractUnpaused"),
            ("TokensReclaimed", "EmergencyWithdrawal"),
            ("BatchCompleted", "BatchCompleted"),
            ("CrossChainFunded", "CrossChainFunded"),
            ("TimelockCreated", "TimelockCreated"),
            ("TimelockClaimed", "TimelockClaimed"),
            ("AssetAdded", "AssetAdded"),
            ("AssetFeeCapChanged", "AssetFeeCapChanged"),
            ("SourceDailyLimitChanged", "SourceDailyLimitChanged"),
            ("MinimumAmountChanged", "MinimumAmountChanged"),
            ("MaxWithdrawPerTxChanged", "MaxWithdrawPerTxChanged"),
            ("MaxPersistentTtlChanged", "MaxPersistentTtlChanged"),
            ("AddressBlocklisted", "AddressBlocklisted"),
            ("AddressUnblocklisted", "AddressUnblocklisted"),
            ("AddressAllowlisted", "AddressAllowlisted"),
            ("AddressUnallowlisted", "AddressUnallowlisted"),
            ("AllowlistModeChanged", "AllowlistModeChanged"),
            ("Initialized", "Initialized"),
            ("UpgradeScheduled", "UpgradeScheduled"),
            ("UpgradeCancelled", "UpgradeCancelled"),
            ("ContractUpgraded", "ContractUpgraded"),
            ("EmergencyMigrated", "EmergencyMigrated"),
            ("ReferralRateChanged", "ReferralRateChanged"),
        ];

        for (topic, expected_str) in cases {
            let variant = BridgeEventType::from_topic(topic)
                .unwrap_or_else(|| panic!("from_topic must recognise '{topic}'"));
            assert_eq!(
                variant.as_str(),
                *expected_str,
                "as_str() mismatch for topic '{topic}'"
            );
        }
    }

    /// The four funding paths added for #642 must all resolve.
    #[test]
    fn test_from_topic_recognises_funding_path_topics() {
        let cases: &[(&str, &str)] = &[
            ("CommitFund", "CommitFund"),
            ("CommitRevealFunded", "CommitRevealFunded"),
            ("SwapAndFunded", "SwapAndFunded"),
            ("MetaFundExecuted", "MetaFundExecuted"),
            ("ReferralPaid", "ReferralPaid"),
            ("BatchTransferFailed", "BatchTransferFailed"),
        ];
        for (topic, expected_str) in cases {
            let variant = BridgeEventType::from_topic(topic)
                .unwrap_or_else(|| panic!("from_topic must recognise '{topic}'"));
            assert_eq!(
                variant.as_str(),
                *expected_str,
                "as_str() mismatch for topic '{topic}'"
            );
        }
    }

    // -----------------------------------------------------------------------
    // Issue #648 — clamp_limit / clamp_offset
    // -----------------------------------------------------------------------

    #[test]
    fn test_clamp_limit_rejects_negative_by_clamping_to_one() {
        // A negative LIMIT means "no limit" in SQLite -- clamp it up, not
        // pass it through, or `?limit=-1` dumps the whole table.
        assert_eq!(clamp_limit(Some(-1), 50), 1);
        assert_eq!(clamp_limit(Some(-1_000_000), 50), 1);
    }

    #[test]
    fn test_clamp_limit_caps_oversized_values() {
        assert_eq!(clamp_limit(Some(1_000_000), 50), MAX_PAGE_LIMIT);
        assert_eq!(clamp_limit(Some(MAX_PAGE_LIMIT + 1), 50), MAX_PAGE_LIMIT);
    }

    #[test]
    fn test_clamp_limit_passes_through_in_range_values() {
        assert_eq!(clamp_limit(Some(10), 50), 10);
        assert_eq!(clamp_limit(Some(MAX_PAGE_LIMIT), 50), MAX_PAGE_LIMIT);
    }

    #[test]
    fn test_clamp_limit_uses_default_when_absent() {
        assert_eq!(clamp_limit(None, 50), 50);
    }

    #[test]
    fn test_clamp_limit_clamps_zero_to_one() {
        assert_eq!(clamp_limit(Some(0), 50), 1);
    }

    #[test]
    fn test_clamp_offset_rejects_negative() {
        assert_eq!(clamp_offset(Some(-5)), 0);
    }

    #[test]
    fn test_clamp_offset_passes_through_non_negative() {
        assert_eq!(clamp_offset(Some(20)), 20);
        assert_eq!(clamp_offset(None), 0);
    }

    /// An unknown topic string must return None (no panic, no default).
    #[test]
    fn test_from_topic_returns_none_for_unrecognised_topic() {
        assert!(
            BridgeEventType::from_topic("UnknownEventXYZ").is_none(),
            "unknown topic must yield None"
        );
    }

    /// An empty string must return None.
    #[test]
    fn test_from_topic_returns_none_for_empty_string() {
        assert!(
            BridgeEventType::from_topic("").is_none(),
            "empty topic string must yield None"
        );
    }

    /// Topic matching is case-sensitive (contract emits exact casing).
    #[test]
    fn test_from_topic_is_case_sensitive() {
        assert!(
            BridgeEventType::from_topic("caddressfunded").is_none(),
            "lower-case variant of a known topic must yield None"
        );
        assert!(
            BridgeEventType::from_topic("CADDRESSFUNDED").is_none(),
            "upper-case variant of a known topic must yield None"
        );
    }
}
