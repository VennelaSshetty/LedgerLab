
# LedgerLab — Database Testing

## 1. Overview

This document records the database configuration, integrity verification, concurrency testing, and permission testing performed for LedgerLab.

The database testing covers:

1. Database configuration and connection management.
2. Schema constraints and database integrity.
3. Account-level concurrency protection.
4. Concurrent ledger insertion protection.
5. Restricted application database permissions.
6. End-to-end HTTP transfer stress testing.
7. Independent ledger invariant verification.

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


### 6.2 Complete Test Suite Execution

**Date:** November 17, 2026

The complete backend test suite was executed using:

```bash
npm test
```

**Results:**

| Metric | Result |
|---|---:|
| Test files passed | 23/23 |
| Total tests passed | 179/179 |
| Failed tests | 0 |
| Duration | 41.58 seconds |

The execution included unit tests, integration tests, workload tests, history tests, verifier tests, and transfer stress tests.

**Result: PASSED**


---


## 7. End-to-End Transfer Stress Testing

**Test file:** `tests/integration/transfer-stress.test.ts`

These integration tests exercise concurrent transfer requests through the HTTP API and verify the resulting database state.

### 7.1 Controlled Overspending

**Scenario:** 1,000 concurrent transfer requests attempt to spend from an account containing ₹1,000.

Verified:
- 10 successful transfers.
- 990 rejected due to insufficient funds.
- Sender final balance: ₹0.
- Receiver final balance: ₹1,000.
- Exactly 20 ledger entries.
- No partial transfers or unknown outcomes.

**Result: PASSED**

### 7.2 Concurrent Idempotency

**Scenario:** 50 simultaneous requests use the same idempotency key.

Verified:
- 50 successful responses.
- 49 idempotent replays.
- Exactly one unique transfer ID.
- Exactly one database transfer.
- Exactly two ledger entries.
- Sender final balance: ₹900.
- Receiver final balance: ₹100.

**Result: PASSED**

### 7.3 Opposite-Direction Concurrent Transfers

**Scenario:** Five rounds of 200 concurrent transfers in opposite directions.

Verified:
- 1,000 successful transfers.
- Exactly 1,000 database transfers.
- Exactly 2,000 ledger entries.
- Both account balances remained ₹10,000.
- No unknown outcomes.
- PostgreSQL deadlock counter increase: 0.

**Result: PASSED**

### 7.4 Independent Ledger Verification

After each scenario, the independent verifier checked the following invariants:

| Invariant | Description | Result |
|---|---|---|
| I1 | Total money remains constant | PASS |
| I2 | Debit and credit entries balance | PASS |
| I3 | No negative account balances | PASS |
| I5 | No partial transfers | PASS |
| I6 | Projections match the ledger | PASS |

All five checks passed after each of the three scenarios, resulting in 15 successful invariant checks.

I4 remains NOT VERIFIED by this verifier.

**Result: PASSED**

### 7.5 Stress Test Execution

Run from the backend directory:

```bash
npx vitest run tests/integration/transfer-stress.test.ts
```

**Confirmed execution — November 17, 2026**

- Stress test scenarios passed: 3/3.
- Invariant checks passed: 15/15.
- Test failures: 0.

**Overall Result: PASSED**

---

## 8. Overall Database Testing Summary

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
| End-to-end transfer stress testing | HTTP + PostgreSQL integration tests | PASSED |
| Independent ledger verification | Invariant verifier | PASSED |

### Final Result

Database integrity, concurrency protection, application permissions, and end-to-end transfer behaviour have been successfully verified.

**Manual database integrity tests: PASSED**

**Automated database integration tests: 12/12 PASSED**

**Complete backend test suite (November 17): 179/179 PASSED**

**End-to-end stress tests: 3/3 PASSED**

**Independent invariant checks: 15/15 PASSED**

**Overall database testing status: PASSED**

Note: These tests verify database correctness, integrity, concurrency behaviour, and access control. They do not represent a database performance benchmark.


