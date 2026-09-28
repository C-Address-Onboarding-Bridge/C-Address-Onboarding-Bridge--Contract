use crate::events::IndexedEvent;
use crate::webhook::{CreateSubscription, Subscription, WebhookDelivery};
use sqlx::sqlite::{Sqlite, SqlitePool, SqlitePoolOptions};
use sqlx::Transaction;

/// Raw column tuple for a `subscriptions` row, in SELECT order:
/// id, url, event_type, asset_filter, source_filter, target_filter, active, created_at.
type SubscriptionRow = (
    String,
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
    bool,
    String,
);

/// Raw column tuple for a `webhook_deliveries` row, in SELECT order:
/// id, subscription_id, event_id, status, attempts, next_retry_at, last_error, created_at.
type WebhookDeliveryRow = (
    String,
    String,
    String,
    String,
    i32,
    Option<String>,
    Option<String>,
    String,
);

pub struct Database {
    pool: SqlitePool,
}

impl Database {
    pub async fn new(url: &str) -> Self {
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect(url)
            .await
            .expect("Failed to connect to database");
        Self { pool }
    }

    pub async fn migrate(&self) {
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS events (
                id TEXT PRIMARY KEY,
                event_type TEXT NOT NULL,
                ledger_sequence INTEGER NOT NULL,
                contract_id TEXT NOT NULL,
                tx_hash TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                data TEXT NOT NULL
            )",
        )
        .execute(&self.pool)
        .await
        .expect("Failed to create events table");

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS subscriptions (
                id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                event_type TEXT,
                asset_filter TEXT,
                source_filter TEXT,
                target_filter TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            )",
        )
        .execute(&self.pool)
        .await
        .expect("Failed to create subscriptions table");

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS webhook_deliveries (
                id TEXT PRIMARY KEY,
                subscription_id TEXT NOT NULL,
                event_id TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                attempts INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (subscription_id) REFERENCES subscriptions(id),
                FOREIGN KEY (event_id) REFERENCES events(id)
            )",
        )
        .execute(&self.pool)
        .await
        .expect("Failed to create webhook_deliveries table");

        sqlx::query(
            "CREATE TABLE IF NOT EXISTS indexer_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )",
        )
        .execute(&self.pool)
        .await
        .expect("Failed to create indexer_state table");

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type)")
            .execute(&self.pool)
            .await
            .ok();

        sqlx::query("CREATE INDEX IF NOT EXISTS idx_events_ledger ON events(ledger_sequence)")
            .execute(&self.pool)
            .await
            .ok();

        sqlx::query(
            "CREATE INDEX IF NOT EXISTS idx_deliveries_status ON webhook_deliveries(status, next_retry_at)",
        )
        .execute(&self.pool)
        .await
        .ok();
    }

    pub async fn get_last_ledger(&self) -> Result<Option<i64>, sqlx::Error> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT value FROM indexer_state WHERE key = 'last_ledger'")
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|(v,)| v.parse().unwrap_or(0)))
    }

    pub async fn set_last_ledger(&self, ledger: i64) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO indexer_state (key, value) VALUES ('last_ledger', ?1)
             ON CONFLICT(key) DO UPDATE SET value = ?1",
        )
        .bind(ledger.to_string())
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Insert an event, ignoring it if its id was already indexed.
    ///
    /// Returns `true` when a new row was written and `false` when the event was
    /// a duplicate. Callers use this to avoid re-queuing webhook deliveries for
    /// an event that has already been delivered.
    pub async fn insert_event(&self, event: &IndexedEvent) -> Result<bool, sqlx::Error> {
        let data_str = serde_json::to_string(&event.data).unwrap_or_default();
        let result = sqlx::query(
            "INSERT OR IGNORE INTO events (id, event_type, ledger_sequence, contract_id, tx_hash, timestamp, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(&event.id)
        .bind(&event.event_type)
        .bind(event.ledger_sequence)
        .bind(&event.contract_id)
        .bind(&event.tx_hash)
        .bind(&event.timestamp)
        .bind(&data_str)
        .execute(&self.pool)
        .await?;
        Ok(result.rows_affected() > 0)
    }

    /// Inserts `event` and, if it was newly indexed (not a re-poll of an
    /// already-seen event), queues its webhook deliveries -- both inside one
    /// SQLite transaction.
    ///
    /// `insert_event` and `queue_webhook_deliveries` used to run as two
    /// separate statements. If the process died (or `queue_webhook_deliveries`
    /// errored) between them, the event was committed but its deliveries were
    /// not; the next poll would then see the event as a duplicate
    /// (`insert_event` returns false) and never queue it, permanently losing
    /// those webhooks. Doing both under one transaction means either both
    /// happen or neither does. See #647.
    pub async fn insert_event_and_queue_deliveries(
        &self,
        event: &IndexedEvent,
    ) -> Result<bool, sqlx::Error> {
        let mut tx = self.pool.begin().await?;

        let data_str = serde_json::to_string(&event.data).unwrap_or_default();
        let result = sqlx::query(
            "INSERT OR IGNORE INTO events (id, event_type, ledger_sequence, contract_id, tx_hash, timestamp, data)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(&event.id)
        .bind(&event.event_type)
        .bind(event.ledger_sequence)
        .bind(&event.contract_id)
        .bind(&event.tx_hash)
        .bind(&event.timestamp)
        .bind(&data_str)
        .execute(&mut tx)
        .await?;
        let inserted = result.rows_affected() > 0;

        if inserted {
            Self::queue_webhook_deliveries_tx(&mut tx, event).await?;
        }

        tx.commit().await?;
        Ok(inserted)
    }

    /// Same subscription-matching and insert logic as
    /// [`Database::queue_webhook_deliveries`], but run against an open
    /// transaction so callers can commit it atomically alongside another
    /// write (see [`Database::insert_event_and_queue_deliveries`]).
    async fn queue_webhook_deliveries_tx(
        tx: &mut Transaction<'_, Sqlite>,
        event: &IndexedEvent,
    ) -> Result<(), sqlx::Error> {
        let subs: Vec<SubscriptionRow> = sqlx::query_as(
            "SELECT id, url, event_type, asset_filter, source_filter, target_filter, active, created_at
             FROM subscriptions WHERE active = 1",
        )
        .fetch_all(&mut *tx)
        .await?;

        let now = chrono::Utc::now().to_rfc3339();
        let data = &event.data;

        for (sub_id, _url, event_type, asset_filter, source_filter, target_filter, _active, _created_at) in
            subs
        {
            if let Some(ref et) = event_type {
                if et != &event.event_type {
                    continue;
                }
            }
            if let Some(ref af) = asset_filter {
                if let Some(asset) = data.get("asset").and_then(|v| v.as_str()) {
                    if asset != af {
                        continue;
                    }
                }
            }
            if let Some(ref sf) = source_filter {
                if let Some(source) = data.get("source").and_then(|v| v.as_str()) {
                    if source != sf {
                        continue;
                    }
                }
            }
            if let Some(ref tf) = target_filter {
                if let Some(target) = data.get("target").and_then(|v| v.as_str()) {
                    if target != tf {
                        continue;
                    }
                }
            }

            let delivery_id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO webhook_deliveries (id, subscription_id, event_id, status, attempts, next_retry_at, created_at)
                 VALUES (?1, ?2, ?3, 'pending', 0, ?4, ?4)",
            )
            .bind(&delivery_id)
            .bind(&sub_id)
            .bind(&event.id)
            .bind(&now)
            .execute(&mut *tx)
            .await?;
        }
        Ok(())
    }

    pub async fn list_events(
        &self,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<IndexedEvent>, sqlx::Error> {
        let rows: Vec<(String, String, i64, String, String, String, String)> = sqlx::query_as(
            "SELECT id, event_type, ledger_sequence, contract_id, tx_hash, timestamp, data
             FROM events ORDER BY ledger_sequence DESC LIMIT ?1 OFFSET ?2",
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(row_to_event).collect())
    }

    pub async fn list_events_by_type(
        &self,
        event_type: &str,
        limit: i64,
        offset: i64,
    ) -> Result<Vec<IndexedEvent>, sqlx::Error> {
        let rows: Vec<(String, String, i64, String, String, String, String)> = sqlx::query_as(
            "SELECT id, event_type, ledger_sequence, contract_id, tx_hash, timestamp, data
             FROM events WHERE event_type = ?1 ORDER BY ledger_sequence DESC LIMIT ?2 OFFSET ?3",
        )
        .bind(event_type)
        .bind(limit)
        .bind(offset)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(row_to_event).collect())
    }

    pub async fn list_events_from_ledger(
        &self,
        from_ledger: i64,
        limit: i64,
    ) -> Result<Vec<IndexedEvent>, sqlx::Error> {
        let rows: Vec<(String, String, i64, String, String, String, String)> = sqlx::query_as(
            "SELECT id, event_type, ledger_sequence, contract_id, tx_hash, timestamp, data
             FROM events WHERE ledger_sequence >= ?1 ORDER BY ledger_sequence ASC LIMIT ?2",
        )
        .bind(from_ledger)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;

        Ok(rows.into_iter().map(row_to_event).collect())
    }

    pub async fn create_subscription(
        &self,
        req: CreateSubscription,
    ) -> Result<Subscription, sqlx::Error> {
        let id = uuid::Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        sqlx::query(
            "INSERT INTO subscriptions (id, url, event_type, asset_filter, source_filter, target_filter, active, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)",
        )
        .bind(&id)
        .bind(&req.url)
        .bind(&req.event_type)
        .bind(&req.asset_filter)
        .bind(&req.source_filter)
        .bind(&req.target_filter)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(Subscription {
            id,
            url: req.url,
            event_type: req.event_type,
            asset_filter: req.asset_filter,
            source_filter: req.source_filter,
            target_filter: req.target_filter,
            active: true,
            created_at: now,
        })
    }

    pub async fn list_subscriptions(&self) -> Result<Vec<Subscription>, sqlx::Error> {
        let rows: Vec<SubscriptionRow> =
            sqlx::query_as(
                "SELECT id, url, event_type, asset_filter, source_filter, target_filter, active, created_at
                 FROM subscriptions WHERE active = 1",
            )
            .fetch_all(&self.pool)
            .await?;

        Ok(rows
            .into_iter()
            .map(
                |(
                    id,
                    url,
                    event_type,
                    asset_filter,
                    source_filter,
                    target_filter,
                    active,
                    created_at,
                )| {
                    Subscription {
                        id,
                        url,
                        event_type,
                        asset_filter,
                        source_filter,
                        target_filter,
                        active,
                        created_at,
                    }
                },
            )
            .collect())
    }

    pub async fn delete_subscription(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE subscriptions SET active = 0 WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn queue_webhook_deliveries(&self, event: &IndexedEvent) -> Result<(), sqlx::Error> {
        let subs = self.list_subscriptions().await?;
        let now = chrono::Utc::now().to_rfc3339();

        for sub in subs {
            if let Some(ref et) = sub.event_type {
                if et != &event.event_type {
                    continue;
                }
            }

            let data = &event.data;
            if let Some(ref af) = sub.asset_filter {
                if let Some(asset) = data.get("asset").and_then(|v| v.as_str()) {
                    if asset != af {
                        continue;
                    }
                }
            }
            if let Some(ref sf) = sub.source_filter {
                if let Some(source) = data.get("source").and_then(|v| v.as_str()) {
                    if source != sf {
                        continue;
                    }
                }
            }
            if let Some(ref tf) = sub.target_filter {
                if let Some(target) = data.get("target").and_then(|v| v.as_str()) {
                    if target != tf {
                        continue;
                    }
                }
            }

            let delivery_id = uuid::Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO webhook_deliveries (id, subscription_id, event_id, status, attempts, next_retry_at, created_at)
                 VALUES (?1, ?2, ?3, 'pending', 0, ?4, ?4)",
            )
            .bind(&delivery_id)
            .bind(&sub.id)
            .bind(&event.id)
            .bind(&now)
            .execute(&self.pool)
            .await?;
        }
        Ok(())
    }

    pub async fn get_pending_deliveries(&self) -> Result<Vec<WebhookDelivery>, sqlx::Error> {
        let now = chrono::Utc::now().to_rfc3339();
        let rows: Vec<WebhookDeliveryRow> =
            sqlx::query_as(
                "SELECT id, subscription_id, event_id, status, attempts, next_retry_at, last_error, created_at
                 FROM webhook_deliveries
                 WHERE status = 'pending' AND (next_retry_at IS NULL OR next_retry_at <= ?1)
                 ORDER BY created_at ASC LIMIT 100",
            )
            .bind(&now)
            .fetch_all(&self.pool)
            .await?;

        Ok(rows
            .into_iter()
            .map(
                |(
                    id,
                    subscription_id,
                    event_id,
                    status,
                    attempts,
                    next_retry_at,
                    last_error,
                    created_at,
                )| {
                    WebhookDelivery {
                        id,
                        subscription_id,
                        event_id,
                        status,
                        attempts,
                        next_retry_at,
                        last_error,
                        created_at,
                    }
                },
            )
            .collect())
    }

    pub async fn mark_delivery_success(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE webhook_deliveries SET status = 'delivered', attempts = attempts + 1 WHERE id = ?1",
        )
        .bind(id)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_delivery_failed(
        &self,
        id: &str,
        error: &str,
        next_retry: &str,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE webhook_deliveries SET attempts = attempts + 1, last_error = ?2, next_retry_at = ?3
             WHERE id = ?1",
        )
        .bind(id)
        .bind(error)
        .bind(next_retry)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn mark_delivery_dead(&self, id: &str, error: &str) -> Result<(), sqlx::Error> {
        sqlx::query(
            "UPDATE webhook_deliveries SET status = 'dead', last_error = ?2, attempts = attempts + 1
             WHERE id = ?1",
        )
        .bind(id)
        .bind(error)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    pub async fn get_subscription_url(&self, id: &str) -> Result<Option<String>, sqlx::Error> {
        let row: Option<(String,)> =
            sqlx::query_as("SELECT url FROM subscriptions WHERE id = ?1 AND active = 1")
                .bind(id)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|(url,)| url))
    }

    pub async fn get_event_by_id(&self, id: &str) -> Result<Option<IndexedEvent>, sqlx::Error> {
        let row: Option<(String, String, i64, String, String, String, String)> = sqlx::query_as(
            "SELECT id, event_type, ledger_sequence, contract_id, tx_hash, timestamp, data
             FROM events WHERE id = ?1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?;

        Ok(row.map(row_to_event))
    }

    pub async fn get_stats(&self) -> Result<serde_json::Value, sqlx::Error> {
        let total_events: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM events")
            .fetch_one(&self.pool)
            .await?;

        let total_subs: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM subscriptions WHERE active = 1")
                .fetch_one(&self.pool)
                .await?;

        let pending_deliveries: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM webhook_deliveries WHERE status = 'pending'")
                .fetch_one(&self.pool)
                .await?;

        let last_ledger = self.get_last_ledger().await?.unwrap_or(0);

        let event_counts: Vec<(String, i64)> = sqlx::query_as(
            "SELECT event_type, COUNT(*) FROM events GROUP BY event_type ORDER BY COUNT(*) DESC",
        )
        .fetch_all(&self.pool)
        .await?;

        let counts: serde_json::Map<String, serde_json::Value> = event_counts
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::Number(v.into())))
            .collect();

        Ok(serde_json::json!({
            "total_events": total_events.0,
            "active_subscriptions": total_subs.0,
            "pending_deliveries": pending_deliveries.0,
            "last_indexed_ledger": last_ledger,
            "event_counts": counts,
        }))
    }
}

