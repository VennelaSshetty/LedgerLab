import type { HistoryRecord } from "./types";

export type HistoryIndexes = {
  byRequestId: Map<string, HistoryRecord[]>;
  byCorrelationId: Map<string, HistoryRecord[]>;
  byTransferId: Map<string, HistoryRecord[]>;
};

function addToIndex(
  index: Map<string, HistoryRecord[]>,
  key: string | null,
  record: HistoryRecord,
): void {
  if (key === null) {
    return;
  }

  const existing = index.get(key);

  if (existing) {
    existing.push(record);
  } else {
    index.set(key, [record]);
  }
}

export function buildHistoryIndexes(
  records: HistoryRecord[],
): HistoryIndexes {
  const indexes: HistoryIndexes = {
    byRequestId: new Map(),
    byCorrelationId: new Map(),
    byTransferId: new Map(),
  };

  for (const record of records) {
    addToIndex(
      indexes.byRequestId,
      record.requestId,
      record,
    );

    addToIndex(
      indexes.byCorrelationId,
      record.correlationId,
      record,
    );

    addToIndex(
      indexes.byTransferId,
      record.transferId,
      record,
    );
  }

  return indexes;
}