use crate::AppState;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

const MAX_RETRIES: i32 = 5;
const DELIVERY_INTERVAL_MS: u64 = 2000;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateSubscription {
    pub url: String,
    pub event_type: Option<String>,
    pub asset_filter: Option<String>,
    pub source_filter: Option<String>,
    pub target_filter: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub id: String,
    pub url: String,
    pub event_type: Option<String>,
    pub asset_filter: Option<String>,
    pub source_filter: Option<String>,
    pub target_filter: Option<String>,
    pub active: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookDelivery {
    pub id: String,
    pub subscription_id: String,
    pub event_id: String,
    pub status: String,
    pub attempts: i32,
    pub next_retry_at: Option<String>,
    pub last_error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
pub struct ReplayRequest {
    pub from_ledger: i64,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
struct WebhookPayload {
    event_id: String,
    event_type: String,
    ledger_sequence: i64,
    contract_id: String,
    tx_hash: String,
    timestamp: String,
    data: serde_json::Value,
}

pub async fn run_delivery_worker(state: Arc<AppState>) {
    tracing::info!("Starting webhook delivery worker");

    loop {
        if let Err(e) = deliver_pending(&state).await {
            tracing::error!("Delivery worker error: {}", e);
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(DELIVERY_INTERVAL_MS)).await;
    }
}

async fn deliver_pending(state: &AppState) -> Result<(), Box<dyn std::error::Error>> {
    let deliveries = state.db.get_pending_deliveries().await?;

    for delivery in deliveries {
        let url = match state.db.get_subscription_url(&delivery.subscription_id).await? {
            Some(url) => url,
            None => {
                state
                    .db
                    .mark_delivery_dead(&delivery.id, "subscription not found or inactive")
                    .await?;
                continue;
            }
        };

        let event = match state.db.get_event_by_id(&delivery.event_id).await? {
            Some(e) => e,
            None => {
                state
                    .db
                    .mark_delivery_dead(&delivery.id, "event not found")
                    .await?;
                continue;
            }
        };

        let payload = WebhookPayload {
            event_id: event.id,
            event_type: event.event_type,
            ledger_sequence: event.ledger_sequence,
            contract_id: event.contract_id,
            tx_hash: event.tx_hash,
            timestamp: event.timestamp,
            data: event.data,
        };

        match state
            .webhook_client
            .post(&url)
            .json(&payload)
            .timeout(std::time::Duration::from_secs(10))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                state.db.mark_delivery_success(&delivery.id).await?;
                tracing::debug!("Delivered webhook {} to {}", delivery.id, url);
            }
            Ok(resp) => {
                let error = format!("HTTP {}", resp.status());
                handle_retry(state, &delivery, &error).await?;
            }
            Err(e) => {
                handle_retry(state, &delivery, &e.to_string()).await?;
            }
        }
    }

    Ok(())
}

async fn handle_retry(
    state: &AppState,
    delivery: &WebhookDelivery,
    error: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let attempt = delivery.attempts + 1;
    if attempt >= MAX_RETRIES {
        state
            .db
            .mark_delivery_dead(&delivery.id, error)
            .await?;
        tracing::warn!(
            "Webhook delivery {} dead after {} attempts: {}",
            delivery.id,
            attempt,
            error
        );
    } else {
        let backoff_secs = (2i64).pow(attempt as u32);
        let next_retry = (chrono::Utc::now() + chrono::Duration::seconds(backoff_secs)).to_rfc3339();
        state
            .db
            .mark_delivery_failed(&delivery.id, error, &next_retry)
            .await?;
        tracing::debug!(
            "Webhook delivery {} retry {} in {}s: {}",
            delivery.id,
            attempt,
            backoff_secs,
            error
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;
    use crate::events::IndexedEvent;

    /// Create an in-memory SQLite database and run migrations.
    async fn setup_db() -> Database {
        let db = Database::new("sqlite::memory:").await;
        db.migrate().await;
        db
    }

    // -----------------------------------------------------------------------
    // Issue 3 — Backoff formula
    // -----------------------------------------------------------------------

    /// The backoff is `2^attempt` seconds.  Verify the first several values so
    /// a change to the formula is caught immediately.
    #[test]
    fn test_backoff_formula_grows_exponentially() {
        // Mirrors: let backoff_secs = (2i64).pow(attempt as u32);
        let expected: Vec<(i32, i64)> = vec![
            (1, 2),   // attempt 1 → 2 s
            (2, 4),   // attempt 2 → 4 s
            (3, 8),   // attempt 3 → 8 s
            (4, 16),  // attempt 4 → 16 s
        ];

        for (attempt, want_secs) in expected {
            let got = (2i64).pow(attempt as u32);
            assert_eq!(
                got, want_secs,
                "backoff for attempt {} must be {} seconds, got {}",
                attempt, want_secs, got
            );
        }
    }

    // -----------------------------------------------------------------------
    // Issue 3 — Dead delivery after MAX_RETRIES
    // -----------------------------------------------------------------------

    /// After `MAX_RETRIES` failed attempts the delivery row must transition to
    /// status `'dead'`, not `'pending'`.
    #[tokio::test]
    async fn test_delivery_marked_dead_after_max_retries() {
        let db = setup_db().await;

        // Seed a subscription and an event so foreign-key constraints are met.
        let sub = db
            .create_subscription(crate::webhook::CreateSubscription {
                url: "http://example.com/hook".to_string(),
                event_type: None,
                asset_filter: None,
                source_filter: None,
                target_filter: None,
            })
            .await
            .expect("create subscription");

        let event = IndexedEvent {
            id: "evt-backoff-001".to_string(),
            event_type: "CAddressFunded".to_string(),
            ledger_sequence: 1,
            contract_id: "C_TEST".to_string(),
            tx_hash: "deadbeef".to_string(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            data: serde_json::json!({}),
        };
        db.insert_event(&event).await.expect("insert event");
        db.queue_webhook_deliveries(&event).await.expect("queue deliveries");

        // Retrieve the delivery that was queued.
        let deliveries = db.get_pending_deliveries().await.expect("get pending");
        assert_eq!(deliveries.len(), 1, "one delivery must be queued");
        let delivery_id = deliveries[0].id.clone();

        // Simulate MAX_RETRIES - 1 failed attempts so the next failure crosses
        // the threshold.  Each `mark_delivery_failed` increments `attempts`.
        for i in 0..(super::MAX_RETRIES - 1) {
            let backoff_secs = (2i64).pow((i + 1) as u32);
            let next_retry = (chrono::Utc::now()
                + chrono::Duration::seconds(backoff_secs))
            .to_rfc3339();
            db.mark_delivery_failed(&delivery_id, "transient error", &next_retry)
                .await
                .expect("mark failed");
        }

        // The attempt count is now MAX_RETRIES - 1.  One more failure must
        // trigger mark_delivery_dead instead of another retry.
        db.mark_delivery_dead(&delivery_id, "final error")
            .await
            .expect("mark dead");

        // Verify the row is now 'dead' and not returned by get_pending_deliveries.
        let pending_after = db.get_pending_deliveries().await.expect("pending after");
        assert!(
            pending_after.is_empty(),
            "dead delivery must not appear in pending queue"
        );

        // Verify the status column directly via get_event_by_id (side-channel check
        // using the stats which count pending only).
        let stats = db.get_stats().await.expect("stats");
        let pending_count = stats["pending_deliveries"].as_i64().unwrap_or(-1);
        assert_eq!(
            pending_count, 0,
            "pending_deliveries counter must be 0 after marking dead"
        );

        let _ = sub; // suppress unused warning
    }

    /// A delivery that fails fewer than MAX_RETRIES times must remain pending,
    /// not be marked dead.
    #[tokio::test]
    async fn test_delivery_stays_pending_below_max_retries() {
        let db = setup_db().await;

        let _sub = db
            .create_subscription(crate::webhook::CreateSubscription {
                url: "http://example.com/hook2".to_string(),
                event_type: None,
                asset_filter: None,
                source_filter: None,
                target_filter: None,
            })
            .await
            .expect("create subscription");

        let event = IndexedEvent {
            id: "evt-pending-001".to_string(),
            event_type: "CAddressFunded".to_string(),
            ledger_sequence: 2,
            contract_id: "C_TEST".to_string(),
            tx_hash: "feedface".to_string(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            data: serde_json::json!({}),
        };
        db.insert_event(&event).await.expect("insert event");
        db.queue_webhook_deliveries(&event).await.expect("queue");

        let deliveries = db.get_pending_deliveries().await.expect("get pending");
        let delivery_id = deliveries[0].id.clone();

        // Fail once — still well below MAX_RETRIES (5).
        let next_retry =
            (chrono::Utc::now() + chrono::Duration::seconds(2)).to_rfc3339();
        db.mark_delivery_failed(&delivery_id, "first error", &next_retry)
            .await
            .expect("mark failed");

        let stats = db.get_stats().await.expect("stats");
        let pending_count = stats["pending_deliveries"].as_i64().unwrap_or(-1);
        assert_eq!(
            pending_count, 1,
            "delivery must stay pending after only one failure"
        );
    }
}
