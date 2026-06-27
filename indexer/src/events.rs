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
        }
    }
}
