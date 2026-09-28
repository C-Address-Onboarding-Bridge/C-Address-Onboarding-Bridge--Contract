use crate::events::{BridgeEventType, IndexedEvent};
use crate::AppState;
use base64::Engine;
use std::collections::HashMap;
use std::sync::Arc;

const POLL_INTERVAL_MS: u64 = 5000;
const MAX_EVENTS_PER_POLL: usize = 100;
/// Default number of ledgers to look back on first run when no persisted
/// `last_ledger` exists.  Real Soroban RPC servers enforce a retention window
/// (typically 17280 ledgers ≈ 24 hours on mainnet); requesting from ledger 0
/// would be rejected.  This default is conservative (≈ 1 hour of ledgers at
/// ~5 s per ledger) and can be overridden via the `LOOKBACK_LEDGERS` env var.
pub const DEFAULT_LOOKBACK_LEDGERS: i64 = 720;

pub async fn run_poller(state: Arc<AppState>) {
    tracing::info!("Starting event poller for contract {}", state.contract_id);

    loop {
        if let Err(e) = poll_once(&state).await {
            // #638: distinguish timeout errors so operators can tune RPC_REQUEST_TIMEOUT_SECS
            if e.to_string().contains("timed out") || e.to_string().contains("timeout") {
                tracing::warn!(
                    "Poller RPC timeout (configure via RPC_REQUEST_TIMEOUT_SECS / RPC_CONNECT_TIMEOUT_SECS): {}",
                    e
                );
            } else {
                tracing::error!("Poller error: {}", e);
            }
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
    }
}

/// Fetch the latest ledger sequence from the RPC using `getLatestLedger`.
async fn fetch_latest_ledger(state: &AppState) -> Result<i64, Box<dyn std::error::Error>> {
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "getLatestLedger",
        "params": []
    });

    let response = state
        .rpc_client
        .post(&state.rpc_url)
        .json(&request)
        .send()
        .await?;

    let body: serde_json::Value = response.json().await?;

    let seq = body
        .get("result")
        .and_then(|r| r.get("sequence"))
        .and_then(|s| s.as_i64())
        .ok_or("getLatestLedger: missing result.sequence")?;

    Ok(seq)
}

