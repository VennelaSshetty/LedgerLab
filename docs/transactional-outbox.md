
# Transactional Outbox

## 1. Overview

LedgerLab uses the transactional outbox pattern to reliably record events associated with financial transfers.

A transfer must update account balances, create ledger entries and record an event for asynchronous publication.

Publishing directly to a messaging system during a database transaction creates a dual-write problem. The database operation and message publication may not succeed together.

The transactional outbox solves this by inserting the event into PostgreSQL in the same transaction as the financial operation.

PostgreSQL remains the financial source of truth.

## 2. Architecture

The main components are:

- Transfer service: executes financial transfers.
- PostgreSQL: stores accounts, transfers, ledger entries and outbox events.
- Outbox table: stores events awaiting publication.
- Outbox publisher: claims events and sends them through an OutboxTransport.
- Retry policy: schedules retries after publication failures.

The financial transaction persists the transfer and its outbox event atomically.

The publisher operates independently of the transfer request.

## 3. Event lifecycle

An outbox event can have the following states:

- PENDING: waiting to be published.
- PROCESSING: claimed by a publisher.
- PUBLISHED: publication succeeded and the database acknowledgement was recorded.
- FAILED: maximum automatic publication attempts reached.

Normal lifecycle:

PENDING → PROCESSING → PUBLISHED

On publication failure:

PROCESSING → PENDING

After maximum attempts:

PROCESSING → FAILED

A FAILED event can be manually recovered.

## 4. Transactional guarantees

The transfer and corresponding outbox event are written within the same PostgreSQL transaction.

This ensures:

- A rolled-back financial transaction does not leave a committed outbox event.
- A committed financial transaction has its corresponding outbox event.
- Financial transfers do not depend on immediate messaging availability.
- Publication can be retried independently.

The outbox guarantees durable event recording alongside the financial transaction. It does not guarantee exactly-once downstream processing.

## 5. Publisher architecture

The publisher exposes two main operations:

### Claiming events

`claimOutboxBatch()` retrieves eligible events.

It:

- Selects PENDING events whose retry time has arrived.
- Selects PROCESSING events whose leases have expired.
- Excludes events that have exhausted their attempts.
- Increments the attempt count when an event is claimed.
- Sets the event to PROCESSING.
- Assigns a lease using `locked_until`.

### Publishing events

`publishOutboxBatch()`:

1. Claims a batch of events.
2. Sends each event through the supplied OutboxTransport.
3. Marks successful publications as PUBLISHED.
4. Records failures and schedules retries.
5. Tracks publication failures and lease losses.

The publisher uses an interface so the transport can be supplied independently of the publishing logic.

The workload recovery experiment uses a controlled in-memory transport.

## 6. Concurrent claiming and leases

Multiple publisher workers must not claim the same event simultaneously.

LedgerLab uses PostgreSQL:

`FOR UPDATE SKIP LOCKED`

This allows workers to claim different eligible rows without waiting for rows locked by other workers.

Each claimed event receives a lease through `locked_until`.

If a publisher stops working and its lease expires, another publisher can reclaim the event.

The acknowledgement and failure updates also check the event's attempt count and PROCESSING status. This prevents an outdated publisher attempt from overwriting a newer attempt's state.

## 7. Retry policy

LedgerLab uses exponential backoff with equal jitter.

Configuration:

- Base delay: 1 second.
- Maximum delay: 60 seconds.
- Maximum attempts: 5.
- Jitter: enabled.

The exponential delay is:

`D = min(1000 × 2^(attempt - 1), 60000)`

Equal jitter calculates the actual delay as:

`D_actual = D / 2 + random(0, D / 2)`

The calculated retry time is persisted in `next_attempt_at`.

Attempts are incremented when events are claimed.

After the maximum number of attempts, events are marked FAILED and are no longer automatically retried.

## 8. Manual recovery

`recoverFailedOutboxEvent()` allows a FAILED event to be manually recovered.

It:

- Changes the status to PENDING.
- Resets attempts to zero.
- Sets `next_attempt_at` to the current time.
- Clears the lease.
- Preserves the previous error information.

Only FAILED events can be recovered through this operation.

## 9. Delivery semantics and limitations

The publisher provides retryable, publisher-side delivery.

A destination may accept an event before the publisher successfully records its acknowledgement in PostgreSQL.

If this happens, the event may be published again after recovery.

Therefore:

- Duplicate publication is possible.
- Consumers must be designed to handle duplicate events.
- Exactly-once downstream business effects are not established by this implementation.
- Consumer-side deduplication is outside the scope of this phase.

The publisher's reliability is tested using controlled transports rather than a production messaging broker.
