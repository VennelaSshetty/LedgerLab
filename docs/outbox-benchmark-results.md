
# Outbox Workload and Benchmark Results

## 1. Purpose

This document records the workload experiments performed to evaluate LedgerLab's transactional outbox under concurrent financial transfers, publisher unavailability and recovery.

These are correctness and recovery experiments, not throughput or latency performance benchmarks.

## 2. Workload configuration

Two workloads were executed using the existing deterministic workload generator.

| Configuration | Value |
|---|---:|
| Accounts | 10 |
| Transfer requests per workload | 500 |
| Concurrency | 25 |
| Minimum transfer amount | 100 paise |
| Maximum transfer amount | 100,000 paise |
| Invalid request percentage | 10% |
| Opening balance per account | 100,000,000 paise |

The generator uses different deterministic seeds for the two workloads.

## 3. Experiment 1: Baseline workload

**Purpose:** Establish normal-operation behaviour.

The first workload was executed with the publisher not intentionally paused.

| Measurement | Result |
|---|---:|
| Total requests | 500 |
| Successful requests | 450 |
| Confirmed committed transfers | 450 |
| Confirmed rejected requests | 50 |
| Unknown outcomes | 0 |

History file:

`backend/workloads/outbox-baseline-20261121.jsonl`

## 4. Experiment 2: Publisher outage

**Purpose:** Verify that financial transfers can continue while publication is paused.

A second workload of 500 requests was executed while the publisher remained paused.

| Measurement | Result |
|---|---:|
| Total requests | 500 |
| Confirmed committed transfers | 450 |
| Persisted outbox events | 450 |
| Pending events | 450 |

All 450 committed transfers had exactly one corresponding pending outbox event.

History file:

`backend/workloads/outbox-outage-20261122.jsonl`

This experiment simulated publisher unavailability by keeping publication paused. It did not attempt a failed transport publication.

## 5. Experiment 3: Publisher recovery

**Purpose:** Verify that accumulated events can be published after the publisher resumes.

The controlled transport was made available and the publisher processed the accumulated events in batches of 25.

| Measurement | Result |
|---|---:|
| Events accepted by transport | 450 |
| Events marked PUBLISHED | 450 |
| Publication failures | 0 |
| Lease losses | 0 |
| Pending events after recovery | 0 |
| Failed events after recovery | 0 |

All 450 accumulated events were accepted and marked as published.

## 6. Reconciliation results

The baseline and outage workloads produced 900 confirmed committed transfers in total.

The reconciliation test compared transfer records with their corresponding outbox records.

| Measurement | Result |
|---|---:|
| Confirmed committed transfers | 900 |
| Corresponding outbox events | 900 |
| Missing outbox events | 0 |
| Transfers with exactly one outbox event | 900 |
| Baseline events pending | 450 |
| Outage events published | 450 |

Each confirmed committed transfer had exactly one corresponding outbox event.

The integration test fixture cleans up its database records after the test suite. The JSONL workload histories remain available for inspection.

## 7. Independent financial invariant verification

The existing independent verifier was executed against the workload accounts.

| Invariant | Description | Result |
|---|---|---|
| I1 | Total money is conserved | PASS |
| I2 | Debits equal credits | PASS |
| I3 | No account has a negative balance | PASS |
| I5 | No partial transfers | PASS |
| I6 | Projection consistency | PASS |
| I4 | Acknowledged transfer exactly once | NOT VERIFIED |

I4 is not verified because acknowledgement-history verification is outside the scope of this phase.

## 8. Overall findings

The experiments demonstrate that:

- Both concurrent workloads completed with 450 confirmed commits each.
- Each committed transfer had a corresponding persisted outbox event.
- Financial transfers continued while publication was paused.
- Pending events accumulated during publisher unavailability.
- The publisher successfully processed all 450 accumulated events after recovery.
- No missing or duplicate outbox rows were found during reconciliation.
- All five applicable independent financial invariants passed.

## 9. Limitations

These experiments do not establish:

- Production broker throughput or latency.
- Consumer processing performance.
- Exactly-once message delivery.
- Exactly-once downstream business effects.
- Consumer-side deduplication.
- I4 verification.

The recovery experiment used a controlled transport rather than an external messaging broker.

The results demonstrate publisher-side reliability and financial consistency under the tested conditions, not production-scale performance.