fn row_to_event(
    (id, event_type, ledger_sequence, contract_id, tx_hash, timestamp, data): (
        String,
        String,
        i64,
        String,
        String,
        String,
        String,
    ),
) -> IndexedEvent {
    IndexedEvent {
        id,
        event_type,
        ledger_sequence,
        contract_id,
        tx_hash,
        timestamp,
        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::IndexedEvent;

    /// Create an in-memory SQLite database and run migrations.
    async fn setup_db() -> Database {
        let db = Database::new("sqlite::memory:").await;
        db.migrate().await;
        db
    }

    /// Build a minimal `IndexedEvent` with the given id.
    fn make_event(id: &str) -> IndexedEvent {
        IndexedEvent {
            id: id.to_string(),
            event_type: "CAddressFunded".to_string(),
            ledger_sequence: 100,
            contract_id: "CONTRACT_A".to_string(),
            tx_hash: "deadbeef".to_string(),
            timestamp: "2024-01-01T00:00:00Z".to_string(),
            data: serde_json::json!({ "amount": "1000" }),
        }
    }

    // -----------------------------------------------------------------------
    // Issue 2 — INSERT OR IGNORE deduplication
    // -----------------------------------------------------------------------

    /// Inserting the same event twice must be a no-op: only one row should exist.
    #[tokio::test]
    async fn test_insert_duplicate_event_is_ignored() {
        let db = setup_db().await;
        let event = make_event("evt-001");

        db.insert_event(&event).await.expect("first insert");
        // Second insert of the same id should silently do nothing (INSERT OR IGNORE).
        db.insert_event(&event)
            .await
            .expect("duplicate insert must not error");

        let rows = db.list_events(10, 0).await.expect("list_events");
        assert_eq!(rows.len(), 1, "duplicate insert must leave exactly one row");
        assert_eq!(rows[0].id, "evt-001");
    }

    /// Two events with *different* ids must both persist.
    #[tokio::test]
    async fn test_insert_two_distinct_events_both_persist() {
        let db = setup_db().await;

        db.insert_event(&make_event("evt-001"))
            .await
            .expect("first insert");
        db.insert_event(&make_event("evt-002"))
            .await
            .expect("second insert");

        let rows = db.list_events(10, 0).await.expect("list_events");
        assert_eq!(rows.len(), 2, "two distinct events must both be stored");
    }

    // -----------------------------------------------------------------------
    // Issue 2 — Deterministic ID from parse_contract_event (regression guard)
    // -----------------------------------------------------------------------

    /// `parse_contract_event` must produce the same id when called twice with
    /// the identical raw event payload.  If it generates a random UUID every
    /// time, this test will fail — which is exactly the bug this PR fixes.
    #[test]
    fn test_parse_contract_event_produces_deterministic_id() {
        use crate::poller::parse_contract_event_for_test;

        let raw = serde_json::json!({
            "topic": ["CAddressFunded", "GSOURCE", "CTARGET"],
            "ledger": 42,
            "txHash": "abcdef1234567890",
            "createdAt": "2024-01-01T00:00:00Z",
            "value": { "amount": "500" }
        });

        let id1 = parse_contract_event_for_test(&raw, "CONTRACT_A")
            .expect("first parse must succeed")
            .id;
        let id2 = parse_contract_event_for_test(&raw, "CONTRACT_A")
            .expect("second parse must succeed")
            .id;

        assert_eq!(
            id1, id2,
            "parse_contract_event must produce the same id for the same input"
        );
    }

    // -----------------------------------------------------------------------
    // Issue #647 — atomic event insert + webhook queueing
    // -----------------------------------------------------------------------

    /// Happy path: a newly-indexed event with a matching subscription must
    /// end up both inserted and with a pending delivery queued.
    #[tokio::test]
    async fn test_insert_and_queue_deliveries_happy_path() {
        let db = setup_db().await;
        db.create_subscription(CreateSubscription {
            url: "http://example.com/hook".to_string(),
            event_type: None,
            asset_filter: None,
            source_filter: None,
            target_filter: None,
        })
        .await
        .expect("create subscription");

        let event = make_event("evt-atomic-happy");
        let inserted = db
            .insert_event_and_queue_deliveries(&event)
            .await
            .expect("insert_event_and_queue_deliveries");
        assert!(inserted, "first insert of a new event must report true");

        let rows = db.list_events(10, 0).await.expect("list_events");
        assert_eq!(rows.len(), 1, "event must be persisted");

        let pending = db
            .get_pending_deliveries()
            .await
            .expect("get_pending_deliveries");
        assert_eq!(
            pending.len(),
            1,
            "matching subscription must have a queued delivery"
        );
    }

    /// Re-polling an already-indexed event must not queue duplicate deliveries.
    #[tokio::test]
    async fn test_insert_and_queue_deliveries_skips_duplicate_event() {
        let db = setup_db().await;
        db.create_subscription(CreateSubscription {
            url: "http://example.com/hook".to_string(),
            event_type: None,
            asset_filter: None,
            source_filter: None,
            target_filter: None,
        })
        .await
        .expect("create subscription");

        let event = make_event("evt-atomic-dup");
        db.insert_event_and_queue_deliveries(&event)
            .await
            .expect("first insert");
        let inserted_again = db
            .insert_event_and_queue_deliveries(&event)
            .await
            .expect("second insert must not error");
        assert!(
            !inserted_again,
            "re-inserting the same event id must report false"
        );

        let pending = db
            .get_pending_deliveries()
            .await
            .expect("get_pending_deliveries");
        assert_eq!(
            pending.len(),
            1,
            "duplicate insert must not queue a second delivery"
        );
    }

    /// Simulates a failure between the insert and the webhook-queueing step
    /// (dropping the table the second half writes to). The whole transaction
    /// must roll back, so the event is NOT left indexed with no delivery
    /// queued -- the exact bug #647 reports.
    #[tokio::test]
    async fn test_insert_and_queue_deliveries_rolls_back_event_on_queue_failure() {
        let db = setup_db().await;
        db.create_subscription(CreateSubscription {
            url: "http://example.com/hook".to_string(),
            event_type: None,
            asset_filter: None,
            source_filter: None,
            target_filter: None,
        })
        .await
        .expect("create subscription");

        // Force the queueing half of the transaction to fail.
        sqlx::query("DROP TABLE webhook_deliveries")
            .execute(&db.pool)
            .await
            .expect("drop webhook_deliveries table");

        let event = make_event("evt-atomic-rollback");
        let result = db.insert_event_and_queue_deliveries(&event).await;
        assert!(
            result.is_err(),
            "a failure while queueing deliveries must propagate as an error"
        );

        let rows = db.list_events(10, 0).await.expect("list_events");
        assert!(
            rows.is_empty(),
            "the event insert must be rolled back when queueing fails, so a \
             retry can insert AND queue it instead of silently treating it as \
             an already-seen duplicate"
        );
    }
}
