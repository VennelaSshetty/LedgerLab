
# LedgerLab — Database Testing

## 1. Overview

This document records the database configuration, integrity verification, concurrency testing, and permission testing performed for LedgerLab.

The database testing covers:

1. Database configuration and connection management.
2. Schema constraints and database integrity.
3. Account-level concurrency protection.
4. Concurrent ledger insertion protection.
5. Restricted application database permissions.

Testing was performed through manual PostgreSQL SQL tests and automated Vitest integration tests.

---

## 2. Database Environment

| Component | Configuration |
|---|---|
| Database | PostgreSQL 17 |
| Execution | Docker |
| Database name | ledgerlab |
| Host port | 5433 |
| Container port | 5432 |
| Backend runtime | Node.js 22.14.0 |
| Database driver | node-postgres (`pg`) |
| Test framework | Vitest 5.1.0 |

### Database Connection Architecture

LedgerLab uses separate PostgreSQL roles for application operations and database administration.

**ledgerlab_user**
- Database owner.
- Used by `migration-pool.ts`.
- Executes database migrations and administrative operations.

**ledgerlab_app**
- Restricted application database role.
- Used by `pool.ts`.
- Performs normal application database operations.
- Cannot perform unauthorized schema modifications or modify/delete ledger entries.

Integration tests use a separate administrative connection for test fixture setup and cleanup. Actual application operations use the restricted application connection.

---

## 3. Manual Database Integrity Testing

The following tests were executed directly against PostgreSQL using `psql`.

All tests were successfully verified.

### 3.1 Valid Transfer

**Scenario:** Execute a valid ₹500 transfer between two accounts.

Verified:
- Transfer record created successfully.
- Sender and receiver balances updated.
- Transfer marked as COMPLETED.
- Exactly one DEBIT ledger entry created.
- Exactly one CREDIT ledger entry created.
- Both ledger entries contain the same amount.
- Deferred ledger validation accepted the transaction.

**Result:** PASSED

### 3.2 CHECK Constraint Validation

Tested:
- Updating an account balance to a negative value.
- Inserting a transfer with a negative amount.

Verified:
- Both operations were rejected by PostgreSQL CHECK constraints.
- Invalid data was not persisted.

**Result:** PASSED

### 3.3 Foreign Key Validation

Attempted to create a transfer referencing a nonexistent account.

Verified:
- PostgreSQL rejected the operation because the referenced account did not exist.

**Result:** PASSED

### 3.4 Idempotency Uniqueness

Attempted to reuse an existing idempotency key for another transfer belonging to the same user.

Verified:
- Duplicate idempotency key was rejected by the unique constraint.
- Existing idempotency record remained intact.

**Result:** PASSED

### 3.5 Deferred Ledger Integrity Validation

Attempted to mark a transfer as COMPLETED while inserting only a DEBIT entry without the corresponding CREDIT entry.

Verified:
- Deferred constraint trigger rejected the transaction at COMMIT.
- Transaction was rolled back.
- Transfer did not remain COMPLETED.
- No partial ledger entries were persisted.

**Result:** PASSED

### 3.6 Append-Only Ledger Protection

Tested the following operations against existing ledger entries:

| Operation | Result |
|---|---|
| UPDATE ledger_entries | Rejected |
| DELETE ledger_entries | Rejected |
| TRUNCATE ledger_entries | Rejected |

Verified:
- Append-only triggers prevented modification and deletion.
- Existing ledger entries remained intact.

**Result:** PASSED

---

## 4. Automated Database Concurrency Testing

Automated integration tests use Vitest and PostgreSQL.

### 4.1 Account-Level Concurrency Protection

**Test file:** `tests/integration/account-concurrency.test.ts`

**Scenario:**

Two simultaneous transfers attempt to spend ₹400 each from an account containing ₹500.

The `lockAccounts` helper uses PostgreSQL `SELECT FOR UPDATE` to lock the involved account rows.

Verified:
- Only one concurrent transfer succeeds.
- The other transfer fails due to insufficient balance.
- The sender's balance never becomes negative.
- Final account balances remain consistent.

**Actual results:**

| Metric | Result |
|---|---:|
| Successful transfers | 1 |
| Failed transfers | 1 |
| Final sender balance | ₹100 |
| Final receiver balance | ₹400 |

**Result: PASSED**

### 4.2 Concurrent Ledger Insert Protection

**Test file:** `tests/integration/ledger-concurrency.test.ts`

**Scenario:**

Two transactions attempt to insert a duplicate DEBIT entry for the same transfer.

The `lock_transfer_before_ledger_insert` trigger obtains a row-level lock on the corresponding transfer.

Verified:
- The second transaction waits for the first transaction.
- After the first transaction commits, the duplicate insertion is rejected.
- PostgreSQL returns unique constraint violation code `23505`.
- Exactly two valid ledger entries remain: one DEBIT and one CREDIT.

**Result: PASSED**

### 4.3 Incomplete Ledger Rejection

The same integration test file verifies that a transfer cannot be committed as COMPLETED with an incomplete ledger.

Verified:
- Deferred validation rejects COMMIT.
- Transaction is rolled back.
- Transfer remains PENDING.
- No partial ledger entries remain.

**Result: PASSED**

---

## 5. Application Database Permission Testing

**Test file:** `tests/integration/database-permissions.test.ts`

These tests verify that the application uses the restricted `ledgerlab_app` role.

### Allowed Operations

| Operation | Result |
|---|---|
| SELECT from accounts | PASSED |
| UPDATE accounts | PASSED |
| INSERT into users | PASSED |

### Forbidden Operations

| Operation | Result |
|---|---|
| DELETE from users | DENIED |
| UPDATE ledger_entries | DENIED |
| DELETE ledger_entries | DENIED |
| TRUNCATE ledger_entries | DENIED |
| CREATE TABLE | DENIED |

All forbidden operations returned PostgreSQL permission error code `42501`.

**Result: PASSED**

---

## 6. Automated Test Execution

All automated integration tests were executed from the backend directory using:

```bash
npm test
```

### Confirmed Test Results

**Date:** November 8, 2026

| Test file | Tests | Result |
|---|---:|---|
| `account-concurrency.test.ts` | 1 | PASSED |
| `ledger-concurrency.test.ts` | 2 | PASSED |
| `database-permissions.test.ts` | 9 | PASSED |
| **Total** | **12** | **12/12 PASSED** |

- Test files passed: 3
- Tests passed: 12
- Tests failed: 0

---

## 7. Overall Database Testing Summary

| Testing Category | Verification Method | Status |
|---|---|---|
| Valid transfer execution | Manual SQL | PASSED |
| CHECK constraints | Manual SQL | PASSED |
| Foreign key constraints | Manual SQL | PASSED |
| Idempotency uniqueness | Manual SQL | PASSED |
| Deferred ledger validation | Manual SQL + automated test | PASSED |
| Append-only ledger protection | Manual SQL | PASSED |
| Account-level concurrency | Automated integration test | PASSED |
| Concurrent ledger insertion | Automated integration test | PASSED |
| Application role permissions | Manual verification + automated test | PASSED |

### Final Result

Database integrity, concurrency protection, and application permission tests have been successfully verified.

**Manual database integrity tests: PASSED**

**Automated integration tests: 12/12 PASSED**

**Overall database testing status: PASSED**

Note: These tests verify database correctness, integrity, concurrency behaviour, and access control. They do not represent a database performance benchmark.