async fn poll_once(state: &AppState) -> Result<(), Box<dyn std::error::Error>> {
    let start_ledger = match state.db.get_last_ledger().await? {
        Some(last) => last + 1,
        None => {
            // First run — no persisted cursor.  Requesting from ledger 0 would
            // be rejected by any real (non-quickstart) Soroban RPC endpoint
            // because it falls outside the node's retention window.
            // Instead, fetch the current tip and subtract a configurable
            // lookback so operators get recent events immediately without
            // having to pre-seed the database.
            let latest = fetch_latest_ledger(state).await?;
            let lookback = state.lookback_ledgers;
            let fallback = (latest - lookback).max(0);
            tracing::info!(
                "No persisted ledger cursor — starting from ledger {} \
                 (latest={} minus lookback={}). \
                 Set LOOKBACK_LEDGERS=0 to start from the current tip, \
                 or use POST /api/replay to backfill older history.",
                fallback,
                latest,
                lookback,
            );
            fallback
        }
    };

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
        .rpc_client
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
/// `event_index` is the position of this event within its transaction.
///
/// TODO(next-bounty): it is accepted but not yet used. The intent was to fold it
/// into the event id so two events in the same transaction cannot collide; that
/// was never written, so the parameter is currently inert.
fn parse_contract_event(
    raw: &serde_json::Value,
    contract_id: &str,
    _event_index: usize,
) -> Option<IndexedEvent> {
    let topics = raw.get("topic")?.as_array()?;
    if topics.is_empty() {
        return None;
    }

    let decoded_topics: Vec<serde_json::Value> = topics
        .iter()
        .map(decode_rpc_scval)
        .collect();
    let first_topic = decoded_topics
        .first()
        .and_then(serde_json::Value::as_str)
        .unwrap_or("");
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
    data.insert(
        "topics".to_string(),
        serde_json::Value::Array(decoded_topics.clone()),
    );
    if let Some(value) = raw.get("value") {
        data.insert("value".to_string(), decode_rpc_scval(value));
    }

    // Map topic positions per event type, based on the contract's actual publish calls.
    //
    // #639: CAddressFunded is published as ("CAddressFunded", asset, source, target)
    //       so topics[1]=asset, topics[2]=source, topics[3]=target.
    //       The old generic mapping wrote topics[1]->source and topics[2]->target,
    //       which stored the asset address in "source" and the real source in "target".
    //
    // #640: "asset" was never written into data, so asset_filter could never match.
    //       We now populate it for every event type that carries an asset topic.
    match event_type {
        BridgeEventType::CAddressFunded => {
            if let Some(asset) = decoded_topics.get(1).and_then(|t| t.as_str()) {
                data.insert("asset".to_string(), serde_json::Value::String(asset.to_string()));
            }
            if let Some(source) = decoded_topics.get(2).and_then(|t| t.as_str()) {
                data.insert("source".to_string(), serde_json::Value::String(source.to_string()));
            }
            if let Some(target) = decoded_topics.get(3).and_then(|t| t.as_str()) {
                data.insert("target".to_string(), serde_json::Value::String(target.to_string()));
            }
        }
        // ("BatchCompleted", source) — no asset in topics
        BridgeEventType::BatchCompleted => {
            if let Some(source) = decoded_topics.get(1).and_then(|t| t.as_str()) {
                data.insert("source".to_string(), serde_json::Value::String(source.to_string()));
            }
        }
        // ("FeesWithdrawn", fee_collector) — asset carried in value, not topics
        BridgeEventType::FeesWithdrawn => {
            if let Some(collector) = decoded_topics.get(1).and_then(|t| t.as_str()) {
                data.insert("fee_collector".to_string(), serde_json::Value::String(collector.to_string()));
            }
        }
        // ("AdminProposed", admin, new_admin) / ("AdminTransferred", old_admin, pending)
        BridgeEventType::AdminProposed | BridgeEventType::AdminTransferred => {
            if let Some(from) = decoded_topics.get(1).and_then(|t| t.as_str()) {
                data.insert("from".to_string(), serde_json::Value::String(from.to_string()));
            }
            if let Some(to) = decoded_topics.get(2).and_then(|t| t.as_str()) {
                data.insert("to".to_string(), serde_json::Value::String(to.to_string()));
            }
        }
        // ("FeeCollectorTransferProposed", admin, new_collector) / ("FeeCollectorTransferred", old, pending)
        BridgeEventType::FeeCollectorTransferProposed | BridgeEventType::FeeCollectorTransferred => {
            if let Some(from) = decoded_topics.get(1).and_then(|t| t.as_str()) {
                data.insert("from".to_string(), serde_json::Value::String(from.to_string()));
            }
            if let Some(to) = decoded_topics.get(2).and_then(|t| t.as_str()) {
                data.insert("to".to_string(), serde_json::Value::String(to.to_string()));
            }
        }
        // All other event types: no well-known topic fields beyond the event name.
        _ => {}
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

/// Decode the base64 XDR representation returned by Soroban RPC. Older test
/// fixtures use already-decoded JSON strings, so those values are preserved.
fn decode_rpc_scval(value: &serde_json::Value) -> serde_json::Value {
    let Some(encoded) = value.as_str() else {
        return value.clone();
    };
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(encoded) else {
        return value.clone();
    };
    decode_scval(&bytes).unwrap_or_else(|_| value.clone())
}

fn decode_scval(bytes: &[u8]) -> Result<serde_json::Value, &'static str> {
    if bytes.len() < 4 {
        return Err("missing ScVal type");
    }
    let kind = u32::from_be_bytes(bytes[0..4].try_into().map_err(|_| "invalid type")?);
    let mut cursor = 4;
    match kind {
        0 => Ok(serde_json::Value::Bool(read_u32(bytes, &mut cursor)? != 0)),
        1 => Ok(serde_json::Value::Null),
        3 => Ok(serde_json::Value::Number(
            read_u32(bytes, &mut cursor)?.into(),
        )),
        4 => Ok(serde_json::Value::Number(
            (read_u32(bytes, &mut cursor)? as i32).into(),
        )),
        5 | 7 | 8 => {
            let number = read_u64(bytes, &mut cursor)?;
            Ok(serde_json::Value::Number(number.into()))
        }
        6 => Ok(serde_json::Value::Number(
            (read_u64(bytes, &mut cursor)? as i64).into(),
        )),
        13 | 14 | 15 => {
            let raw = read_opaque(bytes, &mut cursor)?;
            if kind == 15 || kind == 14 {
                Ok(serde_json::Value::String(
                    String::from_utf8(raw).map_err(|_| "invalid ScVal text")?,
                ))
            } else {
                Ok(serde_json::Value::String(format!("0x{}", hex::encode(raw))))
            }
        }
        18 => {
            let address_kind = read_u32(bytes, &mut cursor)?;
            let address = read_bytes(bytes, &mut cursor, 32)?;
            Ok(serde_json::Value::String(format!(
                "scaddress:{}:{}",
                address_kind,
                hex::encode(address)
            )))
        }
        _ => Err("unsupported ScVal type"),
    }
}

fn read_u32(bytes: &[u8], cursor: &mut usize) -> Result<u32, &'static str> {
    let end = cursor.checked_add(4).ok_or("cursor overflow")?;
    let value = u32::from_be_bytes(bytes.get(*cursor..end).ok_or("truncated u32")?.try_into().map_err(|_| "invalid u32")?);
    *cursor = end;
    Ok(value)
}

fn read_u64(bytes: &[u8], cursor: &mut usize) -> Result<u64, &'static str> {
    let end = cursor.checked_add(8).ok_or("cursor overflow")?;
    let value = u64::from_be_bytes(bytes.get(*cursor..end).ok_or("truncated u64")?.try_into().map_err(|_| "invalid u64")?);
    *cursor = end;
    Ok(value)
}

