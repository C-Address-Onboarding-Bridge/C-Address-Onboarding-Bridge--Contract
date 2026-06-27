use crate::events::{BridgeEventType, IndexedEvent};
use crate::AppState;
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

    for raw_event in &events {
        let ledger = raw_event
            .get("ledger")
            .and_then(|l| l.as_i64())
            .unwrap_or(0);
        if ledger > max_ledger {
            max_ledger = ledger;
        }

        if let Some(indexed) = parse_contract_event(raw_event, &state.contract_id) {
            state.db.insert_event(&indexed).await?;
            state.db.queue_webhook_deliveries(&indexed).await?;
            tracing::info!(
                "Indexed event: {} at ledger {}",
                indexed.event_type,
                indexed.ledger_sequence
            );
        }
    }

    state.db.set_last_ledger(max_ledger).await?;
    tracing::debug!("Poller advanced to ledger {}", max_ledger);

    Ok(())
}

fn parse_contract_event(
    raw: &serde_json::Value,
    contract_id: &str,
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

    let id = format!(
        "{}-{}-{}",
        ledger,
        tx_hash.get(..8).unwrap_or("unknown"),
        uuid::Uuid::new_v4().to_string().get(..8).unwrap_or("rand")
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
