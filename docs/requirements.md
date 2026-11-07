
# LedgerLab — System Requirements

## 1. Project Overview

LedgerLab is a simulated payment ledger system designed to demonstrate financial correctness, distributed-system reliability, and failure recovery.

It combines a double-entry ledger with a Failure Lab that injects failures and verifies whether the system maintains financial correctness.

## 2. Functional Requirements

### Account Management
- Create and manage simulated accounts.
- Maintain account balances in integer paise.
- Retrieve account details and balances.

### Transfers
- Transfer money between accounts.
- Maintain a double-entry ledger for every successful transfer.
- Ensure each transfer is atomic.
- Prevent duplicate transfers using idempotency.
- Prevent accounts from having negative balances.
- Maintain a complete transaction history.

### Event Processing
- Publish committed transfer events through a transactional outbox.
- Process events asynchronously using Kafka consumers.
- Handle duplicate event delivery safely.
- Maintain derived projections from ledger events.
- Reconcile projections against the source ledger.

### Failure Lab
- Simulate duplicate requests and concurrent transfers.
- Inject crashes and network failures.
- Simulate Kafka and database failures.
- Verify financial invariants before and after recovery.
- Generate reports containing failure details and recovery results.

### Observability
- Collect application and system metrics.
- Track latency, throughput, errors, and consumer lag.
- Visualize metrics using Prometheus and Grafana.

### AI-Assisted Incident Analysis
- Analyze structured failure reports.
- Generate explanations of detected incidents.
- Ground conclusions in recorded system evidence.
- Never allow AI to modify financial records.

## 3. Non-Functional Requirements

- Financial correctness must be preserved.
- Transfers must be atomic and idempotent.
- The system must tolerate duplicate event delivery.
- The system must recover from supported failures.
- Components should be independently testable.
- Failures and recovery must be observable.
- The system should support concurrent workloads.
- All financial amounts must use integer paise.

## 4. Out of Scope

- Real-money transactions.
- Integration with real payment gateways.
- Email and notification services.
- Generic workflow engines.
- BullMQ or a separate job-queue framework.
- Multi-tenant API-key management.

## 5. Technology Stack

- Backend: Node.js, TypeScript, Express.js
- Database: PostgreSQL
- Event Streaming: Apache Kafka
- Frontend: React, TypeScript
- Testing: Vitest, Supertest
- Failure Injection: Toxiproxy
- Monitoring: Prometheus, Grafana
- Infrastructure: Docker Compose
- CI/CD: GitHub Actions
- AI: Local Ollama
