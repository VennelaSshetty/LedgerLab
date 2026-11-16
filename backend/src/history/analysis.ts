
import type { HistoryRecord, RequestOutcome, TransferOutcome } from "./types";
import type { HistoryIndexes } from "./indexes";

export type HistoryOutcomeSummary = {
  totalRecords: number;
  requestOutcomes: Record<RequestOutcome, number>;
  transferOutcomes: Record<TransferOutcome, number>;
};

export type CorrelationAttemptGroup = {
  correlationId: string;
  attemptCount: number;
  attempts: HistoryRecord[];
};

export type LatencyPercentiles = {
  sampleCount: number;
  p50: number | null;
  p95: number | null;
  p99: number | null;
};

function compareRecordsAscending(
  first: HistoryRecord,
  second: HistoryRecord,
): number {
  if (first.durationMs !== second.durationMs) {
    return first.durationMs - second.durationMs;
  }

  if (first.requestId < second.requestId) return -1;
  if (first.requestId > second.requestId) return 1;
  return 0;
}

/**
 * Counts request and transfer outcomes in one pass.
 * Time: O(n), Space: O(1).
 */
export function summarizeOutcomes(
  records: HistoryRecord[],
): HistoryOutcomeSummary {
  const requestOutcomes: Record<RequestOutcome, number> = {
    SUCCESS: 0,
    FAILURE: 0,
    TIMEOUT: 0,
    UNKNOWN: 0,
  };

  const transferOutcomes: Record<TransferOutcome, number> = {
    CONFIRMED_COMMITTED: 0,
    CONFIRMED_NOT_COMMITTED: 0,
    UNKNOWN: 0,
  };

  for (const record of records) {
    requestOutcomes[record.outcome] += 1;
    transferOutcomes[record.transferOutcome] += 1;
  }

  return {
    totalRecords: records.length,
    requestOutcomes,
    transferOutcomes,
  };
}

/**
 * Groups attempts belonging to the same logical transfer.
 * Reuses the existing correlation index.
 *
 * Attempts are ordered by request start time.
 * Time: O(n + g log g + sorting within groups).
 */
export function groupAttemptsByCorrelationId(
  indexes: HistoryIndexes,
): CorrelationAttemptGroup[] {
  return Array.from(
    indexes.byCorrelationId.entries(),
    ([correlationId, attempts]) => {
      const orderedAttempts = [...attempts].sort((first, second) => {
        const timeDifference =
          Date.parse(first.requestStartedAt) -
          Date.parse(second.requestStartedAt);

        if (timeDifference !== 0) {
          return timeDifference;
        }

        return compareRecordsAscending(first, second);
      });

      return {
        correlationId,
        attemptCount: orderedAttempts.length,
        attempts: orderedAttempts,
      };
    },
  );
}

/**
 * Calculates nearest-rank latency percentiles.
 * Time: O(n log n), Space: O(n).
 */
export function calculateLatencyPercentiles(
  records: HistoryRecord[],
): LatencyPercentiles {
  if (records.length === 0) {
    return {
      sampleCount: 0,
      p50: null,
      p95: null,
      p99: null,
    };
  }

  const durations = records
    .map((record) => record.durationMs)
    .sort((first, second) => first - second);

  function percentile(percent: number): number {
    const rank = Math.ceil((percent / 100) * durations.length);
    return durations[Math.max(0, rank - 1)];
  }

  return {
    sampleCount: durations.length,
    p50: percentile(50),
    p95: percentile(95),
    p99: percentile(99),
  };
}

/**
 * Compares records by duration, then request ID.
 * Lower duration has higher priority in the min-heap.
 */
function compareHeapPriority(
  first: HistoryRecord,
  second: HistoryRecord,
): number {
  return compareRecordsAscending(first, second);
}

class HistoryMinHeap {
  private readonly items: HistoryRecord[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): HistoryRecord | undefined {
    return this.items[0];
  }

  push(record: HistoryRecord): void {
    this.items.push(record);

    let index = this.items.length - 1;

    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);

      if (
        compareHeapPriority(
          this.items[index],
          this.items[parentIndex],
        ) >= 0
      ) {
        break;
      }

      [this.items[index], this.items[parentIndex]] = [
        this.items[parentIndex],
        this.items[index],
      ];

      index = parentIndex;
    }
  }

  pop(): HistoryRecord | undefined {
    if (this.items.length === 0) {
      return undefined;
    }

    const minimum = this.items[0];
    const last = this.items.pop();

    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      this.siftDown(0);
    }

    return minimum;
  }

  private siftDown(startIndex: number): void {
    let index = startIndex;

    while (true) {
      const leftIndex = 2 * index + 1;
      const rightIndex = 2 * index + 2;

      let smallestIndex = index;

      if (
        leftIndex < this.items.length &&
        compareHeapPriority(
          this.items[leftIndex],
          this.items[smallestIndex],
        ) < 0
      ) {
        smallestIndex = leftIndex;
      }

      if (
        rightIndex < this.items.length &&
        compareHeapPriority(
          this.items[rightIndex],
          this.items[smallestIndex],
        ) < 0
      ) {
        smallestIndex = rightIndex;
      }

      if (smallestIndex === index) {
        break;
      }

      [this.items[index], this.items[smallestIndex]] = [
        this.items[smallestIndex],
        this.items[index],
      ];

      index = smallestIndex;
    }
  }
}

/**
 * Returns the K slowest requests using a min-heap.
 * Time: O(n log k), Space: O(k), excluding the output.
 */
export function findSlowestRequests(
  records: HistoryRecord[],
  k: number,
): HistoryRecord[] {
  if (!Number.isInteger(k) || k < 0) {
    throw new Error("k must be a non-negative integer.");
  }

  if (k === 0 || records.length === 0) {
    return [];
  }

  const heap = new HistoryMinHeap();

  for (const record of records) {
    if (heap.size < k) {
      heap.push(record);
      continue;
    }

    const minimum = heap.peek();

    if (
      minimum !== undefined &&
      compareHeapPriority(record, minimum) > 0
    ) {
      heap.pop();
      heap.push(record);
    }
  }

  const slowest: HistoryRecord[] = [];

  while (heap.size > 0) {
    const record = heap.pop();

    if (record !== undefined) {
      slowest.push(record);
    }
  }

 return slowest.sort((first, second) => {
  if (first.durationMs !== second.durationMs) {
    return second.durationMs - first.durationMs;
  }

  if (first.requestId < second.requestId) {
    return -1;
  }

  if (first.requestId > second.requestId) {
    return 1;
  }

  return 0;
});
}
