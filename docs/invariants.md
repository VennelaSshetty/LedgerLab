
# LedgerLab — System Invariants

These six invariants define the financial correctness
and reliability guarantees that LedgerLab must maintain.

## I1: Total Money Never Changes

The total money across all accounts must remain unchanged
after every successful transfer.

Total money before = Total money after.

## I2: Debits Must Equal Credits

Every successful transfer must have corresponding
debit and credit ledger entries of equal amounts.

Total debits = Total credits.

## I3: No Negative Balances

No account must have a negative balance after
any committed transaction.

Account balance >= 0.

## I4: Each Acknowledged Transfer Exists Exactly Once

Every acknowledged transfer must exist exactly once
in the ledger, even when the client retries requests
due to network failures or timeouts.

Duplicate requests must not create duplicate transfers.

## I5: No Partial Transfers

A transfer must be completely executed or completely
rolled back.

All operations succeed or none do.

## I6: After Recovery, Projections Equal the Ledger

After failures are recovered and event processing
catches up, all derived projections must match
the source ledger.

Projection = Ledger.
