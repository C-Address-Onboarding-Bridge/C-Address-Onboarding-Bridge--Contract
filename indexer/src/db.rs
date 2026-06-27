use crate::events::IndexedEvent;
use crate::webhook::{CreateSubscription, Subscription, WebhookDelivery};
use sqlx::sqlite::{SqlitePool, SqlitePoolOptions};

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
        let row: Option<(String,)> = sqlx::query_as(
            "SELECT value FROM indexer_state WHERE key = 'last_ledger'",
        )
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

    pub async fn insert_event(&self, event: &IndexedEvent) -> Result<(), sqlx::Error> {
        let data_str = serde_json::to_string(&event.data).unwrap_or_default();
        sqlx::query(
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
        let rows: Vec<(String, String, Option<String>, Option<String>, Option<String>, Option<String>, bool, String)> =
            sqlx::query_as(
                "SELECT id, url, event_type, asset_filter, source_filter, target_filter, active, created_at
                 FROM subscriptions WHERE active = 1",
            )
            .fetch_all(&self.pool)
            .await?;

        Ok(rows
            .into_iter()
            .map(|(id, url, event_type, asset_filter, source_filter, target_filter, active, created_at)| {
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
            })
            .collect())
    }

    pub async fn delete_subscription(&self, id: &str) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE subscriptions SET active = 0 WHERE id = ?1")
            .bind(id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn queue_webhook_deliveries(
        &self,
        event: &IndexedEvent,
    ) -> Result<(), sqlx::Error> {
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
        let rows: Vec<(String, String, String, String, i32, Option<String>, Option<String>, String)> =
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
            .map(|(id, subscription_id, event_id, status, attempts, next_retry_at, last_error, created_at)| {
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
            })
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
        let total_events: (i64,) =
            sqlx::query_as("SELECT COUNT(*) FROM events")
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
