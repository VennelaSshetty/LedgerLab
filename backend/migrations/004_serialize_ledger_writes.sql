-- Serialize ledger insertions belonging to the same transfer.
CREATE OR REPLACE FUNCTION lock_transfer_before_ledger_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Acquire a row-level lock on the parent transfer.
    PERFORM 1
    FROM transfers
    WHERE id = NEW.transfer_id
    FOR UPDATE;

    -- Reject ledger entries for a nonexistent transfer.
    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Cannot insert ledger entry: transfer % does not exist',
            NEW.transfer_id;
    END IF;

    RETURN NEW;
END;
$$;

-- Acquire the lock before inserting each ledger entry.
CREATE TRIGGER lock_transfer_before_ledger_insert
BEFORE INSERT ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION lock_transfer_before_ledger_insert();