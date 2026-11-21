import type { PoolClient } from "pg";
import { pool } from "../db/pool";
import {
  RETRY_POLICY,
  calculateRetryDelayMs,
} from "./outbox-retry-policy";

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
  transferIds?: readonly string[],
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

    await client.query(
  `
  UPDATE outbox
  SET
    status = 'FAILED',
    locked_until = NULL,
    last_error = COALESCE(
      last_error,
      'Maximum attempts reached after publisher crash'
    )
  WHERE attempts >= $1
  AND (
    status = 'PENDING'
    OR (
      status = 'PROCESSING'
      AND locked_until <= NOW()
    )
  )
  AND ($2::uuid[] IS NULL OR transfer_id = ANY($2::uuid[]))
  `,
  [RETRY_POLICY.maxAttempts, transferIds ?? null],
);

    const result = await client.query<OutboxEvent>(
      `
      WITH candidates AS (
        SELECT id
        FROM outbox
WHERE
  (
    (
      status = 'PENDING'
      AND next_attempt_at <= NOW()
      AND attempts < $3
    )
    OR
    (
      status = 'PROCESSING'
      AND locked_until <= NOW()
      AND attempts < $3
    )
  )
  AND ($4::uuid[] IS NULL OR transfer_id = ANY($4::uuid[]))
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
      [batchSize, leaseSeconds, RETRY_POLICY.maxAttempts, transferIds ?? null],
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

  // attempts was already incremented when this event was claimed.
  const canRetry = event.attempts < RETRY_POLICY.maxAttempts;

  const retryDelayMs = canRetry
    ? calculateRetryDelayMs(event.attempts)
    : null;

  const result = await pool.query(
    `
    UPDATE outbox
    SET
      status = CASE
        WHEN $3 THEN 'PENDING'
        ELSE 'FAILED'
      END,
      next_attempt_at = CASE
        WHEN $3 THEN
          NOW() + ($4 * INTERVAL '1 millisecond')
        ELSE next_attempt_at
      END,
      locked_until = NULL,
      last_error = $5
    WHERE id = $1
      AND status = 'PROCESSING'
      AND attempts = $2
    `,
    [
      event.id,
      event.attempts,
      canRetry,
      retryDelayMs,
      message,
    ],
  );

  return result.rowCount === 1;
}


export async function publishOutboxBatch(
  transport: OutboxTransport,
  batchSize = 10,
  leaseSeconds = 30,
  transferIds?: readonly string[],
): Promise<PublishBatchResult> {
const events = await claimOutboxBatch(
  batchSize,
  leaseSeconds,
  transferIds,
);

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

export async function recoverFailedOutboxEvent(
  eventId: string,
): Promise<boolean> {
  const result = await pool.query(
    `
    UPDATE outbox
    SET
      status = 'PENDING',
      attempts = 0,
      next_attempt_at = NOW(),
      locked_until = NULL
    WHERE id = $1
      AND status = 'FAILED'
    `,
    [eventId],
  );

  return result.rowCount === 1;
}
