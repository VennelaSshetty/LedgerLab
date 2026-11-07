
# LedgerLab — Architectural Decision Notes

This document records the initial architectural decisions for LedgerLab. Decisions may be revisited when implementation or testing reveals a better approach.

## ADR-001: PostgreSQL as the Financial Source of Truth

**Decision:** Use PostgreSQL as the authoritative database for all financial records.

**Reasoning:**
- Supports ACID transactions.
- Provides row-level locking and concurrency control.
- Enforces data integrity through constraints.
- Supports atomic transfer operations.

**Consequences:**
- Financial operations must be committed through database transactions.
- Derived data must be verifiable against authoritative ledger records.

**Status:** Accepted.

## ADR-002: Double-Entry Ledger

**Decision:** Represent every successful transfer using one debit entry and one credit entry of equal value.

**Reasoning:**
- Makes financial movements auditable.
- Allows verification that debits equal credits.
- Helps detect inconsistencies in financial records.

**Consequences:**
- Ledger entries must be balanced.
- Historical ledger entries must not be silently modified or deleted.

**Status:** Accepted.

## ADR-003: Integer Paise for Monetary Values

**Decision:** Store all monetary amounts as integer paise rather than floating-point values.

**Reasoning:**
- Avoids floating-point precision errors.
- Supports exact arithmetic for financial operations.

**Consequences:**
- API requests, database columns, and calculations must consistently use integer paise.

**Status:** Accepted.

## ADR-004: Idempotency for Transfer Requests

**Decision:** Require an idempotency key for transfer creation.

**Reasoning:**
- Network timeouts can leave clients uncertain whether a request succeeded.
- Clients may retry requests.
- Duplicate requests must not create duplicate financial effects.

**Consequences:**
- The same key and same request body return the original result.
- The same key with a different request body is rejected.
- Idempotency records must be stored transactionally with the transfer.

**Status:** Accepted.

## ADR-005: Transactional Outbox for Event Publishing

**Decision:** Use the transactional outbox pattern to publish committed transfer events to Kafka.

**Reasoning:**
- Directly writing to PostgreSQL and publishing to Kafka creates a dual-write problem.
- The outbox ensures that the transfer and its corresponding event record commit together.
- Pending events can be published after a publisher failure.

**Consequences:**
- A separate publisher service is required.
- Duplicate event publication is possible and must be handled by consumers.
- Event delivery is at-least-once.

**Status:** Accepted.

## ADR-006: Kafka for Asynchronous Event Processing

**Decision:** Use Apache Kafka for distributing committed transfer events to consumers.

**Reasoning:**
- Decouples financial transaction processing from downstream processing.
- Supports durable event storage and replay.
- Allows consumers to process events independently.

**Consequences:**
- Consumers must handle duplicate delivery.
- Event ordering and partitioning strategies must be designed.
- Kafka is not the financial source of truth.

**Status:** Accepted.

## ADR-007: Idempotent Kafka Consumers

**Decision:** Use a processed-events record with a unique event ID to prevent duplicate projection updates.

**Reasoning:**
- Kafka may redeliver events after consumer failures.
- Reprocessing the same event must not apply its effects twice.

**Consequences:**
- Recording an event as processed and updating its projection must happen in the same PostgreSQL transaction.
- Kafka offsets are committed only after the database transaction succeeds.

**Status:** Accepted.

## ADR-008: Reconciliation from the Authoritative Ledger

**Decision:** Treat read projections and cached balances as derived data that can be checked against authoritative ledger entries.

**Reasoning:**
- Derived data can become inconsistent after failures or processing bugs.
- The ledger provides the authoritative record from which expected values can be calculated.

**Consequences:**
- Reconciliation logic must be deterministic.
- Rebuilding derived data must not modify historical ledger entries.

**Status:** Accepted.

## ADR-009: Controlled Failure Injection

**Decision:** Build a Failure Lab and use Toxiproxy for controlled network fault injection.

**Reasoning:**
- Reliability must be demonstrated through reproducible failure scenarios.
- Controlled faults make it possible to observe system behaviour and recovery.

**Consequences:**
- Failure scenarios must record injected faults and recovery outcomes.
- Financial invariants must be checked before and after recovery.

**Status:** Accepted.

## ADR-010: AI-Assisted Incident Analysis

**Decision:** Use local Ollama to analyse structured Failure Lab reports.

**Reasoning:**
- Provides explanations of system failures and recovery behaviour.
- Keeps analysis separate from financial transaction execution.
- Allows evidence-grounded incident explanations.

**Consequences:**
- AI analysis is read-only.
- Financial decisions and invariant verification remain deterministic.
- AI conclusions must be grounded in recorded evidence.

**Status:** Accepted.
