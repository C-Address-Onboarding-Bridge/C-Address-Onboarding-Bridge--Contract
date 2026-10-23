-- Enforce a unique (subscription_id, event_id) constraint on webhook_deliveries
-- and add indexes for foreign key lookups.
--
-- Calling /api/replay multiple times previously inserted duplicate rows with
-- distinct UUIDs for the same (subscription, event) pair, breaking receiver-side
-- deduplication.
--
-- In addition, foreign key checks on parent deletions/updates previously suffered
-- from full table scans because neither subscription_id nor event_id had indexes.
-- See #894.

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_sub_event
    ON webhook_deliveries (subscription_id, event_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription_id
    ON webhook_deliveries (subscription_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event_id
    ON webhook_deliveries (event_id);
