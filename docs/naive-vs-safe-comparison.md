
## 10. Implementation Status and Experimental Results

### 10.1 Execution Status

The seeded comparison workload was executed successfully against both modes.

| Property | Result |
|---|---|
| Workload seed | 12345 |
| Accounts | 10 |
| Requests | 100 |
| Valid requests | 90 |
| Invalid requests | 10 |
| Concurrency | 5 |
| Initial balance per account | 1000000000000 paise |
| Workload reused | Yes |

The same saved workload was used for both executions.

### 10.2 Execution Outcomes

| Measurement | Naive Mode | Safe Mode |
|---|---:|---:|
| Total requests | 100 | 100 |
| Successful requests | 90 | 90 |
| Failed requests | 10 | 10 |
| Timeouts | 0 | 0 |
| Unknown outcomes | 0 | 0 |
| Confirmed committed transfers | 90 | 90 |
| Confirmed not committed | 10 | 10 |
| Unknown transfer outcomes | 0 | 0 |

### 10.3 Performance Results

Latency measurements are in milliseconds.

| Percentile | Naive Mode | Safe Mode |
|---|---:|---:|
| P50 | 42.0597 | 79.7657 |
| P95 | 112.5877 | 203.9682 |
| P99 | 211.2062 | 250.4915 |

Safe Mode exhibited higher latency in this particular 100-request execution.

This single experiment is not sufficient to establish general performance characteristics.

### 10.4 Scoped Invariant Verification

The scoped verifier was executed against the Safe Mode database state, using the ten experiment accounts.

| Invariant | Safe Mode Result |
|---|---|
| I1 - Total money conservation | PASS |
| I2 - Debit-credit equality | PASS |
| I3 - No negative balances | PASS |
| I4 - Acknowledged exactly once | NOT VERIFIED |
| I5 - No partial transfers | PASS |
| I6 - Projection consistency | PASS |

Additional observations:

- Opening total: 10000000000000 paise.
- Current total: 10000000000000 paise.
- Total debits: 4228591 paise.
- Total credits: 4228591 paise.
- Negative balances: 0.
- Invalid or partial transfers: 0.
- Inconsistent account projections: 0.

I4 remains NOT VERIFIED because acknowledgement-history recording has not been implemented.

Naive Mode invariant results have not yet been independently verified. Therefore, no Naive Mode invariant result is claimed.

### 10.5 Execution Artifacts

The following artifacts were generated:

- `workloads/naive-comparison-workload-12345.json`
- `workloads/naive-comparison-history-12345.jsonl`
- `workloads/safe-comparison-history-12345.jsonl`
- `src/verifier/verify-comparison.ts`

The scoped comparison verifier does not replace or modify the existing full-database verifier.

### 10.6 Limitations

1. The experiment uses one workload seed and one execution per mode.
2. Latency measurements are specific to this execution and environment.
3. Naive Mode has not yet received a separate scoped invariant verification.
4. I4 remains unverified in both modes.
5. The invariant results currently establish the Safe Mode database state only.

### 10.7 Current Conclusion

Both modes completed the same seeded workload with 90 successful and 10 failed requests.

Safe Mode exhibited higher observed latency in this run. Its final database state passed I1, I2, I3, I5 and I6 under scoped independent verification.

A complete correctness comparison requires independent verification of the Naive Mode state as well.
