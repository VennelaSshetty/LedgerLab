
-- ============================================
-- LEDGERLAB: DATABASE INTEGRITY TRIGGERS
-- Migration: 002_add_integrity_triggers.sql
-- ============================================


-- A. FUNCTION: VALIDATE TRANSFER LEDGER
--
-- A completed transfer must have:
-- 1. Exactly one DEBIT entry.
-- 2. Exactly one CREDIT entry.
-- 3. Both entries equal the transfer amount.
-- 4. DEBIT belongs to the sender.
-- 5. CREDIT belongs to the receiver.
--
-- An incomplete transfer must have no ledger entries.


CREATE OR REPLACE FUNCTION validate_transfer_ledger()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_transfer_id UUID;
    v_status VARCHAR(20);
    v_amount BIGINT;
    v_from_account UUID;
    v_to_account UUID;

    v_total_entries INTEGER;
    v_debit_count INTEGER;
    v_credit_count INTEGER;
BEGIN

    -- Determine which transfer needs validation.
    IF TG_TABLE_NAME = 'transfers' THEN
        v_transfer_id := NEW.id;
    ELSE
        v_transfer_id := NEW.transfer_id;
    END IF;

    -- Get transfer details.
    SELECT status, amount_paise, from_account_id, to_account_id
    INTO v_status, v_amount, v_from_account, v_to_account
    FROM transfers
    WHERE id = v_transfer_id;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    -- Count the ledger entries.
    SELECT
        COUNT(*)::INTEGER,
        COUNT(*) FILTER (WHERE entry_type = 'DEBIT')::INTEGER,
        COUNT(*) FILTER (WHERE entry_type = 'CREDIT')::INTEGER
    INTO
        v_total_entries,
        v_debit_count,
        v_credit_count
    FROM ledger_entries
    WHERE transfer_id = v_transfer_id;

    -- Incomplete transfers must not have ledger entries.
    IF v_status <> 'COMPLETED' THEN
        IF v_total_entries <> 0 THEN
            RAISE EXCEPTION
                'Incomplete transfer % cannot have ledger entries',
                v_transfer_id
                USING ERRCODE = '23514';
        END IF;

        RETURN NULL;
    END IF;

    -- Completed transfers require exactly two entries.
    IF v_total_entries <> 2
       OR v_debit_count <> 1
       OR v_credit_count <> 1 THEN

        RAISE EXCEPTION
            'Transfer % must have exactly one debit and one credit',
            v_transfer_id
            USING ERRCODE = '23514';
    END IF;

    -- Validate amounts and account ownership.
    IF EXISTS (
        SELECT 1
        FROM ledger_entries
        WHERE transfer_id = v_transfer_id
          AND (
              (entry_type = 'DEBIT'
               AND (amount_paise <> v_amount
                    OR account_id <> v_from_account))

              OR

              (entry_type = 'CREDIT'
               AND (amount_paise <> v_amount
                    OR account_id <> v_to_account))
          )
    ) THEN

        RAISE EXCEPTION
            'Transfer % has incorrect ledger amounts or accounts',
            v_transfer_id
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;


-- B. DEFERRED CONSTRAINT TRIGGERS
--
-- Validate at transaction COMMIT, not immediately
-- after inserting the first ledger entry.


CREATE CONSTRAINT TRIGGER validate_transfer_on_change
AFTER INSERT OR UPDATE ON transfers
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_transfer_ledger();


CREATE CONSTRAINT TRIGGER validate_ledger_on_insert
AFTER INSERT ON ledger_entries
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION validate_transfer_ledger();


-- C. FUNCTION: PREVENT LEDGER MODIFICATION


CREATE OR REPLACE FUNCTION prevent_ledger_modification()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Ledger entries are append-only. UPDATE, DELETE and TRUNCATE are forbidden.'
        USING ERRCODE = '55000';

    RETURN NULL;
END;
$$;


-- D. APPEND-ONLY TRIGGERS


CREATE TRIGGER ledger_no_update_or_delete
BEFORE UPDATE OR DELETE ON ledger_entries
FOR EACH ROW
EXECUTE FUNCTION prevent_ledger_modification();


CREATE TRIGGER ledger_no_truncate
BEFORE TRUNCATE ON ledger_entries
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_ledger_modification();
