
# LedgerLab — System Design

## 1. Problem Statement

LedgerLab is a simulated payment ledger system that demonstrates how to build a financially correct and fault-tolerant backend system.

The primary challenge is to ensure that concurrent transfers, duplicate requests, service failures, and asynchronous event processing never compromise financial correctness.

## 2. Goals

- Implement transfers using double-entry bookkeeping.
- Preserve financial invariants under concurrent requests and failures.
- Prevent duplicate financial effects through idempotency.
- Process committed transfer events asynchronously.
- Detect and recover inconsistencies in derived data.
- Simulate distributed-system failures and measure recovery.
- Provide observability and evidence-based incident analysis.

## 3. Non-Goals

- Real-money transactions or payment gateway integration.
- Email and notification services.
- Generic workflow engines or external job queue frameworks.
- Multi-tenant API-key management.

## 4. Technology Stack

| Component | Technology |
|---|---|
| Backend | Node.js, TypeScript, Express |
| Database | PostgreSQL |
| Event Streaming | Apache Kafka |
| Frontend | React, TypeScript |
| Testing | Vitest, Supertest |
| Fault Injection | Toxiproxy |
| Metrics | Prometheus |
| Dashboards | Grafana |
| Local Infrastructure | Docker Compose |
| CI | GitHub Actions |
| AI Analysis | Ollama |

## 5. Architecture

The system follows a backend-centred architecture with PostgreSQL as its financial source of truth.

The frontend communicates with the backend through REST APIs. The backend performs financial operations inside PostgreSQL transactions.

A transactional outbox records events in the same transaction as the financial transfer. A separate publisher sends these events to Kafka, where consumers update derived read projections.

A reconciliation service verifies derived data against the authoritative ledger.

The Failure Lab introduces controlled faults, checks financial invariants, and records recovery results. Prometheus and Grafana provide observability, while Ollama performs read-only analysis of structured failure reports.

See [architecture.md](./architecture.md) for the architecture diagram and component details.

## 6. Core Transfer Flow

1. The client submits a transfer request with an idempotency key.
2. The backend validates the request and handles duplicate requests.
3. PostgreSQL begins a transaction and locks the required accounts in a consistent order.
4. The system verifies sufficient funds.
5. The transfer record, debit entry, credit entry, balance updates, idempotency record, and outbox event are written atomically.
6. PostgreSQL commits the transaction.
7. The backend acknowledges the transfer.
8. The outbox publisher publishes the committed event to Kafka.
9. Consumers process events idempotently and update read projections.
10. The reconciler checks derived data against the ledger.

## 7. Correctness and Reliability

The system is designed around six invariants:

- I1: Total money never changes.
- I2: Debits equal credits for every transfer.
- I3: No account has a negative balance.
- I4: Each acknowledged transfer has exactly one financial effect.
- I5: Transfers are atomic, with no partial commits.
- I6: After recovery and processing catch-up, projections agree with the ledger.

PostgreSQL transactions, account locking, database constraints, idempotency, the transactional outbox, idempotent consumers, and reconciliation work together to protect these invariants.

## 8. Failure Testing and Observability

The Failure Lab tests duplicate requests, concurrent transfers, process crashes, database failures, Kafka interruptions, and network faults.

Each scenario records the injected failure, invariant checks, system behaviour, and recovery results.

Prometheus collects metrics such as latency, throughput, error rates, outbox backlog, and consumer lag. Grafana displays these metrics.

Ollama analyses structured incident reports without modifying financial records.

## 9. Success Criteria

LedgerLab is successful when:

- All six financial invariants remain satisfied during supported failure scenarios.
- Duplicate requests do not create duplicate financial effects.
- Concurrent transfers preserve correct balances.
- Committed events are eventually processed after recovery.
- Derived projections can be reconciled with the ledger.
- Failure scenarios produce measurable and reproducible reports.
