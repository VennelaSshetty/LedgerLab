import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
} from "vitest";
import { randomUUID } from "node:crypto";

import { adminPool } from "../helpers/admin-pool";
import { createTransfer } from "../../src/services/transfers.service";
import {
  claimOutboxBatch,
  publishOutboxBatch,
  acknowledgeOutboxEvent,
  recoverFailedOutboxEvent,
} from "../../src/services/outbox-publisher.service";
import { ControlledOutboxTransport } from "../helpers/controlled-outbox-transport";

let USER_ID: string;
let SENDER_ID: string;
let RECEIVER_ID: string;

async function createOutboxEvent() {
  const result = await createTransfer({
    fromAccountId: SENDER_ID,
    toAccountId: RECEIVER_ID,
    amountPaise: "1000",
    idempotencyKey: `outbox-test-${randomUUID()}`,
    correlationId: randomUUID(),
  });

  // Make this test event older than existing pending events,
  // so the batch claim selects it deterministically.
  await adminPool.query(
    `UPDATE outbox
     SET created_at = '1970-01-01T00:00:00Z'
     WHERE transfer_id = $1`,
    [result.transfer.id],
  );

  return result.transfer.id;
}

describe("Outbox publisher integration", () => {
  beforeEach(async () => {
    await adminPool.query(
  `UPDATE outbox
   SET
     status = 'PUBLISHED',
     published_at = COALESCE(published_at, NOW()),
     locked_until = NULL
   WHERE status IN ('PENDING', 'PROCESSING')`,
);

    USER_ID = randomUUID();
    SENDER_ID = randomUUID();
    RECEIVER_ID = randomUUID();

    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Outbox Test', $2, 'test-hash')`,
      [USER_ID, `outbox-test-${USER_ID}@ledgerlab.local`],
    );

    await adminPool.query(
      `INSERT INTO accounts (id, user_id, balance_paise)
       VALUES ($1, $3, 1000000), ($2, $3, 1000000)`,
      [SENDER_ID, RECEIVER_ID, USER_ID],
    );

    await adminPool.query(
      `INSERT INTO account_opening_balances (account_id, amount_paise)
       VALUES ($1, 1000000), ($2, 1000000)`,
      [SENDER_ID, RECEIVER_ID],
    );
  });

  afterAll(async () => {
    
  });

  it("claims a pending event and creates a processing lease", async () => {
    const transferId = await createOutboxEvent();

    const claimed = await claimOutboxBatch(1, 30);

    const event = claimed.find(
      (item) => item.transfer_id === transferId,
    );

    expect(event).toBeDefined();
    expect(event!.attempts).toBe(1);

    const stored = await adminPool.query(
      `SELECT status, locked_until, attempts
       FROM outbox
       WHERE transfer_id = $1`,
      [transferId],
    );

    expect(stored.rows[0].status).toBe("PROCESSING");
    expect(stored.rows[0].locked_until).not.toBeNull();
    expect(stored.rows[0].attempts).toBe(1);
  });

  it("allows concurrent publishers to claim different events", async () => {
    const firstTransferId = await createOutboxEvent();
    const secondTransferId = await createOutboxEvent();

    const [firstBatch, secondBatch] = await Promise.all([
      claimOutboxBatch(1, 30),
      claimOutboxBatch(1, 30),
    ]);

    const firstEvent = firstBatch[0];
    const secondEvent = secondBatch[0];

    expect(firstEvent).toBeDefined();
    expect(secondEvent).toBeDefined();

    expect(firstEvent.id).not.toBe(secondEvent.id);

    const claimedTransferIds = [
      firstEvent.transfer_id,
      secondEvent.transfer_id,
    ];

    expect(claimedTransferIds).toContain(firstTransferId);
    expect(claimedTransferIds).toContain(secondTransferId);
  });

  it("reclaims an event after its processing lease expires", async () => {
    const transferId = await createOutboxEvent();

    const firstBatch = await claimOutboxBatch(1, 30);

    const firstEvent = firstBatch.find(
      (item) => item.transfer_id === transferId,
    );

    expect(firstEvent).toBeDefined();
    expect(firstEvent!.attempts).toBe(1);

    await adminPool.query(
      `UPDATE outbox
       SET locked_until = NOW() - INTERVAL '1 second'
       WHERE transfer_id = $1`,
      [transferId],
    );

    const secondBatch = await claimOutboxBatch(1, 30);

    const reclaimedEvent = secondBatch.find(
      (item) => item.transfer_id === transferId,
    );

    expect(reclaimedEvent).toBeDefined();
    expect(reclaimedEvent!.id).toBe(firstEvent!.id);
    expect(reclaimedEvent!.attempts).toBe(2);
  });


  it("publishes an event and marks it as published after acknowledgement", async () => {
    const transferId = await createOutboxEvent();

    const publishedEvents: string[] = [];

    const result = await publishOutboxBatch({
      async publish(event) {
        publishedEvents.push(event.id);
      },
    }, 10, 30);

    expect(result.published).toBeGreaterThanOrEqual(1);
    expect(result.failed).toBe(0);
    expect(publishedEvents.length).toBeGreaterThanOrEqual(1);

    const stored = await adminPool.query(
      `SELECT status, published_at, locked_until, last_error
       FROM outbox
       WHERE transfer_id = $1`,
      [transferId],
    );

    expect(stored.rows[0].status).toBe("PUBLISHED");
    expect(stored.rows[0].published_at).not.toBeNull();
    expect(stored.rows[0].locked_until).toBeNull();
    expect(stored.rows[0].last_error).toBeNull();
  });


it("schedules a failed publication for a future retry", async () => {
  const transferId = await createOutboxEvent();

  const result = await publishOutboxBatch(
    {
      async publish() {
        throw new Error("Test transport unavailable");
      },
    },
    1,
    30,
  );

  expect(result.failed).toBe(1);

  const stored = await adminPool.query(
    `SELECT
       status,
       locked_until,
       last_error,
       attempts,
       next_attempt_at,
       NOW() AS database_now
     FROM outbox
     WHERE transfer_id = $1`,
    [transferId],
  );

  expect(stored.rows[0].status).toBe("PENDING");
  expect(stored.rows[0].locked_until).toBeNull();
  expect(stored.rows[0].last_error).toBe(
    "Test transport unavailable",
  );
  expect(stored.rows[0].attempts).toBe(1);

  const scheduledTime = new Date(
    stored.rows[0].next_attempt_at,
  ).getTime();

  const databaseNow = new Date(
    stored.rows[0].database_now,
  ).getTime();

  expect(scheduledTime).toBeGreaterThan(databaseNow);
  expect(scheduledTime - databaseNow).toBeGreaterThanOrEqual(500);
  expect(scheduledTime - databaseNow).toBeLessThanOrEqual(1000);

  // The retry is not eligible yet.
const prematureClaim = await claimOutboxBatch(1);

expect(
  prematureClaim.some(
    (event) => event.transfer_id === transferId,
  ),
).toBe(false);
});


  it("does not allow a stale publisher to overwrite a newer claim", async () => {
  const transferId = await createOutboxEvent();

  // Claim all available events so older test data cannot interfere.
  const firstBatch = await claimOutboxBatch(1000, 30);

  const firstEvent = firstBatch.find(
    (event) => event.transfer_id === transferId,
  );

  expect(firstEvent).toBeDefined();

  // Simulate the first publisher's lease expiring.
  await adminPool.query(
    `UPDATE outbox
     SET locked_until = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
    [firstEvent!.id],
  );

  // A second publisher reclaims the same event.
  const secondBatch = await claimOutboxBatch(1000, 30);

  const secondEvent = secondBatch.find(
    (event) => event.id === firstEvent!.id,
  );

  expect(secondEvent).toBeDefined();
  expect(secondEvent!.attempts).toBe(2);

  // The first publisher now acknowledges its old claim.
  const acknowledged = await acknowledgeOutboxEvent(firstEvent!);

  expect(acknowledged).toBe(false);

  // The newer publisher's claim must remain untouched.
  const stored = await adminPool.query(
    `SELECT status, attempts, locked_until
     FROM outbox
     WHERE id = $1`,
    [firstEvent!.id],
  );

  expect(stored.rows[0].status).toBe("PROCESSING");
  expect(stored.rows[0].attempts).toBe(2);
  expect(stored.rows[0].locked_until).not.toBeNull();
});

it("recovers and publishes an event left processing by a crashed publisher", async () => {
  const transferId = await createOutboxEvent();

  // Publisher 1 claims the event.
  const claimed = await claimOutboxBatch(1000, 30);

  const crashedEvent = claimed.find(
    (event) => event.transfer_id === transferId,
  );

  expect(crashedEvent).toBeDefined();

  if (!crashedEvent) {
    throw new Error("Expected publisher to claim the test event");
  }

  // Simulate a crash: no publish acknowledgement or failure update.
  // The event remains PROCESSING with its lease active.
  const immediateRetry = await claimOutboxBatch(1000, 30);

  expect(
    immediateRetry.some((event) => event.id === crashedEvent.id),
  ).toBe(false);

  // Simulate the lease expiring while the publisher is down.
  await adminPool.query(
    `
    UPDATE outbox
    SET locked_until = NOW() - INTERVAL '1 second'
    WHERE id = $1
    `,
    [crashedEvent.id],
  );

  // Publisher 2 reclaims and publishes the abandoned event.
  const publishedIds: string[] = [];

  const result = await publishOutboxBatch(
    {
      async publish(event) {
        publishedIds.push(event.id);
      },
    },
    1000,
    30,
  );

  expect(publishedIds).toContain(crashedEvent.id);
  expect(result.published).toBeGreaterThanOrEqual(1);

  const stored = await adminPool.query(
    `
    SELECT status, attempts, published_at, locked_until
    FROM outbox
    WHERE id = $1
    `,
    [crashedEvent.id],
  );

  expect(stored.rows[0].status).toBe("PUBLISHED");
  expect(stored.rows[0].attempts).toBe(2);
  expect(stored.rows[0].published_at).not.toBeNull();
  expect(stored.rows[0].locked_until).toBeNull();
});

  
it("redelivers the same event when the destination accepted it but the publisher crashed before acknowledgement", async () => {
  const transferId = await createOutboxEvent();

  // Publisher 1 claims the event.
  const firstBatch = await claimOutboxBatch(1000, 30);

  const firstEvent = firstBatch.find(
    (event) => event.transfer_id === transferId,
  );

  expect(firstEvent).toBeDefined();

  if (!firstEvent) {
    throw new Error("Expected publisher to claim the test event");
  }

  // Simulate destination acceptance.
  // The publisher crashes before acknowledging the event in PostgreSQL.
  const destinationAcceptedIds: string[] = [];
  destinationAcceptedIds.push(firstEvent.id);

  // PostgreSQL still considers the event PROCESSING.
  const afterCrash = await adminPool.query(
    `SELECT status, published_at, attempts
     FROM outbox
     WHERE id = $1`,
    [firstEvent.id],
  );

  expect(afterCrash.rows[0].status).toBe("PROCESSING");
  expect(afterCrash.rows[0].published_at).toBeNull();

  // Simulate the crashed publisher's lease expiring.
  await adminPool.query(
    `UPDATE outbox
     SET locked_until = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
    [firstEvent.id],
  );

  // Publisher 2 reclaims and sends the same event again.
  const secondDeliveryIds: string[] = [];

  const result = await publishOutboxBatch(
    {
      async publish(event) {
        secondDeliveryIds.push(event.id);
      },
    },
    1000,
    30,
  );

  expect(secondDeliveryIds).toContain(firstEvent.id);
  expect(result.published).toBeGreaterThanOrEqual(1);

  // The destination accepted the same event twice.
  const allDeliveries = [
    ...destinationAcceptedIds,
    ...secondDeliveryIds.filter((id) => id === firstEvent.id),
  ];

  expect(allDeliveries).toEqual([firstEvent.id, firstEvent.id]);

  // Duplicate event delivery must not create duplicate financial effects.
const transferCount = await adminPool.query(
  `SELECT COUNT(*)::int AS count
   FROM transfers
   WHERE id = $1`,
  [transferId],
);

const ledgerEntryCount = await adminPool.query(
  `SELECT COUNT(*)::int AS count
   FROM ledger_entries
   WHERE transfer_id = $1`,
  [transferId],
);

const outboxEventCount = await adminPool.query(
  `SELECT COUNT(*)::int AS count
   FROM outbox
   WHERE transfer_id = $1`,
  [transferId],
);

expect(transferCount.rows[0].count).toBe(1);
expect(ledgerEntryCount.rows[0].count).toBe(2);
expect(outboxEventCount.rows[0].count).toBe(1);

  const stored = await adminPool.query(
    `SELECT status, attempts, published_at, locked_until
     FROM outbox
     WHERE id = $1`,
    [firstEvent.id],
  );

  expect(stored.rows[0].status).toBe("PUBLISHED");
  expect(stored.rows[0].attempts).toBe(2);
  expect(stored.rows[0].published_at).not.toBeNull();
  expect(stored.rows[0].locked_until).toBeNull();
});

  
it("recovers an event after an ambiguous publication timeout", async () => {
  const transferId = await createOutboxEvent();

  // Simulate a destination that accepts the event,
  // but whose acknowledgement is lost due to a timeout.
  const destinationAcceptedIds: string[] = [];

 const firstResult = await publishOutboxBatch(
  {
    async publish(event) {
      destinationAcceptedIds.push(event.id);
      throw new Error("Publication acknowledgement timed out");
    },
  },
  1,
  30,
);

  expect(firstResult.failed).toBeGreaterThanOrEqual(1);

  const event = await adminPool.query(
    `SELECT id, status, attempts, published_at, locked_until, last_error
     FROM outbox
     WHERE transfer_id = $1`,
    [transferId],
  );

  expect(event.rows).toHaveLength(1);
  expect(event.rows[0].status).toBe("PENDING");
  expect(event.rows[0].attempts).toBe(1);
  expect(event.rows[0].published_at).toBeNull();
  expect(event.rows[0].locked_until).toBeNull();
  expect(event.rows[0].last_error).toBe(
    "Publication acknowledgement timed out",
  );

  // Simulate the scheduled retry time arriving.
// This avoids waiting for the real backoff delay in the test.
await adminPool.query(
  `UPDATE outbox
   SET next_attempt_at = NOW() - INTERVAL '1 second'
   WHERE id = $1`,
  [event.rows[0].id],
);

  // Publisher 2 retries the event successfully.
  const secondDeliveryIds: string[] = [];

  const secondResult = await publishOutboxBatch(
  {
    async publish(retryEvent) {
      secondDeliveryIds.push(retryEvent.id);
    },
  },
  1,
  30,
);

  expect(secondDeliveryIds).toContain(event.rows[0].id);
  expect(secondResult.published).toBeGreaterThanOrEqual(1);

  // The destination may have received the event twice.
  expect(destinationAcceptedIds).toEqual([event.rows[0].id]);
  expect(secondDeliveryIds).toContain(destinationAcceptedIds[0]);

  const stored = await adminPool.query(
    `SELECT status, attempts, published_at, locked_until
     FROM outbox
     WHERE id = $1`,
    [event.rows[0].id],
  );

  expect(stored.rows[0].status).toBe("PUBLISHED");
  expect(stored.rows[0].attempts).toBe(2);
  expect(stored.rows[0].published_at).not.toBeNull();
  expect(stored.rows[0].locked_until).toBeNull();
});

it("marks an exhausted event FAILED after its publisher lease expires", async () => {
  const transferId = await createOutboxEvent();

  // Simulate an event that has already used all five attempts.
  await adminPool.query(
    `
    UPDATE outbox
    SET
      status = 'PROCESSING',
      attempts = 5,
      locked_until = NOW() - INTERVAL '1 second',
      last_error = 'Previous publication failure'
    WHERE transfer_id = $1
    `,
    [transferId],
  );

  // The next publisher run should mark it FAILED.
  const claimed = await claimOutboxBatch(10, 30);

  expect(
    claimed.some((event) => event.transfer_id === transferId),
  ).toBe(false);

  const stored = await adminPool.query(
    `
    SELECT status, attempts, locked_until, last_error
    FROM outbox
    WHERE transfer_id = $1
    `,
    [transferId],
  );

  expect(stored.rows[0].status).toBe("FAILED");
  expect(stored.rows[0].attempts).toBe(5);
  expect(stored.rows[0].locked_until).toBeNull();
  expect(stored.rows[0].last_error).toBe(
    "Previous publication failure",
  );
});

it("recovers a FAILED event and resets its retry state", async () => {
  const transferId = await createOutboxEvent();

  const event = await adminPool.query(
    `SELECT id FROM outbox WHERE transfer_id = $1`,
    [transferId],
  );

  const eventId = event.rows[0].id;

  await adminPool.query(
    `
    UPDATE outbox
    SET
      status = 'FAILED',
      attempts = 5,
      next_attempt_at = NOW() - INTERVAL '1 minute',
      last_error = 'Maximum attempts reached'
    WHERE id = $1
    `,
    [eventId],
  );

  const recovered = await recoverFailedOutboxEvent(eventId);

  expect(recovered).toBe(true);

  const stored = await adminPool.query(
    `
    SELECT
      status,
      attempts,
      next_attempt_at,
      locked_until,
      last_error,
      NOW() AS database_now
    FROM outbox
    WHERE id = $1
    `,
    [eventId],
  );

  expect(stored.rows[0].status).toBe("PENDING");
  expect(stored.rows[0].attempts).toBe(0);
  expect(stored.rows[0].locked_until).toBeNull();
  expect(stored.rows[0].last_error).toBe(
    "Maximum attempts reached",
  );

  expect(
    new Date(stored.rows[0].next_attempt_at).getTime(),
  ).toBeLessThanOrEqual(
    new Date(stored.rows[0].database_now).getTime(),
  );
});

it("does not recover events that are not FAILED", async () => {
  const transferId = await createOutboxEvent();

  const event = await adminPool.query(
    `SELECT id FROM outbox WHERE transfer_id = $1`,
    [transferId],
  );

  const eventId = event.rows[0].id;

  // The event is still PENDING.
  expect(
    await recoverFailedOutboxEvent(eventId),
  ).toBe(false);

  // Claim it so that it becomes PROCESSING.
  const claimed = await claimOutboxBatch(1, 30);

  expect(claimed.some((item) => item.id === eventId)).toBe(true);

  expect(
    await recoverFailedOutboxEvent(eventId),
  ).toBe(false);

  // A PUBLISHED event must also be rejected.
  await adminPool.query(
    `
    UPDATE outbox
    SET status = 'PUBLISHED', published_at = NOW(),
        locked_until = NULL
    WHERE id = $1
    `,
    [eventId],
  );

  expect(
    await recoverFailedOutboxEvent(eventId),
  ).toBe(false);
});

it("persists a failed publication for retry when the destination is unavailable", async () => {
  const transferId = await createOutboxEvent();

  const transport = new ControlledOutboxTransport();
  transport.available = false;

  const result = await publishOutboxBatch(transport, 1, 30);

  expect(result.failed).toBe(1);
  expect(result.published).toBe(0);
  expect(transport.acceptedEvents).toHaveLength(0);

  const stored = await adminPool.query(
    `SELECT status, attempts, next_attempt_at,
            locked_until, last_error
     FROM outbox
     WHERE transfer_id = $1`,
    [transferId],
  );

  expect(stored.rows[0].status).toBe("PENDING");
  expect(stored.rows[0].attempts).toBe(1);
  expect(stored.rows[0].next_attempt_at).not.toBeNull();
  expect(stored.rows[0].locked_until).toBeNull();
  expect(stored.rows[0].last_error).toBe(
    "Test messaging destination unavailable",
  );
});

it("successfully commits a financial transfer while the destination is unavailable", async () => {
  const transport = new ControlledOutboxTransport();
  transport.available = false;

  // Create a financial transfer while the destination is down.
  const result = await createTransfer({
    fromAccountId: SENDER_ID,
    toAccountId: RECEIVER_ID,
    amountPaise: "2500",
    idempotencyKey: `outage-transfer-${randomUUID()}`,
    correlationId: randomUUID(),
  });

  expect(result.replayed).toBe(false);
  expect(result.transfer.status).toBe("COMPLETED");

  // Verify that the transfer committed.
  const transfer = await adminPool.query(
    `SELECT id, status, amount_paise
     FROM transfers
     WHERE id = $1`,
    [result.transfer.id],
  );

  expect(transfer.rows).toHaveLength(1);
  expect(transfer.rows[0].status).toBe("COMPLETED");
  expect(transfer.rows[0].amount_paise).toBe("2500");

  // Verify that its corresponding outbox event was committed too.
  const outbox = await adminPool.query(
    `SELECT id, status, transfer_id, event_type
     FROM outbox
     WHERE transfer_id = $1`,
    [result.transfer.id],
  );

  expect(outbox.rows).toHaveLength(1);
  expect(outbox.rows[0].transfer_id).toBe(result.transfer.id);
  expect(outbox.rows[0].event_type).toBe("TRANSFER_COMPLETED");
  expect(outbox.rows[0].status).toBe("PENDING");

  // The destination is unavailable, but the transfer succeeded.
  expect(transport.available).toBe(false);
  expect(transport.acceptedEvents).toHaveLength(0);
});

it("recovers unfinished events after a publisher crashes partway through a batch", async () => {
  // Create three independent financial transfers and outbox events.
await Promise.all([
  createOutboxEvent(),
  createOutboxEvent(),
  createOutboxEvent(),
]);

  // Publisher 1 claims all three events.
  const firstBatch = await claimOutboxBatch(3, 30);

  expect(firstBatch).toHaveLength(3);

  // Simulate successfully processing the first event.
  const completedEvent = firstBatch[0];

  const acknowledged = await acknowledgeOutboxEvent(completedEvent);

  expect(acknowledged).toBe(true);

  // The publisher crashes before processing the remaining events.
  const unfinishedEvents = firstBatch.slice(1);

  expect(unfinishedEvents).toHaveLength(2);

  // Verify the first event remains PUBLISHED.
  // The other two remain PROCESSING.
  const afterCrash = await adminPool.query(
    `SELECT id, status
     FROM outbox
     WHERE id = ANY($1::uuid[])`,
    [firstBatch.map((event) => event.id)],
  );

  const completedStored = afterCrash.rows.find(
    (event) => event.id === completedEvent.id,
  );

  expect(completedStored.status).toBe("PUBLISHED");

  for (const event of unfinishedEvents) {
    const stored = afterCrash.rows.find(
      (item) => item.id === event.id,
    );

    expect(stored.status).toBe("PROCESSING");
  }

  // Simulate the crashed publisher's leases expiring.
  for (const event of unfinishedEvents) {
    await adminPool.query(
      `UPDATE outbox
       SET locked_until = NOW() - INTERVAL '1 second'
       WHERE id = $1`,
      [event.id],
    );
  }

  // Publisher 2 reclaims and publishes the unfinished events.
  const transport = new ControlledOutboxTransport();

  const result = await publishOutboxBatch(transport, 1000, 30);

expect(result.published).toBeGreaterThanOrEqual(2);
expect(result.failed).toBe(0);

// Both unfinished events must be delivered by Publisher 2.
// Other eligible events may also be picked up during the full test suite.
const recoveredEventIds = transport.acceptedEvents.map(
  (event) => event.id,
);

for (const event of unfinishedEvents) {
  expect(recoveredEventIds).toContain(event.id);
}

  // The first event must remain PUBLISHED.
  const finalStates = await adminPool.query(
    `SELECT id, status, attempts, locked_until
     FROM outbox
     WHERE id = ANY($1::uuid[])`,
    [firstBatch.map((event) => event.id)],
  );

  const firstFinal = finalStates.rows.find(
    (event) => event.id === completedEvent.id,
  );

  expect(firstFinal.status).toBe("PUBLISHED");
  expect(firstFinal.attempts).toBe(1);

  // Both unfinished events must now be PUBLISHED.
  for (const event of unfinishedEvents) {
    const stored = finalStates.rows.find(
      (item) => item.id === event.id,
    );

    expect(stored.status).toBe("PUBLISHED");
    expect(stored.attempts).toBe(2);
    expect(stored.locked_until).toBeNull();
  }
});

it("resumes publishing and delivers pending events after the destination is restored", async () => {
  const transferId = await createOutboxEvent();

  const transport = new ControlledOutboxTransport();

  // 1. Simulate a destination outage.
  transport.available = false;

  // 2. Publisher attempts delivery, but publication fails.
  const outageResult = await publishOutboxBatch(transport, 1, 30);

  expect(outageResult.failed).toBe(1);
  expect(outageResult.published).toBe(0);
  expect(transport.acceptedEvents).toHaveLength(0);

  // 3. Verify the event is safely stored for retry.
  const afterOutage = await adminPool.query(
    `SELECT id, status, attempts, next_attempt_at
     FROM outbox
     WHERE transfer_id = $1`,
    [transferId],
  );

  expect(afterOutage.rows).toHaveLength(1);
  expect(afterOutage.rows[0].status).toBe("PENDING");
  expect(afterOutage.rows[0].attempts).toBe(1);

  const eventId = afterOutage.rows[0].id;

  // 4. Simulate the retry time arriving.
  // Avoid waiting for the actual backoff delay.
  await adminPool.query(
    `UPDATE outbox
     SET next_attempt_at = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
    [eventId],
  );

  // 5. Restore the messaging destination.
  transport.available = true;

  // 6. Resume the publisher.
  const recoveryResult = await publishOutboxBatch(
    transport,
    1,
    30,
  );

  expect(recoveryResult.published).toBe(1);
  expect(recoveryResult.failed).toBe(0);

  // 7. Verify that the destination accepted the event.
  expect(transport.acceptedEvents).toHaveLength(1);
  expect(transport.acceptedEvents[0].id).toBe(eventId);

  // 8. Verify the final database state.
  const finalState = await adminPool.query(
    `SELECT status, attempts, published_at, locked_until
     FROM outbox
     WHERE id = $1`,
    [eventId],
  );

  expect(finalState.rows[0].status).toBe("PUBLISHED");
  expect(finalState.rows[0].attempts).toBe(2);
  expect(finalState.rows[0].published_at).not.toBeNull();
  expect(finalState.rows[0].locked_until).toBeNull();
});

it("recovers and successfully publishes an event after repeated destination failures", async () => {
  const transferId = await createOutboxEvent();

  const transport = new ControlledOutboxTransport();
  transport.available = false;

  const eventResult = await adminPool.query(
    `SELECT id FROM outbox WHERE transfer_id = $1`,
    [transferId],
  );

  const eventId = eventResult.rows[0].id;

  // Keep the destination unavailable across all five attempts.
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = await publishOutboxBatch(transport, 1, 30);

    expect(result.failed).toBe(1);
    expect(result.published).toBe(0);

    const stored = await adminPool.query(
      `SELECT status, attempts, next_attempt_at
       FROM outbox
       WHERE id = $1`,
      [eventId],
    );

    expect(stored.rows[0].attempts).toBe(attempt);

    if (attempt < 5) {
      expect(stored.rows[0].status).toBe("PENDING");

      // Make the next retry eligible without waiting.
      await adminPool.query(
        `UPDATE outbox
         SET next_attempt_at = NOW() - INTERVAL '1 second'
         WHERE id = $1`,
        [eventId],
      );
    } else {
      expect(stored.rows[0].status).toBe("FAILED");
    }
  }

  // The event has exhausted its automatic retries.
  expect(transport.acceptedEvents).toHaveLength(0);

  // Restore the destination.
  transport.available = true;

  // Explicitly recover the FAILED event.
  const recovered = await recoverFailedOutboxEvent(eventId);

  expect(recovered).toBe(true);

  // Publish the recovered event.
  const recoveryResult = await publishOutboxBatch(transport, 1, 30);

  expect(recoveryResult.published).toBe(1);
  expect(recoveryResult.failed).toBe(0);

  expect(transport.acceptedEvents).toHaveLength(1);
  expect(transport.acceptedEvents[0].id).toBe(eventId);

  // Verify the final state.
  const finalState = await adminPool.query(
    `SELECT status, attempts, published_at, locked_until
     FROM outbox
     WHERE id = $1`,
    [eventId],
  );

  expect(finalState.rows[0].status).toBe("PUBLISHED");
  expect(finalState.rows[0].attempts).toBe(1);
  expect(finalState.rows[0].published_at).not.toBeNull();
  expect(finalState.rows[0].locked_until).toBeNull();
});

it("verifies that all outbox events remain in known states after recovery scenarios", async () => {
  // EVENT 1: Recover an event with an expired publisher lease.
  const expiredTransferId = await createOutboxEvent();

  const initialClaim = await claimOutboxBatch(1, 30);

  const expiredEvent = initialClaim.find(
    (event) => event.transfer_id === expiredTransferId,
  );

  expect(expiredEvent).toBeDefined();

  if (!expiredEvent) {
    throw new Error("Expected publisher to claim the event");
  }

  // Simulate publisher crash and lease expiration.
  await adminPool.query(
    `UPDATE outbox
     SET locked_until = NOW() - INTERVAL '1 second'
     WHERE id = $1`,
    [expiredEvent.id],
  );

  // Another publisher recovers and successfully publishes it.
  const recoveryTransport = new ControlledOutboxTransport();

  const leaseRecovery = await publishOutboxBatch(
    recoveryTransport,
    1,
    30,
  );

  expect(leaseRecovery.published).toBe(1);
  expect(recoveryTransport.acceptedEvents).toHaveLength(1);

  // EVENT 2: Keep an event safely scheduled after a destination outage.
  const retryTransferId = await createOutboxEvent();

  const unavailableTransport = new ControlledOutboxTransport();
  unavailableTransport.available = false;

  const outageResult = await publishOutboxBatch(
    unavailableTransport,
    1,
    30,
  );

  expect(outageResult.failed).toBe(1);

  // EVENT 3: Exhaust the retry attempts and reach FAILED.
  const failedTransferId = await createOutboxEvent();

  const failedEventResult = await adminPool.query(
    `SELECT id FROM outbox WHERE transfer_id = $1`,
    [failedTransferId],
  );

  const failedEventId = failedEventResult.rows[0].id;

  await adminPool.query(
    `UPDATE outbox
     SET
       status = 'PROCESSING',
       attempts = 5,
       locked_until = NOW() - INTERVAL '1 second',
       last_error = 'Maximum attempts reached'
     WHERE id = $1`,
    [failedEventId],
  );

  const exhaustedClaim = await claimOutboxBatch(1, 30);

  expect(
    exhaustedClaim.some((event) => event.id === failedEventId),
  ).toBe(false);

  // EVENT 4: Publish another event successfully.
  const publishedTransferId = await createOutboxEvent();

  const normalTransport = new ControlledOutboxTransport();

  const normalResult = await publishOutboxBatch(
    normalTransport,
    1,
    30,
  );

  expect(normalResult.published).toBe(1);

  // Verify that every test event still exists.
  const transferIds = [
    expiredTransferId,
    retryTransferId,
    failedTransferId,
    publishedTransferId,
  ];

  const finalEvents = await adminPool.query(
    `SELECT
       id,
       transfer_id,
       status,
       attempts,
       next_attempt_at,
       locked_until,
       published_at,
       last_error,
       NOW() AS database_now
     FROM outbox
     WHERE transfer_id = ANY($1::uuid[])`,
    [transferIds],
  );

  expect(finalEvents.rows).toHaveLength(4);

  const byTransferId = new Map(
    finalEvents.rows.map((event) => [event.transfer_id, event]),
  );

  // F1 and F2: Every event exists and has a known final state.
  for (const transferId of transferIds) {
    const event = byTransferId.get(transferId);

    expect(event).toBeDefined();

    expect([
      "PENDING",
      "PROCESSING",
      "PUBLISHED",
      "FAILED",
    ]).toContain(event.status);
  }

  // F3: The expired lease must not remain stuck in PROCESSING.
  const recoveredEvent = byTransferId.get(expiredTransferId);

  expect(recoveredEvent.status).toBe("PUBLISHED");
  expect(recoveredEvent.locked_until).toBeNull();

  // F4: Successfully published events remain PUBLISHED.
  const publishedEvent = byTransferId.get(publishedTransferId);

  expect(publishedEvent.status).toBe("PUBLISHED");
  expect(publishedEvent.published_at).not.toBeNull();

  // F5: Retryable event remains safely scheduled.
  const retryEvent = byTransferId.get(retryTransferId);

  expect(retryEvent.status).toBe("PENDING");
  expect(retryEvent.attempts).toBe(1);
  expect(retryEvent.next_attempt_at).not.toBeNull();
  expect(retryEvent.locked_until).toBeNull();

  expect(
    new Date(retryEvent.next_attempt_at).getTime(),
  ).toBeGreaterThan(
    new Date(retryEvent.database_now).getTime(),
  );

  // F6: Exhausted event remains FAILED until explicitly recovered.
  const failedEvent = byTransferId.get(failedTransferId);

  expect(failedEvent.status).toBe("FAILED");
  expect(failedEvent.attempts).toBe(5);
  expect(failedEvent.last_error).toBe("Maximum attempts reached");

  // Another normal publisher run must not claim the FAILED event.
  const anotherClaim = await claimOutboxBatch(10, 30);

  expect(
    anotherClaim.some((event) => event.id === failedEventId),
  ).toBe(false);

  const failedAfterClaim = await adminPool.query(
    `SELECT status, attempts
     FROM outbox
     WHERE id = $1`,
    [failedEventId],
  );

  expect(failedAfterClaim.rows[0].status).toBe("FAILED");
  expect(failedAfterClaim.rows[0].attempts).toBe(5);
});

});
