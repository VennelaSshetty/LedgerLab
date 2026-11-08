
-- ============================================
-- LEDGERLAB: QUERY PERFORMANCE INDEXES
-- Migration: 003_add_indexes.sql
-- ============================================


-- 1. Find all accounts belonging to a user.
CREATE INDEX idx_accounts_user_id
ON accounts(user_id);


-- 2. Find transfers sent by an account,
-- newest first.
CREATE INDEX idx_transfers_from_account_created
ON transfers(from_account_id, created_at DESC);


-- 3. Find transfers received by an account,
-- newest first.
CREATE INDEX idx_transfers_to_account_created
ON transfers(to_account_id, created_at DESC);


-- 4. Find ledger history for an account,
-- newest first.
CREATE INDEX idx_ledger_account_created
ON ledger_entries(account_id, created_at DESC);


-- 5. Find unpublished outbox events efficiently.
-- Only unpublished records are included.
CREATE INDEX idx_outbox_unpublished
ON outbox(created_at)
WHERE published_at IS NULL;
