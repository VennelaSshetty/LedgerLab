
# Outbox Failure Testing and Recovery

## 1. Purpose

This document describes the failure and recovery tests performed on LedgerLab's transactional outbox.

The objective is to verify that financial transactions remain safe when publication fails, publishers stop working or messaging becomes unavailable.

Testing focuses on publisher-side behaviour.

## 2. Controlled transport

A test-only `ControlledOutboxTransport` simulates messaging availability.

It supports:

- Available: accepts and records published events.
- Unavailable: rejects publication with a test error.

Accepted events are recorded so that tests can inspect publication behaviour.

File:

`backend/tests/helpers/controlled-outbox-transport.ts`

This helper allows publication failures to be tested without requiring an external messaging broker.

## 3. Failure scenarios

### 3.1 Messaging destination unavailable

The controlled transport is made unavailable.

Expected behaviour:

- Publication fails.
- The failure is recorded.
- The event returns to PENDING when another automatic attempt is allowed.
- A retry time is persisted.
- The financial transaction remains committed.

### 3.2 Financial transaction during messaging failure

A valid transfer is submitted while the messaging destination is unavailable.

The test verifies that the financial transfer and corresponding outbox event are committed successfully.

The transfer does not depend on immediate publication.

### 3.3 Publisher interruption

A publisher interruption is simulated by creating the database state left by an interrupted batch.

The test verifies that unfinished PROCESSING events become eligible for claiming after their leases expire.

This is a database-state simulation, not an actual operating-system process kill.

### 3.4 Destination restoration

The messaging destination is restored.

The publisher retries eligible events and records successful publication.

Tests verify that recovered events reach PUBLISHED.

### 3.5 Repeated failures

The destination remains unavailable across repeated attempts.

Tests verify:

- Attempt counts increase.
- Retry times are persisted.
- The maximum attempt count is respected.
- Events eventually enter FAILED.
- Automatic retries stop after the maximum attempts.

### 3.6 Manual recovery

A FAILED event is manually recovered.

Tests verify that:

- Its status returns to PENDING.
- Its attempt count resets to zero.
- Its next attempt time becomes eligible immediately.
- Its lease is cleared.
- Its previous error information is preserved.

The event can subsequently be published when the destination becomes available.

## 4. Retry policy

The retry policy uses exponential backoff with equal jitter.

| Setting | Value |
|---|---:|
| Base delay | 1 second |
| Maximum delay | 60 seconds |
| Maximum attempts | 5 |
| Jitter | Enabled |

The next retry time is stored in `next_attempt_at`.

## 5. Concurrent claiming and recovery

The publisher uses PostgreSQL row-level locking with `FOR UPDATE SKIP LOCKED`.

Leases prevent events from remaining permanently assigned to a publisher that has stopped working.

After lease expiry, another publisher can claim the unfinished event.

The tests cover concurrent claiming, publication, acknowledgement and recovery.

## 6. Workload-level outage experiment

A separate integration test simulates publisher unavailability.

The experiment:

1. Generates 500 transfer requests.
2. Executes the workload while publication remains paused.
3. Confirms successful transfers and their pending outbox events.
4. Restores publication.
5. Publishes the accumulated events.
6. Checks the final database states.

This is different from the controlled transport failure tests: the workload experiment pauses the publisher rather than attempting and failing transport publication.

## 7. Test commands

Run publisher integration tests:

`npx vitest run tests/integration/outbox-publisher.test.ts`

Run controlled transport unit tests:

`npx vitest run tests/unit/controlled-outbox-transport.test.ts`

Run workload and recovery integration tests:

`npx vitest run tests/integration/outbox-workload.test.ts`

Run the complete backend test suite:

`npx vitest run`

Run TypeScript type checking:

`npx tsc --noEmit`

## 8. Limitations

- The controlled transport is not a production message broker.
- Publisher interruption is simulated through database state and lease expiry.
- Duplicate publication is possible after ambiguous publication outcomes.
- Consumer-side deduplication is not implemented or verified in this phase.
- Exactly-once downstream business effects are not claimed.
- Invariant I4, acknowledged transfer exactly once, remains NOT VERIFIED.

The tests establish publisher-side persistence, retry scheduling, failure handling and recovery.
