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

    // Deterministic primary key: the same (ledger, tx, position) triple always
    // produces the same id, which is what makes `INSERT OR IGNORE` in
    // `Database::insert_event` an effective dedup on re-processing.
    let id = format!(
        "{}-{}-{}",
        ledger,
        if tx_hash.is_empty() {
            "unknown"
        } else {
            tx_hash.as_str()
        },
        event_index
    );

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

#[cfg(test)]
mod tests {
    use super::*;

    const CONTRACT_ID: &str = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

    fn raw_event() -> serde_json::Value {
        serde_json::json!({
            "ledger": 4242,
            "txHash": "9f1c0e6a4b2d8e7f00112233445566778899aabbccddeeff0011223344556677",
            "createdAt": "2026-07-29T10:00:00Z",
            "topic": ["CAddressFunded", "GSOURCE", "CTARGET"],
            "value": { "amount": "1000" },
        })
    }

    #[test]
    fn parsing_the_same_event_twice_yields_the_same_id() {
        let raw = raw_event();

        let first = parse_contract_event(&raw, CONTRACT_ID, 0).expect("event should parse");
        let second = parse_contract_event(&raw, CONTRACT_ID, 0).expect("event should parse");

        assert_eq!(first.id, second.id);
        assert_eq!(
            first.id,
            "4242-9f1c0e6a4b2d8e7f00112233445566778899aabbccddeeff0011223344556677-0"
        );
    }

    #[test]
    fn events_at_different_positions_in_a_tx_get_distinct_ids() {
        let raw = raw_event();

        let first = parse_contract_event(&raw, CONTRACT_ID, 0).expect("event should parse");
        let second = parse_contract_event(&raw, CONTRACT_ID, 1).expect("event should parse");

        assert_ne!(first.id, second.id);
    }

    #[test]
    fn a_missing_tx_hash_still_produces_a_deterministic_id() {
        let mut raw = raw_event();
        raw.as_object_mut().unwrap().remove("txHash");

        let first = parse_contract_event(&raw, CONTRACT_ID, 0).expect("event should parse");
        let second = parse_contract_event(&raw, CONTRACT_ID, 0).expect("event should parse");

        assert_eq!(first.id, second.id);
        assert_eq!(first.id, "4242-unknown-0");
    }
}
