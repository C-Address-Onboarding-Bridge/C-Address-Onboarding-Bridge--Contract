use crate::events::{BridgeEventType, IndexedEvent};
use crate::AppState;
use base64::Engine;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

const POLL_INTERVAL_MS: u64 = 5000;
const MAX_EVENTS_PER_POLL: usize = 100;
/// Default number of ledgers to look back on first run when no persisted
/// `last_ledger` exists.  Real Soroban RPC servers enforce a retention window
/// (typically 17280 ledgers ~= 24 hours on mainnet); requesting from ledger 0
/// would be rejected.  This default is conservative (~= 1 hour of ledgers at
/// ~5 s per ledger) and can be overridden via the `LOOKBACK_LEDGERS` env var.
pub const DEFAULT_LOOKBACK_LEDGERS: i64 = 720;

/// Runs the poll loop until `token` is cancelled. Cancellation is observed
/// between iterations (via `select!` on the inter-poll sleep) so an
/// in-flight `poll_once` always finishes cleanly before the worker returns.
/// See #646.
pub async fn run_poller(state: Arc<AppState>, token: CancellationToken) {
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

        tokio::select! {
            _ = tokio::time::sleep(tokio::time::Duration::from_millis(POLL_INTERVAL_MS)) => {}
            _ = token.cancelled() => {
                tracing::info!("Poller received shutdown signal, exiting");
                return;
            }
        }
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

    // #637 - surface JSON-RPC errors instead of silently treating them as
    // missing fields.
    if let Some(err) = body.get("error") {
        return Err(format!("getLatestLedger RPC error: {err}").into());
    }

    let seq = body
        .get("result")
        .and_then(|r| r.get("sequence"))
        .and_then(|s| s.as_i64())
        .ok_or("getLatestLedger: missing result.sequence")?;

    Ok(seq)
}

/// Send one `getEvents` request and persist every event it returns.
///
/// Pagination contract (`getEvents`):
/// - The first request uses `startLedger`; subsequent requests use the opaque
///   `cursor` from the previous response. `startLedger` and `cursor` are
///   mutually exclusive per the Soroban RPC spec, so the request body only
///   carries the one that applies.
/// - `result.events` holds the page. `result.cursor` points at the next page.
///   `result.latestLedger` is the RPC node's tip - used for logging.
/// - The ledger cursor is persisted **after** the whole page is stored, so a
///   crash mid-page causes the next poll to replay that page (safe: inserts
///   are `INSERT OR IGNORE`).
async fn resolve_start_ledger(state: &AppState) -> Result<i64, Box<dyn std::error::Error>> {
    match state.db.get_last_ledger().await? {
        Some(last) => Ok(last + 1),
        None => {
            // First run - no persisted cursor.  Requesting from ledger 0 would
            // be rejected by any real (non-quickstart) Soroban RPC endpoint
            // because it falls outside the node's retention window.
            // Instead, fetch the current tip and subtract a configurable
            // lookback so operators get recent events immediately without
            // having to pre-seed the database.
            let latest = fetch_latest_ledger(state).await?;
            let lookback = state.lookback_ledgers;
            let fallback = (latest - lookback).max(0);
            tracing::info!(
                "No persisted ledger cursor - starting from ledger {} \
                 (latest={} minus lookback={}). \
                 Set LOOKBACK_LEDGERS=0 to start from the current tip, \
                 or use POST /api/replay to backfill older history.",
                fallback,
                latest,
                lookback,
            );
            Ok(fallback)
        }
    }
}

