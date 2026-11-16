
CREATE TABLE account_opening_balances (
    account_id UUID PRIMARY KEY
        REFERENCES accounts(id),

    amount_paise BIGINT NOT NULL
        CHECK (amount_paise >= 0),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- Prevent modification of an opening balance after creation.
CREATE OR REPLACE FUNCTION prevent_opening_balance_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'Account opening balances cannot be updated'
        USING ERRCODE = '55000';
END;
$$;


CREATE TRIGGER account_opening_balance_no_update
BEFORE UPDATE ON account_opening_balances
FOR EACH ROW
EXECUTE FUNCTION prevent_opening_balance_update();


-- The application can create and read opening balances,
-- but cannot modify, delete, or truncate them.
REVOKE ALL ON TABLE account_opening_balances FROM ledgerlab_app;

GRANT SELECT, INSERT
ON TABLE account_opening_balances
TO ledgerlab_app;
