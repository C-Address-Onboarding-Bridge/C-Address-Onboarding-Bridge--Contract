-- Enforce one delivery row per (subscription, event) and index the foreign
-- keys of `webhook_deliveries`.
--
-- Replaying a ledger range re-queued the same event for the same
-- subscription, creating duplicate delivery rows (and duplicate webhook
-- posts). The unique index lets the replay path re-arm the existing row with
-- `INSERT ... ON CONFLICT(subscription_id, event_id) DO UPDATE` instead of
-- inserting a second one. See #894.

-- Collapse any duplicates created before this migration, keeping the oldest
-- row (and therefore its delivery_id) per (subscription_id, event_id).
DELETE FROM webhook_deliveries
WHERE rowid NOT IN (
    SELECT MIN(rowid) FROM webhook_deliveries GROUP BY subscription_id, event_id
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_subscription_event
    ON webhook_deliveries(subscription_id, event_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_event ON webhook_deliveries(event_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_subscription ON webhook_deliveries(subscription_id);
