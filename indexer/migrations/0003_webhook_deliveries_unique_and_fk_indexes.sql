-- Migration 0003: Unique constraint and FK indexes on webhook_deliveries (#894)
--
-- Prevents duplicate deliveries of the same event to the same subscription on replay
-- and adds covering indexes for foreign key cascades/checks.

DELETE FROM webhook_deliveries
WHERE rowid NOT IN (
    SELECT MIN(rowid)
    FROM webhook_deliveries
    GROUP BY subscription_id, event_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_deliveries_sub_event
    ON webhook_deliveries(subscription_id, event_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription_id
    ON webhook_deliveries(subscription_id);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_event_id
    ON webhook_deliveries(event_id);