async fn poll_once(state: &AppState) -> Result<(), Box<dyn std::error::Error>> {
    // #882 - Resume from the persisted RPC cursor (`last_cursor` in
    // `indexer_state`) when available, falling back to `startLedger` only on
    // first run or when the cursor has expired.
    let mut cursor: Option<String> = state.db.get_last_cursor().await?;
    let mut start_ledger = if cursor.is_some() {
        state.db.get_last_ledger().await?.map_or(0, |l| l + 1)
    } else {
        resolve_start_ledger(state).await?
    };

    // #635/#882 - page through all results using the RPC cursor so that more than
    // MAX_EVENTS_PER_POLL events in a single poll window are never silently
    // dropped.  We persist the ledger position and cursor after each page
    // completes so the next poll resumes exactly where we left off.
    let mut max_ledger = start_ledger;
    // #885 - Maintain per-transaction event counter across pages so multi-page transactions
    // do not reset their index counter.
    let mut events_seen_per_tx: HashMap<String, usize> = HashMap::new();

    loop {
        let params = match cursor {
            Some(ref c) => serde_json::json!({
                "filters": [{
                    "type": "contract",
                    "contractIds": [state.contract_id],
                }],
                "pagination": {
                    "cursor": c,
                    "limit": MAX_EVENTS_PER_POLL,
                },
            }),
            None => serde_json::json!({
                "startLedger": start_ledger,
                "filters": [{
                    "type": "contract",
                    "contractIds": [state.contract_id],
                }],
                "pagination": {
                    "limit": MAX_EVENTS_PER_POLL,
                },
            }),
        };

        let request = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getEvents",
            "params": params,
        });

        // #635/#850 - exactly one request per page (the pre-merge code sent it
        // twice and never parsed the body).
        let response = state
            .rpc_client
            .post(&state.rpc_url)
            .json(&request)
            .send()
            .await?;
        let body: serde_json::Value = response.json().await?;

        // #637 - surface JSON-RPC errors instead of treating them as no events.
        if let Some(err) = body.get("error") {
            let message = err.to_string();

            // #882 - when a persisted cursor has expired or fallen outside the
            // RPC retention window, clear `last_cursor` and fall back to
            // `startLedger`.
            if cursor.is_some()
                && (message.contains("cursor")
                    || message.contains("expired")
                    || message.contains("startLedger")
                    || message.contains("out of range")
                    || message.contains("beforeOldestLedger"))
            {
                tracing::warn!(
                    "Persisted RPC cursor {:?} expired or invalid ({}); falling back to startLedger.",
                    cursor,
                    message
                );
                state.db.clear_last_cursor().await?;
                cursor = None;
                start_ledger = resolve_start_ledger(state).await?;
                max_ledger = max_ledger.max(start_ledger);
                continue;
            }

            // #636 - recover to the latest ledger tip when the requested
            // start ledger is outside the RPC's retention window.  Only the
            // very first request (startLedger-based) can hit this; cursor
            // requests past page 1 don't reference a ledger.
            if cursor.is_none()
                && (message.contains("startLedger")
                    || message.contains("out of range")
                    || message.contains("beforeOldestLedger"))
            {
                tracing::warn!(
                    "Cursor ledger {} is outside RPC retention window ({}). \
                     Recovering to latest ledger tip.",
                    start_ledger,
                    message
                );
                let latest = fetch_latest_ledger(state).await?;
                state.db.set_last_ledger(latest).await?;
                return Ok(());
            }

            return Err(format!("getEvents RPC error: {message}").into());
        }

        let result = body.get("result").ok_or("getEvents: missing result")?;

        let events: Vec<serde_json::Value> = result
            .get("events")
            .and_then(|e| e.as_array())
            .cloned()
            .unwrap_or_default();

        let next_cursor: Option<String> = result
            .get("cursor")
            .and_then(|c| c.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);

        let latest_ledger_from_rpc = result
            .get("latestLedger")
            .and_then(|l| l.as_i64())
            .unwrap_or(0);

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
            let counter = events_seen_per_tx.entry(tx_hash.to_string()).or_insert(0);
            let event_index = *counter;
            *counter += 1;

            if let Some(indexed) = parse_contract_event(raw_event, &state.contract_id, event_index)
            {
                // Insert the event and queue its webhook deliveries atomically
                // (one SQLite transaction) so a crash between the two can never
                // leave an indexed event with no deliveries queued. See #647.
                if state.db.insert_event_and_queue_deliveries(&indexed).await? {
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

        // #850/#882 - persist the ledger position and RPC cursor only after the
        // whole page is stored.  Advancing past the page mid-loop would lose
        // events on a crash.  `INSERT OR IGNORE` makes the worst case (full
        // replay of the page after a crash) safe and idempotent.
        if !events.is_empty() || max_ledger > start_ledger {
            state.db.set_last_ledger(max_ledger).await?;
        }
        if let Some(ref c) = next_cursor {
            state.db.set_last_cursor(c).await?;
        }

        // #850 - break when the page wasn't full (no more events to page
        // through) or when the RPC didn't provide a cursor for the next page.
        if events.len() < MAX_EVENTS_PER_POLL {
            if max_ledger > start_ledger {
                tracing::debug!(
                    "Poller advanced to ledger {} (rpc latest={})",
                    max_ledger,
                    latest_ledger_from_rpc
                );
            }
            break;
        }

        match next_cursor {
            Some(c) => cursor = Some(c),
            None => {
                tracing::warn!(
                    "Full page of {} events but no cursor returned; stopping pagination",
                    events.len()
                );
                break;
            }
        }
    }

    Ok(())
}

