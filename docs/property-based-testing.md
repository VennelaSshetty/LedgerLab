
# Property-Based Testing

## 1. Purpose

LedgerLab uses fast-check to generate varied transfer inputs and verify
transfer correctness beyond individually written example-based tests.

The tests cover:

- Input generation and validation
- Transfer arithmetic
- Database-backed transfer behaviour
- Idempotency and failure atomicity
- Randomized concurrent transfers
- Shrinking and reproducibility

## 2. Testing infrastructure

- Property-testing library: fast-check 4.10.2
- Test runner: Vitest 5.1.0
- Database: PostgreSQL 17
- API: Safe Mode POST /api/transfers
- Monetary representation: bigint / paise
- Database fixtures: isolated users and accounts
- Database inspection: adminPool
- Cleanup: scoped fixture cleanup

Property-test configuration is located at:

tests/helpers/property-test-config.ts

Environment variables:

- FC_SEED: controls the random seed.
- FC_NUM_RUNS: controls the number of generated runs.
- FC_PATH: replays a previously reported shrink path.

Default seed: 20261118
Default number of runs: 100

## 3. Test files

### Unit tests

1. transfer-arbitraries.test.ts
   - PostgreSQL BIGINT balance boundaries
   - Positive transfer amounts
   - Distinct account identifiers
   - Idempotency keys
   - Account statuses
   - Valid and invalid transfer inputs

2. transfer-properties.test.ts
   - Money conservation
   - Transfer arithmetic
   - Insufficient funds
   - Exact-balance transfers
   - Invalid amounts
   - Receiver balance overflow

3. property-testing.test.ts
   - Automatic shrinking
   - Minimal counterexample verification
   - Seed-based reproducibility
   - Shrink-path replay

### Integration tests

4. transfer-properties.test.ts
   - Generated sequential transfers
   - Actual Safe Mode HTTP requests
   - Expected outcomes compared with a reference model
   - PostgreSQL balance verification
   - Ledger and outbox verification

5. idempotency-failure-properties.test.ts
   - Identical duplicate requests
   - Idempotency key reuse with different request details
   - Malformed and nonexistent account IDs
   - Frozen sender and receiver accounts
   - Insufficient funds
   - Same-account transfers
   - Verification of rejected-request atomicity

6. transfer-concurrency-properties.test.ts
   - Simultaneous generated transfers
   - Money conservation
   - Non-negative balances
   - Debit-credit equality
   - Transfer and ledger consistency
   - Projection consistency
   - Idempotency and outbox records

## 4. Invariants verified

| Invariant | Verification |
|---|---|
| I1 | Total account balances remain constant |
| I2 | Total debits equal total credits |
| I3 | Account balances never become negative |
| I4 | Acknowledged transfers correspond to unique transfer records |
| I5 | Successful transfers have complete debit-credit ledger entries |
| I6 | Account balance projections match ledger-derived balances |

## 5. Reproducibility

Example execution:

    $env:NODE_ENV="test"
    $env:NAIVE_MODE_ENABLED="false"
    $env:FC_SEED="123456"
    $env:FC_NUM_RUNS="50"

    npx vitest run tests/integration/transfer-concurrency-properties.test.ts

For a previously reported failure, preserve:

- Test name
- Seed
- Number of runs
- Shrink path
- Counterexample
- Error output

To replay a saved failure, also set FC_PATH to its reported
counterexample path.

Note: a fixed seed reproduces generated inputs. Database concurrency
scheduling can still vary between executions.

## 6. Combined execution

The six property-testing files were executed together using:

    $env:NODE_ENV="test"
    $env:NAIVE_MODE_ENABLED="false"
    $env:FC_NUM_RUNS="50"

    npx vitest run `
      tests/unit/transfer-arbitraries.test.ts `
      tests/unit/transfer-properties.test.ts `
      tests/unit/property-testing.test.ts `
      tests/integration/transfer-properties.test.ts `
      tests/integration/idempotency-failure-properties.test.ts `
      tests/integration/transfer-concurrency-properties.test.ts

## 7. Verification results

Date: 18 November 2026

- Test files passed: 6/6
- Vitest tests passed: 20/20
- Generated integration runs: 150
- Sequential generated transfer operations: 1,000
- Generated failure/idempotency HTTP requests: 500
- Concurrent transfer requests: 1,000
- Combined execution time: 37.05 seconds
- Failures: 0

All six property-testing files passed in the combined run.

## 8. Limitations

- Randomized concurrency tests verify final database invariants;
  they do not guarantee every possible database scheduling order.
- Seed reproducibility reproduces generated inputs, but concurrent
  request scheduling may differ.
- The reference model is a test-side model, not an independent
  formal verification of the production implementation.
- These results do not establish that every possible transfer
  sequence is correct.
- The combined run covers the property-testing suite, not every
  backend test.

## 9. Conclusion

The property-based testing suite successfully exercises generated
transfer inputs, database-backed operations, idempotency failures,
and concurrent transfers.

The combined run passed all 20 Vitest tests across six test files.
