
# Naive Mode vs Safe Mode — Comparison Experiment Design

## 1. Objective

Compare Naive Mode and Safe Mode using the same seeded transfer workload and equivalent initial database state.

The experiment evaluates:
- Transfer execution outcomes.
- Financial correctness.
- Concurrency-related failures.
- Independent invariant verification.
- Execution performance.

The comparison must use actual database state rather than relying only on HTTP responses or execution history.

## 2. Workload Configuration

Use the existing seeded workload generator.

| Parameter | Value |
|---|---:|
| Seed | 12345 |
| Number of accounts | 10 |
| Total transfer requests | 100 |
| Invalid request percentage | 10% |
| Expected valid requests | 90 |
| Expected invalid requests | 10 |
| Minimum amount | 100 paise |
| Maximum amount | 100000 paise |
| Concurrency | 5 |

Generate the workload once and save it.

The exact generated requests must be reused for both modes. Do not generate a second workload for Safe Mode.

## 3. Initial Database State

Use an isolated set of 10 experiment accounts.

Each account starts with:

- Opening balance: 1000000000000 paise.
- A corresponding account_opening_balances record.
- A known account ID.

The initial account IDs and opening balances must remain equivalent across both runs.

Existing project data must not be modified.

## 4. Experiment Isolation

The experiment must operate only on its designated accounts.

The independent verifier will support an optional account-ID scope.

Scoped verification will include:

- I1: Total opening money versus current balances of experiment accounts.
- I2: Debit-credit equality for experiment ledger entries and their transfers.
- I3: Negative balances among experiment accounts.
- I5: Completeness and consistency of experiment transfers.
- I6: Projection consistency for experiment accounts.

I4 remains NOT VERIFIED because acknowledgement-history verification has not been implemented.

The existing full-database verification behaviour must remain available when no account scope is supplied.

## 5. Execution Order

### Run 1 — Naive Mode

1. Prepare the isolated experiment accounts.
2. Record their initial balances.
3. Execute the saved workload using Naive Mode.
4. Record execution history.
5. Capture final account balances.
6. Run the independent verifier with the experiment account IDs.
7. Preserve the execution results.

### Reset Between Runs

Restore the experiment to its original state before running Safe Mode.

The reset must:

- Remove only experiment-related transfer records.
- Remove only experiment-related ledger entries using the existing test cleanup mechanism.
- Remove experiment-related outbox and idempotency records.
- Restore the original account balances.
- Preserve the experiment account IDs and opening-balance baselines.

Do not truncate tables or delete unrelated users, accounts, transfers, or ledger records.

### Run 2 — Safe Mode

1. Confirm the experiment accounts match their original starting state.
2. Replay the exact saved workload using Safe Mode.
3. Record execution history separately.
4. Capture final account balances.
5. Run the independent verifier with the same experiment account IDs.
6. Preserve the execution results.

## 6. Results Collection

Collect the following for both modes:

| Measurement | Description |
|---|---|
| Successful requests | Transfers accepted successfully |
| Rejected requests | Requests rejected by validation or business rules |
| Failed requests | Requests that failed during execution |
| Unknown outcomes | Requests whose final outcome could not be established |
| Timeouts | Requests exceeding the configured timeout |
| Execution duration | Total workload execution time |
| Latency | Request latency measurements |
| Transfer count | Actual database transfer records |
| Ledger entries | Actual database ledger records |
| Final balances | Actual account balances |
| Invariant results | Independent verifier outcomes |

## 7. Comparison Rules

- Both runs must use identical generated request inputs.
- Both runs must start from equivalent account states.
- Both runs must use the same workload concurrency and timeout configuration.
- Execution histories must be stored separately.
- Verification must use the same experiment account IDs.
- Results must be based on actual observations.
- No invariant failure or success may be assumed in advance.

## 8. Expected Deliverables

The experiment will produce:

1. One saved seeded workload.
2. Naive Mode execution history.
3. Naive Mode verifier results.
4. Safe Mode execution history.
5. Safe Mode verifier results.
6. A final comparison of execution outcomes, performance, and invariant results.

## 9. Safety Constraints

- Use the existing LedgerLab PostgreSQL database inside Docker.
- Do not reset the entire database.
- Do not modify unrelated historical records.
- Preserve the existing full-database verifier.
- Use the existing workload generator, history recorder, fixtures, and cleanup helpers wherever possible.

## 10. Implementation Status

This document defines the comparison experiment.

The experiment has not yet been executed. Implementation changes required for scoped verification and workload execution will be completed before the actual comparison runs.
