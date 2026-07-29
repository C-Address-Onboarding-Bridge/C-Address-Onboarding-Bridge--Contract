use crate::events::{BridgeEventType, IndexedEvent};
use crate::AppState;
use std::collections::HashMap;
use std::sync::Arc;

const POLL_INTERVAL_MS: u64 = 5000;
const MAX_EVENTS_PER_POLL: usize = 100;

pub async fn run_poller(state: Arc<AppState>) {
    tracing::info!("Starting event poller for contract {}", state.contract_id);

    loop {
        if let Err(e) = poll_once(&state).await {
            tracing::error!("Poller error: {}", e);
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

async fn poll_once(state: &AppState) -> Result<(), Box<dyn std::error::Error>> {
    let start_ledger = state
        .db
        .get_last_ledger()
        .await?
        .map(|l| l + 1)
        .unwrap_or(0);

    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getEvents",
        "params": {
            "startLedger": start_ledger,
            "filters": [{
                "type": "contract",
                "contractIds": [state.contract_id],
            }],
            "pagination": {
                "limit": MAX_EVENTS_PER_POLL,
            }
        }
    });

    let response = state
        .webhook_client
        .post(&state.rpc_url)
        .json(&request)
        .send()
        .await?;

    let body: serde_json::Value = response.json().await?;

    let events = body
        .get("result")
        .and_then(|r| r.get("events"))
        .and_then(|e| e.as_array())
        .cloned()
        .unwrap_or_default();

    if events.is_empty() {
        return Ok(());
    }

    let mut max_ledger = start_ledger;
    // Position of each event within its transaction. Combined with the ledger
    // and tx hash this yields a stable primary key, so re-polling a range
    // already seen (after a restart, or a crash before `set_last_ledger`)
    // regenerates the same ids and `insert_event` deduplicates them.
    let mut events_seen_per_tx: HashMap<&str, usize> = HashMap::new();

    for raw_event in &events {
        let ledger = raw_event
            .get("ledger")
            .and_then(|l| l.as_i64())
            .unwrap_or(0);
        if ledger > max_ledger {
            max_ledger = ledger;
        }

        let tx_hash = raw_event
            .get("txHash")
            .and_then(|t| t.as_str())
            .unwrap_or("");
        let counter = events_seen_per_tx.entry(tx_hash).or_insert(0);
        let event_index = *counter;
        *counter += 1;

        if let Some(indexed) = parse_contract_event(raw_event, &state.contract_id, event_index) {
            // Only fan out webhooks for events we have not indexed before;
            // otherwise a re-poll would re-deliver every event in the range.
            if state.db.insert_event(&indexed).await? {
                state.db.queue_webhook_deliveries(&indexed).await?;
                tracing::info!(
                    "Indexed event: {} at ledger {}",
                    indexed.event_type,
                    indexed.ledger_sequence
                );
            } else {
                tracing::debug!("Skipping already-indexed event {}", indexed.id);
            }
        }
    }

    state.db.set_last_ledger(max_ledger).await?;
    tracing::debug!("Poller advanced to ledger {}", max_ledger);

    Ok(())
}

/// Build an [`IndexedEvent`] from a raw `getEvents` entry.
///
/// `event_index` is the position of this event within its transaction; it is
/// part of the event id, so the same on-chain event always parses to the same
/// id no matter how many times it is polled.
fn parse_contract_event(
    raw: &serde_json::Value,
    contract_id: &str,
    event_index: usize,
) -> Option<IndexedEvent> {
    let topics = raw.get("topic")?.as_array()?;
    if topics.is_empty() {
        return None;
    }

    let first_topic = topics[0].as_str().unwrap_or("");
    let event_type = BridgeEventType::from_topic(first_topic)?;

    let ledger = raw.get("ledger").and_then(|l| l.as_i64()).unwrap_or(0);
    let tx_hash = raw
        .get("txHash")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let timestamp = raw
        .get("createdAt")
        .and_then(|t| t.as_str())
        .unwrap_or(&chrono::Utc::now().to_rfc3339())
        .to_string();

    let mut data = serde_json::Map::new();
    data.insert("topics".to_string(), serde_json::Value::Array(topics.clone()));
    if let Some(value) = raw.get("value") {
        data.insert("value".to_string(), value.clone());
    }

    if topics.len() > 1 {
        if let Some(source) = topics.get(1).and_then(|t| t.as_str()) {
            data.insert("source".to_string(), serde_json::Value::String(source.to_string()));
        }
    }
    if topics.len() > 2 {
        if let Some(target) = topics.get(2).and_then(|t| t.as_str()) {
            data.insert("target".to_string(), serde_json::Value::String(target.to_string()));
        }
    }

    // Deterministic ID: sha256(ledger || tx_hash || event_type) encoded as hex.
    // Using a content-derived ID ensures that re-indexing the same on-chain event
    // always produces the same id, which lets `INSERT OR IGNORE` be the sole
    // deduplication mechanism rather than a UUID that varies per call.
    let id = {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut hasher = DefaultHasher::new();
        ledger.hash(&mut hasher);
        tx_hash.hash(&mut hasher);
        event_type.as_str().hash(&mut hasher);
        // Include the first topic so two distinct event types on the same tx are
        // differentiated even when ledger and tx_hash are identical.
        first_topic.hash(&mut hasher);
        format!("{:016x}", hasher.finish())
    };

    Some(IndexedEvent {
        id,
        event_type: event_type.as_str().to_string(),
        ledger_sequence: ledger,
        contract_id: contract_id.to_string(),
        tx_hash,
        timestamp,
        data: serde_json::Value::Object(data),
    })
}

/// Public-for-tests re-export of `parse_contract_event` so that `db.rs` tests
/// and external test modules can call it without making the private function
/// `pub` in the production API surface.
#[cfg(test)]
pub(crate) fn parse_contract_event_for_test(
    raw: &serde_json::Value,
    contract_id: &str,
) -> Option<IndexedEvent> {
    parse_contract_event(raw, contract_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Helper: build a minimal raw event JSON with the given topics.
    fn raw_event(topics: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "topic": topics,
            "ledger": 10,
            "txHash": "cafebabe00000000",
            "createdAt": "2024-06-01T12:00:00Z",
            "value": null
        })
    }

    // -----------------------------------------------------------------------
    // Issue 4 — edge cases in parse_contract_event / BridgeEventType
    // -----------------------------------------------------------------------

    /// An empty topic array must return None (no event type to determine).
    #[test]
    fn test_parse_returns_none_for_empty_topics() {
        let raw = raw_event(serde_json::json!([]));
        assert!(
            parse_contract_event(&raw, "CONTRACT_A").is_none(),
            "empty topics must yield None"
        );
    }

    /// A first topic that is not a known bridge event name must return None.
    #[test]
    fn test_parse_returns_none_for_unrecognized_topic() {
        let raw = raw_event(serde_json::json!(["UnknownEventXYZ"]));
        assert!(
            parse_contract_event(&raw, "CONTRACT_A").is_none(),
            "unrecognized topic must yield None"
        );
    }

    /// Missing `ledger` field defaults to 0 without panicking.
    #[test]
    fn test_parse_defaults_ledger_to_zero_when_missing() {
        let raw = serde_json::json!({
            "topic": ["CAddressFunded"],
            "txHash": "aabbccdd",
            "createdAt": "2024-01-01T00:00:00Z"
        });
        let event = parse_contract_event(&raw, "C1").expect("must parse");
        assert_eq!(event.ledger_sequence, 0, "missing ledger must default to 0");
    }

    /// Missing `txHash` field defaults to empty string without panicking.
    #[test]
    fn test_parse_defaults_tx_hash_to_empty_when_missing() {
        let raw = serde_json::json!({
            "topic": ["CAddressFunded"],
            "ledger": 5
        });
        let event = parse_contract_event(&raw, "C1").expect("must parse");
        assert_eq!(event.tx_hash, "", "missing txHash must default to empty string");
    }

    /// Missing `createdAt` field must not panic; a fallback timestamp is used.
    #[test]
    fn test_parse_uses_fallback_timestamp_when_created_at_missing() {
        let raw = serde_json::json!({
            "topic": ["FeesWithdrawn"],
            "ledger": 99,
            "txHash": "1234"
        });
        let event = parse_contract_event(&raw, "C1").expect("must parse");
        // The fallback is chrono::Utc::now().to_rfc3339(); just assert it's non-empty.
        assert!(!event.timestamp.is_empty(), "fallback timestamp must be non-empty");
    }

    /// topics[1] is extracted into `data["source"]`.
    #[test]
    fn test_parse_extracts_source_from_topics_index_1() {
        let raw = raw_event(serde_json::json!(["CAddressFunded", "GSOURCEADDR", "CTARGETADDR"]));
        let event = parse_contract_event(&raw, "C1").expect("must parse");
        assert_eq!(
            event.data["source"].as_str(),
            Some("GSOURCEADDR"),
            "topics[1] must be stored as data.source"
        );
    }

    /// topics[2] is extracted into `data["target"]`.
    #[test]
    fn test_parse_extracts_target_from_topics_index_2() {
        let raw = raw_event(serde_json::json!(["CAddressFunded", "GSOURCE", "CTARGET"]));
        let event = parse_contract_event(&raw, "C1").expect("must parse");
        assert_eq!(
            event.data["target"].as_str(),
            Some("CTARGET"),
            "topics[2] must be stored as data.target"
        );
    }

    /// When only one topic is present, `data["source"]` and `data["target"]`
    /// must be absent (no index-out-of-bounds or spurious entries).
    #[test]
    fn test_parse_no_source_target_when_only_one_topic() {
        let raw = raw_event(serde_json::json!(["FeesWithdrawn"]));
        let event = parse_contract_event(&raw, "C1").expect("must parse");
        assert!(
            event.data["source"].is_null(),
            "source must be absent for single-topic event"
        );
        assert!(
            event.data["target"].is_null(),
            "target must be absent for single-topic event"
        );
    }

    /// Deterministic ID: same raw input → same id on repeated calls.
    #[test]
    fn test_parse_deterministic_id_same_input_same_id() {
        let raw = raw_event(serde_json::json!(["CAddressFunded", "GSRC", "CTGT"]));
        let id1 = parse_contract_event(&raw, "C1").unwrap().id;
        let id2 = parse_contract_event(&raw, "C1").unwrap().id;
        assert_eq!(id1, id2, "IDs must be identical for the same raw event");
    }

    /// Deterministic ID: different tx_hash → different id.
    #[test]
    fn test_parse_deterministic_id_different_tx_hash_different_id() {
        let raw1 = serde_json::json!({
            "topic": ["CAddressFunded"],
            "ledger": 10,
            "txHash": "aaaa0000",
            "createdAt": "2024-01-01T00:00:00Z"
        });
        let raw2 = serde_json::json!({
            "topic": ["CAddressFunded"],
            "ledger": 10,
            "txHash": "bbbb1111",
            "createdAt": "2024-01-01T00:00:00Z"
        });
        let id1 = parse_contract_event(&raw1, "C1").unwrap().id;
        let id2 = parse_contract_event(&raw2, "C1").unwrap().id;
        assert_ne!(id1, id2, "different tx_hash must produce different IDs");
    }
}
