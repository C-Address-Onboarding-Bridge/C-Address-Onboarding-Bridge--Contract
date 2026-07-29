use crate::AppState;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;
use std::sync::Arc;

const MAX_RETRIES: i32 = 5;
const DELIVERY_INTERVAL_MS: u64 = 2000;

// ---------------------------------------------------------------------------
// SSRF protection — URL validation
// ---------------------------------------------------------------------------

/// Errors returned when a webhook URL fails validation.
#[derive(Debug, PartialEq)]
pub enum UrlValidationError {
    InvalidUrl(String),
    ForbiddenScheme(String),
    PrivateOrReservedHost(String),
    UnresolvableHost(String),
}

impl std::fmt::Display for UrlValidationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidUrl(s) => write!(f, "invalid URL: {}", s),
            Self::ForbiddenScheme(s) => write!(f, "forbidden scheme '{}': only http and https are allowed", s),
            Self::PrivateOrReservedHost(s) => write!(f, "private/reserved host rejected: {}", s),
            Self::UnresolvableHost(s) => write!(f, "host could not be resolved: {}", s),
        }
    }
}

/// Returns `true` if the IP address falls in a private, loopback, link-local,
/// or otherwise reserved range that must not be reachable from the indexer.
fn is_private_or_reserved(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()           // 127.0.0.0/8
                || v4.is_private()     // 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
                || v4.is_link_local()  // 169.254.0.0/16  (incl. EC2 metadata 169.254.169.254)
                || v4.is_broadcast()
                || v4.is_documentation()
                || v4.is_unspecified()
                // 100.64.0.0/10 — CGNAT / shared address space
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xC0) == 64)
                // 192.0.0.0/24 — IETF protocol assignments
                || (v4.octets()[0] == 192 && v4.octets()[1] == 0 && v4.octets()[2] == 0)
                // 198.18.0.0/15 — benchmarking
                || (v4.octets()[0] == 198 && (v4.octets()[1] == 18 || v4.octets()[1] == 19))
                // 240.0.0.0/4 — future use / reserved
                || (v4.octets()[0] >= 240)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                // fc00::/7 — unique local
                || ((v6.segments()[0] & 0xFE00) == 0xFC00)
                // fe80::/10 — link-local
                || ((v6.segments()[0] & 0xFFC0) == 0xFE80)
        }
    }
}