/// Build an [`IndexedEvent`] from a raw `getEvents` entry.
///
/// `event_index` is the position of this event within its transaction and is
/// folded into the SHA-256 id so two events in the same transaction cannot
/// produce the same id.
fn parse_contract_event(
    raw: &serde_json::Value,
    contract_id: &str,
    event_index: usize,
) -> Option<IndexedEvent> {
    let topics = raw.get("topic")?.as_array()?;
    if topics.is_empty() {
        return None;
    }

    let decoded_topics: Vec<serde_json::Value> = topics.iter().map(decode_rpc_scval).collect();
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

    // Topic position of the asset/source/target/referrer party fields varies
    // by event: most events publish (name, source, target), but funding
    // paths sometimes interleave an asset (or two, for swaps) before the
    // parties. Map each event type to its actual topic layout so `data` gets
    // correctly labelled fields instead of a generic, sometimes-wrong
    // source/target. See #642 / #850.
    //
    // Layouts (as published by the contract, and exercised by this module's
    // tests):
    //   SwapAndFunded              -> (source_asset, target_asset, source, target)
    //   CAddressFunded             -> (asset, source, target)
    //   CommitRevealFunded         -> (asset, source, target)
    //   MetaFundExecuted           -> (asset, source, target)
    //   ReferralPaid               -> (source, referrer)
    //   FeesWithdrawn              -> (fee_collector)
    //   AdminProposed/Transferred  -> (from, to)
    //   FeeCollector*Proposed/...  -> (from, to)
    //   CommitFund / BatchTransferFailed / remaining admin/config events
    //                              -> (source, target)
    match &event_type {
        BridgeEventType::SwapAndFunded => {
            insert_topic_str(&mut data, &decoded_topics, 1, "source_asset");
            insert_topic_str(&mut data, &decoded_topics, 2, "target_asset");
            insert_topic_str(&mut data, &decoded_topics, 3, "source");
            insert_topic_str(&mut data, &decoded_topics, 4, "target");
        }
        BridgeEventType::CAddressFunded
        | BridgeEventType::CommitRevealFunded
        | BridgeEventType::MetaFundExecuted => {
            insert_topic_str(&mut data, &decoded_topics, 1, "asset");
            insert_topic_str(&mut data, &decoded_topics, 2, "source");
            insert_topic_str(&mut data, &decoded_topics, 3, "target");
        }
        BridgeEventType::ReferralPaid => {
            insert_topic_str(&mut data, &decoded_topics, 1, "source");
            insert_topic_str(&mut data, &decoded_topics, 2, "referrer");
        }
        // ("FeesWithdrawn", fee_collector) - asset carried in value, not topics
        BridgeEventType::FeesWithdrawn => {
            if let Some(collector) = decoded_topics.get(1).and_then(|t| t.as_str()) {
                data.insert(
                    "fee_collector".to_string(),
                    serde_json::Value::String(collector.to_string()),
                );
            }
        }
        // ("AdminProposed", admin, new_admin) / ("AdminTransferred", old_admin, pending)
        BridgeEventType::AdminProposed | BridgeEventType::AdminTransferred => {
            if let Some(from) = decoded_topics.get(1).and_then(|t| t.as_str()) {
                data.insert(
                    "from".to_string(),
                    serde_json::Value::String(from.to_string()),
                );
            }
            if let Some(to) = decoded_topics.get(2).and_then(|t| t.as_str()) {
                data.insert("to".to_string(), serde_json::Value::String(to.to_string()));
            }
        }
        // ("FeeCollectorTransferProposed", admin, new_collector) /
        // ("FeeCollectorTransferred", old, pending)
        BridgeEventType::FeeCollectorTransferProposed
        | BridgeEventType::FeeCollectorTransferred => {
            if let Some(from) = decoded_topics.get(1).and_then(|t| t.as_str()) {
                data.insert(
                    "from".to_string(),
                    serde_json::Value::String(from.to_string()),
                );
            }
            if let Some(to) = decoded_topics.get(2).and_then(|t| t.as_str()) {
                data.insert("to".to_string(), serde_json::Value::String(to.to_string()));
            }
        }
        _ => {
            // CommitFund, BatchTransferFailed, and the remaining admin/config
            // events all publish (name, source, target).
            insert_topic_str(&mut data, &decoded_topics, 1, "source");
            insert_topic_str(&mut data, &decoded_topics, 2, "target");
        }
    }

    // #885 - Deterministic ID: when the RPC event `id` is present, hash it with
    // SHA-256 to produce a globally unique, stable 64-char hex id (<toid>-<event index>).
    // This prevents ID collisions across pagination boundaries when a single transaction
    // emits many events across multiple pages.
    //
    // Fallback: If `raw.get("id")` is absent (such as in legacy test fixtures),
    // fall back to sha256(ledger || tx_hash || event_type || first_topic || event_index).
    let id = if let Some(rpc_id) = raw
        .get("id")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let mut hasher = Sha256::new();
        hasher.update(rpc_id.as_bytes());
        hex::encode(hasher.finalize())
    } else {
        let mut hasher = Sha256::new();
        hasher.update(ledger.to_le_bytes());
        hasher.update(tx_hash.as_bytes());
        hasher.update(event_type.as_str().as_bytes());
        hasher.update(first_topic.as_bytes());
        hasher.update(event_index.to_le_bytes());
        hex::encode(hasher.finalize())
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

/// Insert `topics[idx]` into `data[key]` as a string, if present. Used to
/// label the asset/source/target/referrer fields at their event-specific
/// topic position (see the `match event_type` above).
fn insert_topic_str(
    data: &mut serde_json::Map<String, serde_json::Value>,
    topics: &[serde_json::Value],
    idx: usize,
    key: &str,
) {
    if let Some(value) = topics.get(idx).and_then(serde_json::Value::as_str) {
        data.insert(
            key.to_string(),
            serde_json::Value::String(value.to_string()),
        );
    }
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
        13..=15 => {
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
    let value = u32::from_be_bytes(
        bytes
            .get(*cursor..end)
            .ok_or("truncated u32")?
            .try_into()
            .map_err(|_| "invalid u32")?,
    );
    *cursor = end;
    Ok(value)
}

fn read_u64(bytes: &[u8], cursor: &mut usize) -> Result<u64, &'static str> {
    let end = cursor.checked_add(8).ok_or("cursor overflow")?;
    let value = u64::from_be_bytes(
        bytes
            .get(*cursor..end)
            .ok_or("truncated u64")?
            .try_into()
            .map_err(|_| "invalid u64")?,
    );
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
    // Issue 4 - edge cases in parse_contract_event / BridgeEventType
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

    /// #639/#850: CAddressFunded layout is ("CAddressFunded", asset, source, target).
    #[test]
    fn test_parse_extracts_source_from_topics_index_1() {
        // NOTE: this test previously documented the pre-#639 layout. The
        // corrected layout is (name, asset, source, target), so the fields
        // land at the positions asserted below.
        let raw = raw_event(serde_json::json!([
            "CAddressFunded",
            "GASSETADDR",
            "GSOURCEADDR",
            "CTARGETADDR"
        ]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        // asset is at topics[1]
        assert_eq!(
            event.data["asset"].as_str(),
            Some("GASSETADDR"),
            "topics[1] must be stored as data.asset for CAddressFunded"
        );
        // source is at topics[2]
        assert_eq!(
            event.data["source"].as_str(),
            Some("GSOURCEADDR"),
            "topics[2] must be stored as data.source for CAddressFunded"
        );
    }

    /// topics[3] is extracted into `data["target"]` for CAddressFunded.
    #[test]
    fn test_parse_extracts_target_from_topics_index_2() {
        let raw = raw_event(serde_json::json!([
            "CAddressFunded",
            "GASSET",
            "GSOURCE",
            "CTARGET"
        ]));
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
            "CASSETADDR",
            "GSOURCEADDR",
            "CTARGETADDR"
        ]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert!(
            event.data.get("asset").is_some(),
            "data['asset'] must be present for CAddressFunded so asset_filter can match"
        );
    }

    /// #639/#640: FeesWithdrawn layout is ("FeesWithdrawn", fee_collector).
    /// No asset in topics - verify fee_collector is stored correctly.
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
            "FeesWithdrawn has no asset topic - data['asset'] must be absent"
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
        let raw = raw_event(serde_json::json!([
            "AdminTransferred",
            "GOLDADMIN",
            "GNEWADMIN"
        ]));
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
        let raw_fc = raw_event(serde_json::json!([
            "FeeCollectorChanged",
            "GCOL",
            "GNEWCOL"
        ]));
        assert!(
            parse_contract_event(&raw_admin, "C1", 0).is_none(),
            "'AdminChanged' must yield None - contract never emits this"
        );
        assert!(
            parse_contract_event(&raw_fc, "C1", 0).is_none(),
            "'FeeCollectorChanged' must yield None - contract never emits this"
        );
    }

    #[test]
    fn test_parse_decodes_rpc_scval_topics_and_value() {
        // #639: CAddressFunded is ("CAddressFunded", asset, source, target) - 4 topics.
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

    /// Deterministic ID: same raw input -> same id on repeated calls.
    #[test]
    fn test_parse_deterministic_id_same_input_same_id() {
        let raw = raw_event(serde_json::json!(["CAddressFunded", "GSRC", "CTGT"]));
        let id1 = parse_contract_event(&raw, "C1", 0).unwrap().id;
        let id2 = parse_contract_event(&raw, "C1", 0).unwrap().id;
        assert_eq!(id1, id2, "IDs must be identical for the same raw event");
    }

    // -----------------------------------------------------------------------
    // Issue #642 - funding-path events (commit-reveal, swap, meta-tx, referral)
    // -----------------------------------------------------------------------

    /// `CommitFund` uses the generic (name, source, target) layout.
    #[test]
    fn test_parse_commit_fund_extracts_source_and_target() {
        let raw = raw_event(serde_json::json!(["CommitFund", "GSRC", "CTGT"]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(event.event_type, "CommitFund");
        assert_eq!(event.data["source"].as_str(), Some("GSRC"));
        assert_eq!(event.data["target"].as_str(), Some("CTGT"));
    }

    /// `CommitRevealFunded` publishes (name, asset, source, target) - the
    /// asset must not be mislabelled as the source.
    #[test]
    fn test_parse_commit_reveal_funded_extracts_asset_source_target() {
        let raw = raw_event(serde_json::json!([
            "CommitRevealFunded",
            "CASSET",
            "GSRC",
            "CTGT"
        ]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(event.event_type, "CommitRevealFunded");
        assert_eq!(event.data["asset"].as_str(), Some("CASSET"));
        assert_eq!(event.data["source"].as_str(), Some("GSRC"));
        assert_eq!(event.data["target"].as_str(), Some("CTGT"));
    }

    /// `MetaFundExecuted` shares the (name, asset, source, target) layout.
    #[test]
    fn test_parse_meta_fund_executed_extracts_asset_source_target() {
        let raw = raw_event(serde_json::json!([
            "MetaFundExecuted",
            "CASSET",
            "GSRC",
            "CTGT"
        ]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(event.event_type, "MetaFundExecuted");
        assert_eq!(event.data["asset"].as_str(), Some("CASSET"));
        assert_eq!(event.data["source"].as_str(), Some("GSRC"));
        assert_eq!(event.data["target"].as_str(), Some("CTGT"));
    }

    /// `SwapAndFunded` publishes (name, source_asset, target_asset, source,
    /// target) - five topics in total.
    #[test]
    fn test_parse_swap_and_funded_extracts_all_parties() {
        let raw = raw_event(serde_json::json!([
            "SwapAndFunded",
            "CSRCASSET",
            "CTGTASSET",
            "GSRC",
            "CTGT"
        ]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(event.event_type, "SwapAndFunded");
        assert_eq!(event.data["source_asset"].as_str(), Some("CSRCASSET"));
        assert_eq!(event.data["target_asset"].as_str(), Some("CTGTASSET"));
        assert_eq!(event.data["source"].as_str(), Some("GSRC"));
        assert_eq!(event.data["target"].as_str(), Some("CTGT"));
    }

    /// `ReferralPaid` publishes (name, source, referrer) - the second party
    /// is a referrer, not a funding target.
    #[test]
    fn test_parse_referral_paid_extracts_source_and_referrer() {
        let raw = raw_event(serde_json::json!(["ReferralPaid", "GSRC", "GREFERRER"]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(event.event_type, "ReferralPaid");
        assert_eq!(event.data["source"].as_str(), Some("GSRC"));
        assert_eq!(event.data["referrer"].as_str(), Some("GREFERRER"));
        assert!(event.data["target"].is_null());
    }

    /// `BatchTransferFailed` uses the generic (name, source, target) layout.
    #[test]
    fn test_parse_batch_transfer_failed_extracts_source_and_target() {
        let raw = raw_event(serde_json::json!(["BatchTransferFailed", "GSRC", "CTGT"]));
        let event = parse_contract_event(&raw, "C1", 0).expect("must parse");
        assert_eq!(event.event_type, "BatchTransferFailed");
        assert_eq!(event.data["source"].as_str(), Some("GSRC"));
        assert_eq!(event.data["target"].as_str(), Some("CTGT"));
    }

    /// Deterministic ID: different tx_hash -> different id.
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

    // -----------------------------------------------------------------------
    // Issue #646 - cooperative shutdown
    // -----------------------------------------------------------------------

    /// Cancelling the token must make `run_poller` return instead of looping
    /// forever, so the background task can be joined on shutdown.
    #[tokio::test]
    async fn test_run_poller_returns_when_cancelled() {
        let db = crate::db::Database::new("sqlite::memory:").await;
        db.migrate().await;
        let state = Arc::new(crate::AppState {
            db,
            // Unroutable in test sandboxes / CI, so `poll_once` fails fast and
            // the loop reaches the cancellable sleep quickly.
            rpc_url: "http://127.0.0.1:1".to_string(),
            contract_id: "C_TEST".to_string(),
            rpc_client: reqwest::Client::new(),
            webhook_client: reqwest::Client::new(),
            api_key_hash: String::new(),
            lookback_ledgers: 720,
        });
        let token = CancellationToken::new();
        let worker_token = token.clone();

        let handle = tokio::spawn(run_poller(state, worker_token));

        token.cancel();

        tokio::time::timeout(std::time::Duration::from_secs(5), handle)
            .await
            .expect("worker must return promptly after cancellation")
            .expect("worker task must not panic");
    }

    // -----------------------------------------------------------------------
    // Issue #854 - RPC calls must use the timeout-configured `rpc_client`
    // -----------------------------------------------------------------------

    /// `fetch_latest_ledger` must honor the configured request timeout
    /// instead of hanging forever when the RPC node accepts a connection but
    /// never responds. This guards against #854's regression, where
    /// `AppState` had no `rpc_client` field and RPC calls fell back to an
    /// un-timed-out `reqwest::Client::new()`.
    #[tokio::test]
    async fn test_fetch_latest_ledger_times_out_on_unresponsive_rpc() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("must bind a local test listener");
        let addr = listener.local_addr().unwrap();

        // Accept the connection and then never write a response, simulating
        // a hung RPC node.
        tokio::spawn(async move {
            if let Ok((socket, _)) = listener.accept().await {
                // Hold the connection open without responding.
                let _ = socket;
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            }
        });

        let rpc_client = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_millis(200))
            .timeout(std::time::Duration::from_millis(200))
            .build()
            .expect("failed to build timed-out RPC client");

        let db = crate::db::Database::new("sqlite::memory:").await;
        db.migrate().await;
        let state = crate::AppState {
            db,
            rpc_url: format!("http://{addr}"),
            contract_id: "C_TEST".to_string(),
            rpc_client,
            webhook_client: reqwest::Client::new(),
            api_key_hash: String::new(),
            lookback_ledgers: 720,
        };

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            fetch_latest_ledger(&state),
        )
        .await
        .expect("fetch_latest_ledger must return within the test's outer timeout window");

        assert!(
            result.is_err(),
            "an unresponsive RPC must surface a timeout error, not hang or succeed"
        );
    }

    // -----------------------------------------------------------------------
    // Issue #850 - poll_once pagination
    // -----------------------------------------------------------------------

    /// Mock `getEvents` that returns two pages of events, then (defensively)
    /// an empty page. The test asserts that:
    ///   - exactly two RPC requests were made (one per page),
    ///   - all 150 events across both pages are stored,
    ///   - the persisted cursor advanced to the last event's ledger.
    #[tokio::test]
    async fn test_poll_once_pages_two_pages_and_terminates() {
        use axum::routing::post;
        use std::sync::atomic::{AtomicU32, Ordering};

        fn make_event_json(ledger: i64, tx_hash: &str) -> serde_json::Value {
            serde_json::json!({
                "topic": ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
                "ledger": ledger,
                "txHash": tx_hash,
                "createdAt": "2024-06-01T12:00:00Z",
                "value": null,
            })
        }

        // Page 1: MAX_EVENTS_PER_POLL events (full page).
        let page1_events: Vec<_> = (0..MAX_EVENTS_PER_POLL)
            .map(|i| make_event_json(100 + i as i64, &format!("tx-p1-{i}")))
            .collect();
        // Page 2: 50 events (partial page -> must break).
        let page2_events: Vec<_> = (0..50)
            .map(|i| make_event_json(200 + i as i64, &format!("tx-p2-{i}")))
            .collect();

        let page1_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": page1_events,
                "cursor": "cursor-page-2",
                "latestLedger": 300,
            }
        });
        let page2_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": page2_events,
                "cursor": "cursor-page-3",
                "latestLedger": 300,
            }
        });
        let empty_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": [],
                "cursor": "cursor-unused",
                "latestLedger": 300,
            }
        });

        let request_count = Arc::new(AtomicU32::new(0));
        let request_count_clone = Arc::clone(&request_count);

        let mock_router = axum::Router::new().route(
            "/",
            post(move || {
                let count = request_count_clone.fetch_add(1, Ordering::SeqCst);
                let response = match count {
                    0 => page1_response.clone(),
                    1 => page2_response.clone(),
                    _ => empty_response.clone(),
                };
                async move { axum::Json(response) }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, mock_router).await.unwrap();
        });

        let db = crate::db::Database::new("sqlite::memory:").await;
        db.migrate().await;
        // Seed a cursor so poll_once does NOT call fetch_latest_ledger.
        db.set_last_ledger(99).await.unwrap();

        let state = crate::AppState {
            db: db.clone(),
            rpc_url: format!("http://{addr}"),
            contract_id: "C_TEST".to_string(),
            rpc_client: reqwest::Client::new(),
            webhook_client: reqwest::Client::new(),
            api_key_hash: String::new(),
            lookback_ledgers: 720,
        };

        let result = tokio::time::timeout(std::time::Duration::from_secs(10), poll_once(&state))
            .await
            .expect("poll_once must terminate (no infinite loop)");

        result.expect("poll_once must succeed");

        let count = request_count.load(Ordering::SeqCst);
        assert_eq!(
            count, 2,
            "exactly two getEvents calls must be made (one per page)"
        );

        let events = db.list_events(1000, 0).await.expect("list events");
        assert_eq!(
            events.len(),
            150,
            "all 150 events across both pages must be stored"
        );

        let last_ledger = db.get_last_ledger().await.expect("get_last_ledger");
        assert_eq!(
            last_ledger,
            Some(249),
            "cursor must advance to the last event's ledger (200 + 49)"
        );
    }

    // -----------------------------------------------------------------------
    // Issue #882 - getEvents pagination cursor & startLedger mutual exclusion
    // -----------------------------------------------------------------------

    /// Mock RPC rejects any request containing both `startLedger` and `pagination.cursor`.
    /// Returns 250 events over 3 pages (100, 100, 50).
    /// All 250 events must be stored in the database, and `last_cursor` must be persisted.
    #[tokio::test]
    async fn test_mock_rpc_rejects_both_fields_and_stores_250_events_over_3_pages() {
        use axum::routing::post;
        use std::sync::atomic::{AtomicU32, Ordering};

        fn make_event_json(ledger: i64, tx_hash: &str) -> serde_json::Value {
            serde_json::json!({
                "topic": ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
                "ledger": ledger,
                "txHash": tx_hash,
                "createdAt": "2024-06-01T12:00:00Z",
                "value": null,
            })
        }

        // 3 pages: 100 + 100 + 50 = 250 events
        let page1_events: Vec<_> = (0..MAX_EVENTS_PER_POLL)
            .map(|i| make_event_json(100 + i as i64, &format!("tx-p1-{i}")))
            .collect();
        let page2_events: Vec<_> = (0..MAX_EVENTS_PER_POLL)
            .map(|i| make_event_json(200 + i as i64, &format!("tx-p2-{i}")))
            .collect();
        let page3_events: Vec<_> = (0..50)
            .map(|i| make_event_json(300 + i as i64, &format!("tx-p3-{i}")))
            .collect();

        let page1_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": page1_events,
                "cursor": "cursor-page-2",
                "latestLedger": 400,
            }
        });
        let page2_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": page2_events,
                "cursor": "cursor-page-3",
                "latestLedger": 400,
            }
        });
        let page3_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": page3_events,
                "cursor": "cursor-page-4",
                "latestLedger": 400,
            }
        });

        let request_count = Arc::new(AtomicU32::new(0));
        let request_count_clone = Arc::clone(&request_count);

        let mock_router = axum::Router::new().route(
            "/",
            post(move |axum::Json(req): axum::Json<serde_json::Value>| {
                let count = request_count_clone.fetch_add(1, Ordering::SeqCst);
                let p1 = page1_response.clone();
                let p2 = page2_response.clone();
                let p3 = page3_response.clone();
                async move {
                    let params = req.get("params").cloned().unwrap_or_default();
                    let has_start_ledger = params.get("startLedger").is_some();
                    let cursor_val = params
                        .get("pagination")
                        .and_then(|p| p.get("cursor"))
                        .and_then(|c| c.as_str());

                    // Mutual exclusion check per Soroban RPC spec:
                    // If both are provided, reject the request!
                    if has_start_ledger && cursor_val.is_some() {
                        return axum::Json(serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "error": {
                                "code": -32600,
                                "message": "startLedger and pagination.cursor cannot both be set"
                            }
                        }));
                    }

                    let response = match count {
                        0 => {
                            assert!(has_start_ledger, "page 1 must provide startLedger on initial run");
                            assert!(cursor_val.is_none(), "page 1 must not send cursor");
                            p1
                        }
                        1 => {
                            assert!(!has_start_ledger, "page 2 must omit startLedger when cursor is set");
                            assert_eq!(cursor_val, Some("cursor-page-2"));
                            p2
                        }
                        2 => {
                            assert!(!has_start_ledger, "page 3 must omit startLedger when cursor is set");
                            assert_eq!(cursor_val, Some("cursor-page-3"));
                            p3
                        }
                        _ => serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "result": { "events": [], "cursor": "cursor-page-5", "latestLedger": 400 }
                        }),
                    };
                    axum::Json(response)
                }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, mock_router).await.unwrap();
        });

        let db = crate::db::Database::new("sqlite::memory:").await;
        db.migrate().await;
        db.set_last_ledger(99).await.unwrap();

        let state = crate::AppState {
            db: db.clone(),
            rpc_url: format!("http://{addr}"),
            contract_id: "C_TEST".to_string(),
            rpc_client: reqwest::Client::new(),
            webhook_client: reqwest::Client::new(),
            api_key_hash: String::new(),
            lookback_ledgers: 720,
        };

        poll_once(&state).await.expect("poll_once must succeed");

        assert_eq!(
            request_count.load(Ordering::SeqCst),
            3,
            "exactly 3 getEvents requests must be made over 3 pages"
        );

        let events = db.list_events(500, 0).await.expect("list events");
        assert_eq!(
            events.len(),
            250,
            "all 250 events across all 3 pages must be stored"
        );

        assert_eq!(
            db.get_last_cursor().await.expect("get_last_cursor"),
            Some("cursor-page-4".to_string()),
            "last_cursor must be persisted in indexer_state"
        );
    }

    /// When `last_cursor` is persisted in `indexer_state`, `poll_once` resumes from it
    /// without sending `startLedger`. If the RPC rejects the cursor as expired,
    /// `poll_once` clears `last_cursor` and cleanly falls back to `startLedger`.
    #[tokio::test]
    async fn test_poll_once_resumes_from_cursor_and_falls_back_when_expired() {
        use axum::routing::post;
        use std::sync::atomic::{AtomicU32, Ordering};

        let request_count = Arc::new(AtomicU32::new(0));
        let request_count_clone = Arc::clone(&request_count);

        let mock_router = axum::Router::new().route(
            "/",
            post(move |axum::Json(req): axum::Json<serde_json::Value>| {
                let count = request_count_clone.fetch_add(1, Ordering::SeqCst);
                async move {
                    let params = req.get("params").cloned().unwrap_or_default();
                    let has_start_ledger = params.get("startLedger").is_some();
                    let cursor_val = params
                        .get("pagination")
                        .and_then(|p| p.get("cursor"))
                        .and_then(|c| c.as_str());

                    if has_start_ledger && cursor_val.is_some() {
                        return axum::Json(serde_json::json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "error": {
                                "code": -32600,
                                "message": "startLedger and pagination.cursor cannot both be set"
                            }
                        }));
                    }

                    match count {
                        0 => {
                            assert_eq!(cursor_val, Some("expired-cursor-1"));
                            assert!(!has_start_ledger, "resumed poll must omit startLedger");
                            axum::Json(serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": 1,
                                "error": {
                                    "code": -32602,
                                    "message": "cursor is expired or out of range"
                                }
                            }))
                        }
                        _ => {
                            assert!(
                                cursor_val.is_none(),
                                "fallback poll must omit expired cursor"
                            );
                            assert_eq!(
                                params.get("startLedger").and_then(|v| v.as_i64()),
                                Some(500)
                            );
                            axum::Json(serde_json::json!({
                                "jsonrpc": "2.0",
                                "id": 1,
                                "result": {
                                    "events": [{
                                        "topic": ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
                                        "ledger": 500,
                                        "txHash": "tx-fallback-1",
                                        "createdAt": "2024-06-01T12:00:00Z",
                                        "value": null
                                    }],
                                    "cursor": "fresh-cursor-2",
                                    "latestLedger": 505
                                }
                            }))
                        }
                    }
                }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, mock_router).await.unwrap();
        });

        let db = crate::db::Database::new("sqlite::memory:").await;
        db.migrate().await;
        db.set_last_ledger(499).await.unwrap();
        db.set_last_cursor("expired-cursor-1").await.unwrap();

        let state = crate::AppState {
            db: db.clone(),
            rpc_url: format!("http://{addr}"),
            contract_id: "C_TEST".to_string(),
            rpc_client: reqwest::Client::new(),
            webhook_client: reqwest::Client::new(),
            api_key_hash: String::new(),
            lookback_ledgers: 720,
        };

        poll_once(&state)
            .await
            .expect("poll_once must recover from expired cursor");

        assert_eq!(request_count.load(Ordering::SeqCst), 2);
        let events = db.list_events(50, 0).await.unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(
            db.get_last_cursor().await.unwrap(),
            Some("fresh-cursor-2".to_string())
        );
    }

    #[tokio::test]
    async fn test_poll_once_single_tx_batch_across_pages_without_rpc_id_stores_all_150_events() {
        use axum::routing::post;
        use std::sync::atomic::{AtomicU32, Ordering};

        fn make_batch_event_no_rpc_id(tx_hash: &str) -> serde_json::Value {
            serde_json::json!({
                "topic": ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
                "ledger": 100,
                "txHash": tx_hash,
                "createdAt": "2024-06-01T12:00:00Z",
                "value": null,
            })
        }

        let shared_tx_hash = "tx-single-batch-fallback-150";

        // Page 1: 100 events from the same transaction without an RPC id field
        let page1_events: Vec<_> = (0..MAX_EVENTS_PER_POLL)
            .map(|_| make_batch_event_no_rpc_id(shared_tx_hash))
            .collect();
        // Page 2: 50 events continuing the same transaction without an RPC id field
        let page2_events: Vec<_> = (100..150)
            .map(|_| make_batch_event_no_rpc_id(shared_tx_hash))
            .collect();

        let page1_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": page1_events,
                "cursor": "cursor-page-2",
                "latestLedger": 300,
            }
        });
        let page2_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": page2_events,
                "cursor": "cursor-page-3",
                "latestLedger": 300,
            }
        });
        let empty_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": [],
                "cursor": "cursor-unused",
                "latestLedger": 300,
            }
        });

        let request_count = Arc::new(AtomicU32::new(0));
        let request_count_clone = Arc::clone(&request_count);

        let mock_router = axum::Router::new().route(
            "/",
            post(move || {
                let count = request_count_clone.fetch_add(1, Ordering::SeqCst);
                let response = match count {
                    0 => page1_response.clone(),
                    1 => page2_response.clone(),
                    _ => empty_response.clone(),
                };
                async move { axum::Json(response) }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, mock_router).await.unwrap();
        });

        let db = crate::db::Database::new("sqlite::memory:").await;
        db.migrate().await;
        db.set_last_ledger(99).await.unwrap();

        let state = crate::AppState {
            db: db.clone(),
            rpc_url: format!("http://{}", addr),
            contract_id: "C_TEST".to_string(),
            rpc_client: reqwest::Client::new(),
            webhook_client: reqwest::Client::new(),
            api_key_hash: String::new(),
            lookback_ledgers: 720,
        };

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            poll_once(&state),
        )
        .await
        .expect("poll_once must terminate");

        result.expect("poll_once must succeed");

        let count = request_count.load(Ordering::SeqCst);
        assert_eq!(count, 2, "exactly two getEvents calls must be made");

        let events = db.list_events(1000, 0).await.expect("list events");
        assert_eq!(
            events.len(),
            150,
            "all 150 events across both pages must be stored without collision drops"
        );
    }

    #[test]
    fn test_parse_contract_event_uses_rpc_id_when_present() {
        let raw1 = serde_json::json!({
            "id": "0000000000000001-0000000001",
            "topic": ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
            "ledger": 100,
            "txHash": "tx-same-hash",
            "createdAt": "2024-06-01T12:00:00Z"
        });
        let raw2 = serde_json::json!({
            "id": "0000000000000001-0000000002",
            "topic": ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
            "ledger": 100,
            "txHash": "tx-same-hash",
            "createdAt": "2024-06-01T12:00:00Z"
        });

        // Even with the same event_index (e.g. 0), different RPC event IDs produce different event IDs.
        let id1 = parse_contract_event(&raw1, "C1", 0).unwrap().id;
        let id2 = parse_contract_event(&raw2, "C1", 0).unwrap().id;
        assert_ne!(
            id1, id2,
            "Events with different RPC IDs must produce different IndexedEvent IDs even if event_index matches"
        );
    }

    #[tokio::test]
    async fn test_poll_once_single_tx_batch_across_pages_stores_all_150_events() {
        use axum::routing::post;
        use std::sync::atomic::{AtomicU32, Ordering};

        fn make_batch_event_json(rpc_id: &str, tx_hash: &str) -> serde_json::Value {
            serde_json::json!({
                "id": rpc_id,
                "topic": ["CAddressFunded", "CASSET", "GSOURCE", "CTARGET"],
                "ledger": 100,
                "txHash": tx_hash,
                "createdAt": "2024-06-01T12:00:00Z",
                "value": null,
            })
        }

        let shared_tx_hash = "tx-single-batch-150";

        // Page 1: 100 events from the same transaction
        let page1_events: Vec<_> = (0..MAX_EVENTS_PER_POLL)
            .map(|i| make_batch_event_json(&format!("0000000000000001-{:010}", i), shared_tx_hash))
            .collect();
        // Page 2: 50 events continuing the same transaction
        let page2_events: Vec<_> = (100..150)
            .map(|i| make_batch_event_json(&format!("0000000000000001-{:010}", i), shared_tx_hash))
            .collect();

        let page1_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": page1_events,
                "cursor": "cursor-page-2",
                "latestLedger": 300,
            }
        });
        let page2_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": page2_events,
                "cursor": "cursor-page-3",
                "latestLedger": 300,
            }
        });
        let empty_response = serde_json::json!({
            "jsonrpc": "2.0",
            "id": 1,
            "result": {
                "events": [],
                "cursor": "cursor-unused",
                "latestLedger": 300,
            }
        });

        let request_count = Arc::new(AtomicU32::new(0));
        let request_count_clone = Arc::clone(&request_count);

        let mock_router = axum::Router::new().route(
            "/",
            post(move || {
                let count = request_count_clone.fetch_add(1, Ordering::SeqCst);
                let response = match count {
                    0 => page1_response.clone(),
                    1 => page2_response.clone(),
                    _ => empty_response.clone(),
                };
                async move { axum::Json(response) }
            }),
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, mock_router).await.unwrap();
        });

        let db = crate::db::Database::new("sqlite::memory:").await;
        db.migrate().await;
        db.set_last_ledger(99).await.unwrap();

        let state = crate::AppState {
            db: db.clone(),
            rpc_url: format!("http://{}", addr),
            contract_id: "C_TEST".to_string(),
            rpc_client: reqwest::Client::new(),
            webhook_client: reqwest::Client::new(),
            api_key_hash: String::new(),
            lookback_ledgers: 720,
        };

        let result = tokio::time::timeout(
            std::time::Duration::from_secs(10),
            poll_once(&state),
        )
        .await
        .expect("poll_once must terminate");

        result.expect("poll_once must succeed");

        let count = request_count.load(Ordering::SeqCst);
        assert_eq!(count, 2, "exactly two getEvents calls must be made");

        let events = db.list_events(1000, 0).await.expect("list events");
        assert_eq!(
            events.len(),
            150,
            "all 150 events across both pages must be stored without collision drops"
        );
    }
}
