-- Add the `secret` column to `subscriptions`.
--
-- `create_subscription`, `list_subscriptions` and `get_subscription_secret`
-- all read and write `subscriptions.secret`, but migration 0001 never created
-- the column, so every subscription query failed with "no such column:
-- secret".
--
-- The column cannot be added to 0001: sqlx stores a checksum of every applied
-- migration and refuses to start when the checksum of an already-applied
-- migration changes. A new migration is the only safe way to extend the
-- schema of a database that already ran 0001. See #861.

ALTER TABLE subscriptions ADD COLUMN secret TEXT NOT NULL DEFAULT '';

-- Give every subscription created before this migration its own random
-- signing secret. Subscriptions created afterwards get their secret from
-- `create_subscription`.
UPDATE subscriptions SET secret = lower(hex(randomblob(16))) WHERE secret = '';