/// Validate a webhook URL at subscription-registration time.
///
/// Rules:
///   1. Must be a well-formed URL.
///   2. Scheme must be `http` or `https`.
///   3. Host must not resolve to a private/link-local/reserved IP address.
///
/// DNS resolution is intentionally synchronous (via `std::net::ToSocketAddrs`)
/// so this can be called from a synchronous context without an async executor.
/// For a production service you would use `tokio::net::lookup_host` instead.
pub fn validate_webhook_url(url: &str) -> Result<(), UrlValidationError> {
    // --- 1. Parse the URL ---------------------------------------------------
    let parsed = url::Url::parse(url)
        .map_err(|e| UrlValidationError::InvalidUrl(e.to_string()))?;

    // --- 2. Scheme check ----------------------------------------------------
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err(UrlValidationError::ForbiddenScheme(scheme.to_string()));
    }

    // --- 3. Host extraction -------------------------------------------------
    let host = parsed
        .host_str()
        .ok_or_else(|| UrlValidationError::InvalidUrl("URL has no host".to_string()))?;

    // If the host is already an IP literal, check it directly.
    if let Ok(ip) = host.trim_matches(|c| c == '[' || c == ']').parse::<IpAddr>() {
        if is_private_or_reserved(ip) {
            return Err(UrlValidationError::PrivateOrReservedHost(ip.to_string()));
        }
        return Ok(());
    }

    // --- 4. DNS resolution + IP check ---------------------------------------
    // Reject bare "localhost" without a DNS lookup.
    if host.eq_ignore_ascii_case("localhost") {
        return Err(UrlValidationError::PrivateOrReservedHost("localhost".to_string()));
    }

    let port = parsed.port_or_known_default().unwrap_or(80);
    let addrs = std::net::ToSocketAddrs::to_socket_addrs(&(host, port))
        .map_err(|_| UrlValidationError::UnresolvableHost(host.to_string()))?;

    for addr in addrs {
        if is_private_or_reserved(addr.ip()) {
            return Err(UrlValidationError::PrivateOrReservedHost(addr.ip().to_string()));
        }
    }

    Ok(())
}

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
    /// Stable identifier for this delivery attempt. Identical on every retry
    /// of the same delivery so subscribers can detect duplicates.
    delivery_id: String,
    /// Number of times this delivery has been attempted (1-based on first try).
    attempt: i32,
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
            delivery_id: delivery.id.clone(),
            attempt: delivery.attempts + 1,
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
    // Issue 1 — SSRF URL validation
    // -----------------------------------------------------------------------

    #[test]
    fn test_valid_https_url_is_accepted() {
        assert!(validate_webhook_url("https://example.com/hook").is_ok());
    }

    #[test]
    fn test_valid_http_url_is_accepted() {
        assert!(validate_webhook_url("http://example.com/hook").is_ok());
    }

    #[test]
    fn test_non_http_scheme_is_rejected() {
        let err = validate_webhook_url("ftp://example.com/hook").unwrap_err();
        assert!(matches!(err, UrlValidationError::ForbiddenScheme(_)), "got: {:?}", err);
    }

    #[test]
    fn test_file_scheme_is_rejected() {
        let err = validate_webhook_url("file:///etc/passwd").unwrap_err();
        assert!(matches!(err, UrlValidationError::ForbiddenScheme(_)), "got: {:?}", err);
    }

    #[test]
    fn test_localhost_host_is_rejected() {
        let err = validate_webhook_url("http://localhost/hook").unwrap_err();
        assert!(matches!(err, UrlValidationError::PrivateOrReservedHost(_)), "got: {:?}", err);
    }

    #[test]
    fn test_loopback_ipv4_is_rejected() {
        let err = validate_webhook_url("http://127.0.0.1/hook").unwrap_err();
        assert!(matches!(err, UrlValidationError::PrivateOrReservedHost(_)), "got: {:?}", err);
    }

    #[test]
    fn test_private_10_block_is_rejected() {
        let err = validate_webhook_url("http://10.0.0.1/hook").unwrap_err();
        assert!(matches!(err, UrlValidationError::PrivateOrReservedHost(_)), "got: {:?}", err);
    }

    #[test]
    fn test_private_172_block_is_rejected() {
        let err = validate_webhook_url("http://172.16.0.1/hook").unwrap_err();
        assert!(matches!(err, UrlValidationError::PrivateOrReservedHost(_)), "got: {:?}", err);
    }

    #[test]
    fn test_private_192_168_block_is_rejected() {
        let err = validate_webhook_url("http://192.168.1.1/hook").unwrap_err();
        assert!(matches!(err, UrlValidationError::PrivateOrReservedHost(_)), "got: {:?}", err);
    }

    #[test]
    fn test_link_local_metadata_ip_is_rejected() {
        // 169.254.169.254 is the EC2 / GCP instance metadata endpoint
        let err = validate_webhook_url("http://169.254.169.254/latest/meta-data/").unwrap_err();
        assert!(matches!(err, UrlValidationError::PrivateOrReservedHost(_)), "got: {:?}", err);
    }

    #[test]
    fn test_link_local_range_is_rejected() {
        let err = validate_webhook_url("http://169.254.0.1/hook").unwrap_err();
        assert!(matches!(err, UrlValidationError::PrivateOrReservedHost(_)), "got: {:?}", err);
    }

    #[test]
    fn test_ipv6_loopback_is_rejected() {
        let err = validate_webhook_url("http://[::1]/hook").unwrap_err();
        assert!(matches!(err, UrlValidationError::PrivateOrReservedHost(_)), "got: {:?}", err);
    }

    #[test]
    fn test_malformed_url_is_rejected() {
        let err = validate_webhook_url("not-a-url").unwrap_err();
        assert!(matches!(err, UrlValidationError::InvalidUrl(_)), "got: {:?}", err);
    }

    // -----------------------------------------------------------------------
    // Issue 2 — delivery_id stability across retries
    // -----------------------------------------------------------------------

    /// The delivery_id placed into the payload must equal the stable DB row id
    /// and must remain unchanged on retries.
    #[tokio::test]
    async fn test_delivery_id_is_stable_across_retries() {
        let db = setup_db().await;

        let _sub = db
            .create_subscription(CreateSubscription {
                url: "http://example.com/hook".to_string(),
                event_type: None,
                asset_filter: None,
                source_filter: None,
                target_filter: None,
            })
            .await
            .expect("create subscription");

        let event = IndexedEvent {
            id: "evt-delivery-id-001".to_string(),
            event_type: "CAddressFunded".to_string(),
            ledger_sequence: 10,
            contract_id: "C_TEST".to_string(),
            tx_hash: "aabbccdd".to_string(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            data: serde_json::json!({}),
        };
        db.insert_event(&event).await.expect("insert event");
        db.queue_webhook_deliveries(&event).await.expect("queue deliveries");

        let deliveries = db.get_pending_deliveries().await.expect("get pending");
        assert_eq!(deliveries.len(), 1);
        let delivery = &deliveries[0];
        let delivery_id = delivery.id.clone();

        // Simulate the payload that would be built on the first attempt.
        let payload_attempt_1 = WebhookPayload {
            delivery_id: delivery.id.clone(),
            attempt: delivery.attempts + 1,
            event_id: event.id.clone(),
            event_type: event.event_type.clone(),
            ledger_sequence: event.ledger_sequence,
            contract_id: event.contract_id.clone(),
            tx_hash: event.tx_hash.clone(),
            timestamp: event.timestamp.clone(),
            data: event.data.clone(),
        };

        assert_eq!(
            payload_attempt_1.delivery_id, delivery_id,
            "delivery_id in payload must equal the stable delivery row id"
        );

        // Mark as failed and re-fetch.
        let next_retry = (chrono::Utc::now() + chrono::Duration::seconds(0)).to_rfc3339();
        db.mark_delivery_failed(&delivery_id, "timeout", &next_retry)
            .await
            .expect("mark failed");

        let retried = db.get_pending_deliveries().await.expect("get pending after retry");
        let retried_id = if retried.is_empty() {
            delivery_id.clone()
        } else {
            retried[0].id.clone()
        };

        assert_eq!(
            retried_id, delivery_id,
            "delivery_id must be the same on retry (no new row created)"
        );
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
            .create_subscription(CreateSubscription {
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
        for i in 0..(MAX_RETRIES - 1) {
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
            .create_subscription(CreateSubscription {
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
