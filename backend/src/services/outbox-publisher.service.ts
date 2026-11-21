
import type { PoolClient } from "pg";
import { pool } from "../db/pool";

export interface OutboxEvent {
  id: string;
  transfer_id: string;
  event_type: string;
  payload: unknown;
  attempts: number;
}

export interface OutboxTransport {
  publish(event: OutboxEvent): Promise<void>;
}

export interface PublishBatchResult {
  published: number;
  failed: number;
  leaseLost: number;
}

export async function claimOutboxBatch(
  batchSize = 10,
  leaseSeconds = 30,
): Promise<OutboxEvent[]> {
  if (!Number.isInteger(batchSize) || batchSize <= 0) {
    throw new Error("batchSize must be a positive integer");
  }

  if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
    throw new Error("leaseSeconds must be a positive integer");
  }

  const client: PoolClient = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query<OutboxEvent>(
      `
      WITH candidates AS (
        SELECT id
        FROM outbox
        WHERE
          (status = 'PENDING' AND next_attempt_at <= NOW())
          OR
          (status = 'PROCESSING' AND locked_until <= NOW())
        ORDER BY created_at ASC, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE outbox AS o
      SET
        status = 'PROCESSING',
        locked_until = NOW() + ($2 * INTERVAL '1 second'),
        attempts = o.attempts + 1
      FROM candidates AS c
      WHERE o.id = c.id
      RETURNING
        o.id,
        o.transfer_id,
        o.event_type,
        o.payload,
        o.attempts
      `,
      [batchSize, leaseSeconds],
    );

    await client.query("COMMIT");

    return result.rows;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function acknowledgeOutboxEvent(
  event: OutboxEvent,
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE outbox
    SET
      status = 'PUBLISHED',
      published_at = NOW(),
      locked_until = NULL,
      last_error = NULL
    WHERE id = $1
      AND status = 'PROCESSING'
      AND attempts = $2
    `,
    [event.id, event.attempts],
  );

  return result.rowCount === 1;
}

async function recordPublicationFailure(
  event: OutboxEvent,
  error: unknown,
): Promise<boolean> {
  const message =
    error instanceof Error ? error.message : String(error);

  const result = await pool.query(
    `
    UPDATE outbox
    SET
      status = 'PENDING',
      next_attempt_at = NOW(),
      locked_until = NULL,
      last_error = $3
    WHERE id = $1
      AND status = 'PROCESSING'
      AND attempts = $2
    `,
    [event.id, event.attempts, message],
  );

  return result.rowCount === 1;
}

export async function publishOutboxBatch(
  transport: OutboxTransport,
  batchSize = 10,
  leaseSeconds = 30,
): Promise<PublishBatchResult> {
  const events = await claimOutboxBatch(batchSize, leaseSeconds);

  const result: PublishBatchResult = {
    published: 0,
    failed: 0,
    leaseLost: 0,
  };

  for (const event of events) {
    try {
      await transport.publish(event);

      const marked = await acknowledgeOutboxEvent(event);

      if (marked) {
        result.published++;
      } else {
        result.leaseLost++;
      }
    } catch (error) {
      const recorded = await recordPublicationFailure(event, error);

      if (recorded) {
        result.failed++;
      } else {
        result.leaseLost++;
      }
    }
  }

  return result;
}