fn read_bytes<'a>(
    bytes: &'a [u8],
    cursor: &mut usize,
    length: usize,
) -> Result<&'a [u8], &'static str> {
    let end = cursor.checked_add(length).ok_or("cursor overflow")?;
    let value = bytes.get(*cursor..end).ok_or("truncated bytes")?;
    *cursor = end;
    Ok(value)
}

fn read_opaque(bytes: &[u8], cursor: &mut usize) -> Result<Vec<u8>, &'static str> {
    let length = read_u32(bytes, cursor)? as usize;
    let value = read_bytes(bytes, cursor, length)?.to_vec();
    let padding = (4 - (length % 4)) % 4;
    read_bytes(bytes, cursor, padding)?;
    Ok(value)
}

/// Public-for-tests re-export of `parse_contract_event` so that `db.rs` tests
/// and external test modules can call it without making the private function
/// `pub` in the production API surface.
#[cfg(test)]
pub(crate) fn parse_contract_event_for_test(
    raw: &serde_json::Value,
    contract_id: &str,
) -> Option<IndexedEvent> {
    parse_contract_event(raw, contract_id, 0)
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
            parse_contract_event(&raw, "CONTRACT_A", 0).is_none(),
            "empty topics must yield None"
        );
    }

    /// A first topic that is not a known bridge event name must return None.
    #[test]
    fn test_parse_returns_none_for_unrecognized_topic() {
        let raw = raw_event(serde_json::json!(["UnknownEventXYZ"]));
        assert!(
            parse_contract_event(&raw, "CONTRACT_A", 0).is_none(),
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
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(event.ledger_sequence, 0, "missing ledger must default to 0");
    }

    /// Missing `txHash` field defaults to empty string without panicking.
    #[test]
    fn test_parse_defaults_tx_hash_to_empty_when_missing() {
        let raw = serde_json::json!({
            "topic": ["CAddressFunded"],
            "ledger": 5
        });
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(
            event.tx_hash, "",
            "missing txHash must default to empty string"
        );
    }

    /// Missing `createdAt` field must not panic; a fallback timestamp is used.
    #[test]
    fn test_parse_uses_fallback_timestamp_when_created_at_missing() {
        let raw = serde_json::json!({
            "topic": ["FeesWithdrawn"],
            "ledger": 99,
            "txHash": "1234"
        });
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        // The fallback is chrono::Utc::now().to_rfc3339(); just assert it's non-empty.
        assert!(
            !event.timestamp.is_empty(),
            "fallback timestamp must be non-empty"
        );
    }

    /// topics[1] is extracted into `data["source"]`.
    #[test]
    fn test_parse_extracts_source_from_topics_index_1() {
        // NOTE: this test uses the OLD (pre-#639) assumed layout and is kept
        // only to document the former behaviour.  The corrected layout is
        // tested by test_c_address_funded_topic_mapping below.
        let raw = raw_event(serde_json::json!([
            "CAddressFunded",
            "GASSETADDR",
            "GSOURCEADDR",
            "CTARGETADDR"
        ]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        // asset is now at topics[1]
        assert_eq!(
            event.data["asset"].as_str(),
            Some("GASSETADDR"),
            "topics[1] must be stored as data.asset for CAddressFunded"
        );
        // source is now at topics[2]
        assert_eq!(
            event.data["source"].as_str(),
            Some("GSOURCEADDR"),
            "topics[2] must be stored as data.source for CAddressFunded"
        );
    }

    /// topics[2] is extracted into `data["target"]`.
    #[test]
    fn test_parse_extracts_target_from_topics_index_2() {
        let raw = raw_event(serde_json::json!(["CAddressFunded", "GASSET", "GSOURCE", "CTARGET"]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(
            event.data["target"].as_str(),
            Some("CTARGET"),
            "topics[3] must be stored as data.target for CAddressFunded"
        );
    }

    /// #639: CAddressFunded topic layout is ("CAddressFunded", asset, source, target).
    /// Verify all three fields land in the correct data keys.
    #[test]
    fn test_c_address_funded_topic_mapping() {
        let raw = raw_event(serde_json::json!([
            "CAddressFunded",
            "CASSETCONTRACT",
            "GSOURCEADDR",
            "CTARGETADDR"
        ]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(
            event.data["asset"].as_str(),
            Some("CASSETCONTRACT"),
            "topics[1] must be the asset contract address"
        );
        assert_eq!(
            event.data["source"].as_str(),
            Some("GSOURCEADDR"),
            "topics[2] must be the source G-address"
        );
        assert_eq!(
            event.data["target"].as_str(),
            Some("CTARGETADDR"),
            "topics[3] must be the target C-address"
        );
    }

    /// #640: asset_filter requires data["asset"] to be present.
    /// Confirm parse_contract_event populates it for CAddressFunded.
    #[test]
    fn test_c_address_funded_populates_asset_field() {
        let raw = raw_event(serde_json::json!([
            "CAddressFunded",
            "CASSET",
            "GSRC",
            "CTGT"
        ]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert!(
            event.data.get("asset").is_some(),
            "data['asset'] must be present for CAddressFunded so asset_filter can match"
        );
    }

    /// #639/#640: FeesWithdrawn layout is ("FeesWithdrawn", fee_collector).
    /// No asset in topics — verify fee_collector is stored correctly.
    #[test]
    fn test_fees_withdrawn_topic_mapping() {
        let raw = raw_event(serde_json::json!(["FeesWithdrawn", "GCOLLECTOR"]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(
            event.data["fee_collector"].as_str(),
            Some("GCOLLECTOR"),
            "topics[1] must be stored as data.fee_collector for FeesWithdrawn"
        );
        assert!(
            event.data.get("asset").is_none(),
            "FeesWithdrawn has no asset topic — data['asset'] must be absent"
        );
    }

    /// #641: AdminProposed layout is ("AdminProposed", admin, new_admin).
    #[test]
    fn test_admin_proposed_topic_mapping() {
        let raw = raw_event(serde_json::json!(["AdminProposed", "GADMIN", "GNEWADMIN"]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(event.data["from"].as_str(), Some("GADMIN"));
        assert_eq!(event.data["to"].as_str(), Some("GNEWADMIN"));
    }

    /// #641: AdminTransferred layout is ("AdminTransferred", old_admin, pending).
    #[test]
    fn test_admin_transferred_topic_mapping() {
        let raw = raw_event(serde_json::json!(["AdminTransferred", "GOLDADMIN", "GNEWADMIN"]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(event.data["from"].as_str(), Some("GOLDADMIN"));
        assert_eq!(event.data["to"].as_str(), Some("GNEWADMIN"));
    }

    /// #641: FeeCollectorTransferProposed and FeeCollectorTransferred are now recognised.
    #[test]
    fn test_fee_collector_role_change_topics_are_recognised() {
        let proposed = raw_event(serde_json::json!([
            "FeeCollectorTransferProposed",
            "GADMIN",
            "GNEWCOLLECTOR"
        ]));
        let transferred = raw_event(serde_json::json!([
            "FeeCollectorTransferred",
            "GOLDCOLLECTOR",
            "GNEWCOLLECTOR"
        ]));
        assert!(
            parse_contract_event(&proposed, "C1", 0).is_some(),
            "FeeCollectorTransferProposed must be recognised"
        );
        assert!(
            parse_contract_event(&transferred, "C1", 0).is_some(),
            "FeeCollectorTransferred must be recognised"
        );
    }

    /// #641: The old incorrect topic strings AdminChanged / FeeCollectorChanged
    /// must NOT produce indexed events (contract never emits them).
    #[test]
    fn test_old_incorrect_role_change_topics_produce_no_event() {
        let raw_admin = raw_event(serde_json::json!(["AdminChanged", "GADMIN", "GNEWADMIN"]));
        let raw_fc = raw_event(serde_json::json!(["FeeCollectorChanged", "GCOL", "GNEWCOL"]));
        assert!(
            parse_contract_event(&raw_admin, "C1", 0).is_none(),
            "'AdminChanged' must yield None — contract never emits this"
        );
        assert!(
            parse_contract_event(&raw_fc, "C1", 0).is_none(),
            "'FeeCollectorChanged' must yield None — contract never emits this"
        );
    }

    #[test]
    fn test_parse_decodes_rpc_scval_topics_and_value() {
        // #639: CAddressFunded is ("CAddressFunded", asset, source, target) — 4 topics.
        // Base64-encoded XDR ScSymbol values for each field:
        //   "CAddressFunded" -> AAAADwAAAA5DQWRkcmVzc0Z1bmRlZAAA
        //   "CASSETADDR"     -> AAAADwAAAApDQVNTRVRBRERSAAA=
        //   "GSOURCEADDR"    -> AAAADwAAAAtHU09VUkNFQUREUgA=
        //   "CTARGETADDR"    -> AAAADwAAAAtDVEFSR0VUQUREUgA=
        let raw = serde_json::json!({
            "topic": [
                "AAAADwAAAA5DQWRkcmVzc0Z1bmRlZAAA",
                "AAAADwAAAApDQVNTRVRBRERSAAA=",
                "AAAADwAAAAtHU09VUkNFQUREUgA=",
                "AAAADwAAAAtDVEFSR0VUQUREUgA="
            ],
            "ledger": 10,
            "txHash": "cafebabe00000000",
            "createdAt": "2024-06-01T12:00:00Z",
            "value": "AAAAAwAAACo="
        });
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(event.event_type, "CAddressFunded");
        assert_eq!(event.data["asset"].as_str(), Some("CASSETADDR"));
        assert_eq!(event.data["source"].as_str(), Some("GSOURCEADDR"));
        assert_eq!(event.data["target"].as_str(), Some("CTARGETADDR"));
        assert_eq!(event.data["value"], serde_json::json!(42));
    }

    /// When only one topic is present, `data["source"]` and `data["target"]`
    /// must be absent (no index-out-of-bounds or spurious entries).
    #[test]
    fn test_parse_no_source_target_when_only_one_topic() {
        let raw = raw_event(serde_json::json!(["FeesWithdrawn"]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
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
        let id1 = parse_contract_event(&raw, "C1", 0).unwrap().id;
        let id2 = parse_contract_event(&raw, "C1", 0).unwrap().id;
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
        let id1 = parse_contract_event(&raw1, "C1", 0).unwrap().id;
        let id2 = parse_contract_event(&raw2, "C1", 0).unwrap().id;
        assert_ne!(id1, id2, "different tx_hash must produce different IDs");
    }
}
