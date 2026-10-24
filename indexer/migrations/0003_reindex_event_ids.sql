-- #885: Event IDs are now derived from the globally unique Soroban RPC event
-- `id` (`<toid>-<event_index>`) instead of a per-page transaction counter.
-- Clear pre-existing events, webhook deliveries, and cursor state on upgrade
-- so the poller re-indexes cleanly from the chain without duplicate rows.
DELETE FROM webhook_deliveries;
DELETE FROM events;
DELETE FROM indexer_state;
