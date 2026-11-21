-- Add publisher lifecycle state to the existing outbox.

ALTER TABLE outbox
ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED'));

ALTER TABLE outbox
ADD COLUMN next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE outbox
ADD COLUMN locked_until TIMESTAMPTZ;

ALTER TABLE outbox
ADD COLUMN last_error TEXT;

-- Preserve the state of any events published before this migration.
UPDATE outbox
SET status = 'PUBLISHED'
WHERE published_at IS NOT NULL;

-- Replace the old unpublished-event index with indexes
-- supporting pending-event selection and lease recovery.
DROP INDEX IF EXISTS idx_outbox_unpublished;

CREATE INDEX idx_outbox_pending_next_attempt
ON outbox(next_attempt_at, created_at)
WHERE status = 'PENDING';

CREATE INDEX idx_outbox_processing_lease
ON outbox(locked_until)
WHERE status = 'PROCESSING';