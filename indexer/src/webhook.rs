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
