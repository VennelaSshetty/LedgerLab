import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import type { HistoryRecord } from "./types";

export type HistoryWriter = {
  write(record: HistoryRecord): Promise<void>;
  close(): Promise<void>;
};

export async function createHistoryWriter(
  filePath: string,
): Promise<HistoryWriter> {
  if (!filePath.trim()) {
    throw new Error("History file path cannot be empty.");
  }

  // Ensure the destination directory exists.
  await mkdir(dirname(filePath), { recursive: true });

  // Append mode preserves history from previous runs.
  const file = await open(filePath, "a");

  // Every write is chained onto this promise.
  let pendingWrites: Promise<void> = Promise.resolve();

  let closing = false;
  let closePromise: Promise<void> | null = null;

  function write(record: HistoryRecord): Promise<void> {
    if (closing) {
      return Promise.reject(
        new Error("Cannot write to a closed history writer."),
      );
    }

    const serialized = JSON.stringify(record);

    if (serialized === undefined) {
      return Promise.reject(
        new Error("History record could not be serialized."),
      );
    }

    const line = `${serialized}\n`;

    const operation = pendingWrites.then(async () => {
      await file.writeFile(line, { encoding: "utf8" });
    });

    // Keep the queue usable even if an individual write fails.
    pendingWrites = operation.catch(() => undefined);

    // The caller still receives the original write failure.
    return operation;
  }

  function close(): Promise<void> {
    if (closePromise) {
      return closePromise;
    }

    closing = true;

    closePromise = (async () => {
      // Wait until all queued writes have settled.
      await pendingWrites;

      // Release the file handle.
      await file.close();
    })();

    return closePromise;
  }

  return {
    write,
    close,
  };
}