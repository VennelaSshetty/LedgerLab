
# SAFE vs NAIVE Transfer Benchmark Report

## 1. Objective

Compare the performance of the SAFE and NAIVE transfer implementations using the same fixed workload.

The comparison evaluates request latency and execution outcomes across five runs for each implementation.

## 2. Benchmark Configuration

| Parameter | Value |
|---|---:|
| Random seed | 12345 |
| Requests per run | 100 |
| Concurrency | 5 |
| Number of runs per mode | 5 |
| Expected successful requests | 90 |
| Expected rejected requests | 10 |
| Minimum transfer amount | 100 paise |
| Maximum transfer amount | 100000 paise |

Both implementations used the same generated workload to keep the comparison consistent.

## 3. Benchmark Results

### SAFE implementation

| Run | P50 (ms) | P95 (ms) | P99 (ms) |
|---|---:|---:|---:|
| 1 | 77.4161 | 211.7562 | 606.5536 |
| 2 | 19.3036 | 40.1873 | 218.9691 |
| 3 | 17.8632 | 35.1269 | 123.8398 |
| 4 | 25.1012 | 47.1212 | 138.7161 |
| 5 | 17.7248 | 33.6139 | 136.4033 |
| **Average** | **31.4818** | **73.5608** | **244.8964** |

### NAIVE implementation

| Run | P50 (ms) | P95 (ms) | P99 (ms) |
|---|---:|---:|---:|
| 1 | 54.0619 | 133.5514 | 319.0477 |
| 2 | 32.1304 | 74.1116 | 150.5522 |
| 3 | 33.8269 | 86.1895 | 228.8407 |
| 4 | 30.6860 | 82.0285 | 159.2698 |
| 5 | 32.8466 | 81.2972 | 208.2976 |
| **Average** | **36.7102** | **91.4357** | **213.2016** |

## 4. Average Latency Comparison

| Metric | SAFE (ms) | NAIVE (ms) | Lower latency |
|---|---:|---:|---|
| P50 | 31.4818 | 36.7102 | SAFE |
| P95 | 73.5608 | 91.4357 | SAFE |
| P99 | 244.8964 | 213.2016 | NAIVE |

SAFE achieved lower average P50 and P95 latency. NAIVE recorded a lower average P99 latency.

The SAFE P99 average was affected by its first run, which recorded 606.5536 ms. Therefore, the results do not establish that either implementation is universally faster.

## 5. Request Outcome Comparison

Across all five runs, each implementation processed 500 requests.

| Outcome | SAFE | NAIVE |
|---|---:|---:|
| Successful requests | 450 | 450 |
| Rejected requests | 50 | 50 |
| Timeouts | 0 | 0 |
| Unknown outcomes | 0 | 0 |

Each run produced:

- 90 successful requests.
- 10 rejected requests.
- 0 timeouts.
- 0 unknown outcomes.

The transfer outcome records also reported 90 confirmed committed transfers and 10 confirmed not-committed transfers per run for both implementations.

## 6. Analysis

The benchmark demonstrates that the SAFE implementation performed better in average median and P95 latency under this workload.

However, the NAIVE implementation recorded a lower average P99 latency across the five runs. The first SAFE run had a substantially higher P99 value than its remaining runs, influencing its average.

Both implementations produced the expected request outcomes in all five runs. This comparison therefore provides an initial performance comparison under the selected workload, rather than proof of correctness under every concurrency condition.

The benchmark should not be interpreted as evidence that the NAIVE implementation is safe for financial transactions. Its purpose is to compare the implementations, including the concurrency-safety mechanisms provided by the SAFE implementation.

## 7. Limitations

- Only one workload configuration was evaluated.
- Each implementation was tested five times.
- The benchmark used 100 requests per run at concurrency 5.
- Results may vary with database state, system load, connection scheduling, and runtime warm-up.
- The comparison does not independently prove all six LedgerLab invariants. Those are covered by dedicated correctness and integration tests.

## 8. Conclusion

Under the tested workload, SAFE achieved lower average P50 and P95 latency, while NAIVE achieved lower average P99 latency.

Both implementations produced the expected request outcomes across all five runs. The results show that the SAFE implementation can maintain the expected transfer outcomes while delivering competitive latency in this benchmark.

The SAFE implementation remains the intended production-style implementation because its transaction and concurrency controls are designed to preserve financial correctness, not merely optimize response time.

## 9. Reproducibility

The consolidated measurements are stored in:

`backend/workloads/comparison-results-12345.json`

The fixed workload is stored in:

`backend/workloads/naive-comparison-workload-12345.json`

The individual execution histories are stored in:

- `backend/workloads/safe-comparison-history-12345.jsonl`
- `backend/workloads/naive-comparison-history-12345.jsonl`

The JSONL history files contain the most recent run written by the tests. The consolidated JSON file preserves the measurements from all five runs.
