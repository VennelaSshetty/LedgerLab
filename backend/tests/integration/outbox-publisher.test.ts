import {
  describe,
  it,
  expect,
  beforeEach,
  afterAll,
} from "vitest";
import { randomUUID } from "node:crypto";

import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";
import { createTransfer } from "../../src/services/transfers.service";
import {
  claimOutboxBatch,
  publishOutboxBatch,
  acknowledgeOutboxEvent,
} from "../../src/services/outbox-publisher.service";

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

  it("records a failed publication and releases the lease", async () => {
    const transferId = await createOutboxEvent();

    const result = await publishOutboxBatch({
      async publish() {
        throw new Error("Test transport unavailable");
      },
    }, 10, 30);

    expect(result.failed).toBeGreaterThanOrEqual(1);

    const stored = await adminPool.query(
      `SELECT status, locked_until, last_error, attempts
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

});
