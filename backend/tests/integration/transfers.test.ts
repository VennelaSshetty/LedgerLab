
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

let USER_ID: string;
let SENDER_ID: string;
let RECEIVER_ID: string;

describe("Transfer service integration", () => {
  // Create fresh database fixtures before every test.
  beforeEach(async () => {
    USER_ID = randomUUID();
    SENDER_ID = randomUUID();
    RECEIVER_ID = randomUUID();

    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Transfer Test', $2, 'test-hash')`,
      [USER_ID, `transfer-test-${USER_ID}@ledgerlab.local`]
    );

    await adminPool.query(
      `INSERT INTO accounts (id, user_id, balance_paise)
       VALUES ($1, $3, 50000), ($2, $3, 10000)`,
      [SENDER_ID, RECEIVER_ID, USER_ID]
    );
  });

  // Do not delete ledger entries.
  // They are intentionally append-only.
  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  it("completes a transfer with balanced ledger entries and updated balances", async () => {
    const result = await createTransfer({
      fromAccountId: SENDER_ID,
      toAccountId: RECEIVER_ID,
      amountPaise: "20000",
      idempotencyKey: "transfer-success-001",
    });

    expect(result.replayed).toBe(false);
    expect(result.transfer.status).toBe("COMPLETED");

    const balances = await pool.query(
      `SELECT id, balance_paise
       FROM accounts
       WHERE id = ANY($1::uuid[])`,
      [[SENDER_ID, RECEIVER_ID]]
    );

    const sender = balances.rows.find(
      (row) => row.id === SENDER_ID
    );

    const receiver = balances.rows.find(
      (row) => row.id === RECEIVER_ID
    );

    expect(BigInt(sender.balance_paise)).toBe(30000n);
    expect(BigInt(receiver.balance_paise)).toBe(30000n);

    const ledger = await pool.query(
      `SELECT entry_type, account_id, amount_paise
       FROM ledger_entries
       WHERE transfer_id = $1
       ORDER BY entry_type`,
      [result.transfer.id]
    );

    expect(ledger.rows).toHaveLength(2);

    expect(
      ledger.rows.find((row) => row.entry_type === "DEBIT").account_id
    ).toBe(SENDER_ID);

    expect(
      ledger.rows.find((row) => row.entry_type === "CREDIT").account_id
    ).toBe(RECEIVER_ID);

    expect(
      ledger.rows.every(
        (row) => BigInt(row.amount_paise) === 20000n
      )
    ).toBe(true);

    const outbox = await pool.query(
      `SELECT * FROM outbox WHERE transfer_id = $1`,
      [result.transfer.id]
    );

    expect(outbox.rows).toHaveLength(1);
  });

  it("returns the original transfer when the same request is retried", async () => {
    const input = {
      fromAccountId: SENDER_ID,
      toAccountId: RECEIVER_ID,
      amountPaise: "20000",
      idempotencyKey: "transfer-retry-001",
    };

    const first = await createTransfer(input);
    const second = await createTransfer(input);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.transfer.id).toBe(first.transfer.id);

    const result = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM transfers
       WHERE id = $1`,
      [first.transfer.id]
    );

    expect(result.rows[0].count).toBe(1);

    const balances = await pool.query(
      `SELECT id, balance_paise
       FROM accounts
       WHERE id = ANY($1::uuid[])`,
      [[SENDER_ID, RECEIVER_ID]]
    );

    const sender = balances.rows.find(
      (row) => row.id === SENDER_ID
    );

    const receiver = balances.rows.find(
      (row) => row.id === RECEIVER_ID
    );

    expect(BigInt(sender.balance_paise)).toBe(30000n);
    expect(BigInt(receiver.balance_paise)).toBe(30000n);

    const ledger = await pool.query(
  `SELECT COUNT(*)::int AS count
   FROM ledger_entries
   WHERE transfer_id = $1`,
  [first.transfer.id]
);

expect(ledger.rows[0].count).toBe(2);

const outbox = await pool.query(
  `SELECT COUNT(*)::int AS count
   FROM outbox
   WHERE transfer_id = $1`,
  [first.transfer.id]
);

expect(outbox.rows[0].count).toBe(1);
  });

    it("rejects a transfer when the sender has insufficient funds", async () => {
    const input = {
      fromAccountId: SENDER_ID,
      toAccountId: RECEIVER_ID,
      amountPaise: "60000",
      idempotencyKey: "transfer-insufficient-001",
    };

    await expect(createTransfer(input)).rejects.toThrow(
      "INSUFFICIENT_FUNDS"
    );

    const balances = await pool.query(
      `SELECT id, balance_paise
       FROM accounts
       WHERE id = ANY($1::uuid[])`,
      [[SENDER_ID, RECEIVER_ID]]
    );

    const sender = balances.rows.find(
      (row) => row.id === SENDER_ID
    );
    const receiver = balances.rows.find(
      (row) => row.id === RECEIVER_ID
    );

    expect(BigInt(sender.balance_paise)).toBe(50000n);
    expect(BigInt(receiver.balance_paise)).toBe(10000n);

    const records = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM transfers
          WHERE from_account_id = $1 OR to_account_id = $1
             OR from_account_id = $2 OR to_account_id = $2) AS transfers,
         (SELECT COUNT(*) FROM ledger_entries
          WHERE account_id = ANY($3::uuid[])) AS ledger_entries,
         (SELECT COUNT(*) FROM outbox
          WHERE transfer_id IN (
            SELECT id FROM transfers
            WHERE from_account_id = $1 OR to_account_id = $1
               OR from_account_id = $2 OR to_account_id = $2
          )) AS outbox`,
      [SENDER_ID, RECEIVER_ID, [SENDER_ID, RECEIVER_ID]]
    );

    expect(Number(records.rows[0].transfers)).toBe(0);
    expect(Number(records.rows[0].ledger_entries)).toBe(0);
    expect(Number(records.rows[0].outbox)).toBe(0);
  });

    it("rejects reuse of an idempotency key with a different request", async () => {
    const input = {
      fromAccountId: SENDER_ID,
      toAccountId: RECEIVER_ID,
      amountPaise: "20000",
      idempotencyKey: "transfer-key-reuse-001",
    };

    const first = await createTransfer(input);

    await expect(
      createTransfer({
        ...input,
        amountPaise: "30000",
      })
    ).rejects.toThrow("IDEMPOTENCY_KEY_REUSED");

    // The original transfer must remain unchanged.
    const balances = await pool.query(
      `SELECT id, balance_paise
       FROM accounts
       WHERE id = ANY($1::uuid[])`,
      [[SENDER_ID, RECEIVER_ID]]
    );

    const sender = balances.rows.find(
      (row) => row.id === SENDER_ID
    );
    const receiver = balances.rows.find(
      (row) => row.id === RECEIVER_ID
    );

    expect(BigInt(sender.balance_paise)).toBe(30000n);
    expect(BigInt(receiver.balance_paise)).toBe(30000n);

    const transfers = await pool.query(
      `SELECT id FROM transfers
       WHERE from_account_id = $1
         AND to_account_id = $2`,
      [SENDER_ID, RECEIVER_ID]
    );

    expect(transfers.rows).toHaveLength(1);
    expect(transfers.rows[0].id).toBe(first.transfer.id);
  });

    it("handles two simultaneous requests with the same idempotency key", async () => {
    const input = {
      fromAccountId: SENDER_ID,
      toAccountId: RECEIVER_ID,
      amountPaise: "20000",
      idempotencyKey: "transfer-concurrent-001",
    };

    const [first, second] = await Promise.all([
      createTransfer(input),
      createTransfer(input),
    ]);

    // Both requests must refer to the same transfer.
    expect(first.transfer.id).toBe(second.transfer.id);

    // Exactly one request creates it; the other replays it.
    expect([first.replayed, second.replayed].sort()).toEqual([
      false,
      true,
    ]);

    const transfers = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM transfers
       WHERE from_account_id = $1
         AND to_account_id = $2`,
      [SENDER_ID, RECEIVER_ID]
    );

    expect(transfers.rows[0].count).toBe(1);

    const ledger = await pool.query(
      `SELECT COUNT(*)::int AS count
       FROM ledger_entries
       WHERE transfer_id = $1`,
      [first.transfer.id]
    );

    expect(ledger.rows[0].count).toBe(2);

    const balances = await pool.query(
      `SELECT id, balance_paise
       FROM accounts
       WHERE id = ANY($1::uuid[])`,
      [[SENDER_ID, RECEIVER_ID]]
    );

    const sender = balances.rows.find(
      (row) => row.id === SENDER_ID
    );
    const receiver = balances.rows.find(
      (row) => row.id === RECEIVER_ID
    );

    expect(BigInt(sender.balance_paise)).toBe(30000n);
    expect(BigInt(receiver.balance_paise)).toBe(30000n);
  });

    it("rolls back all changes when a database operation fails", async () => {
    const input = {
      fromAccountId: SENDER_ID,
      toAccountId: RECEIVER_ID,
      amountPaise: "20000",
      idempotencyKey: "x".repeat(256),
    };

    // The idempotency_keys.key column allows only 255 characters.
    await expect(createTransfer(input)).rejects.toThrow();

    // Both balances must remain unchanged.
    const balances = await pool.query(
      `SELECT id, balance_paise
       FROM accounts
       WHERE id = ANY($1::uuid[])`,
      [[SENDER_ID, RECEIVER_ID]]
    );

    const sender = balances.rows.find(
      (row) => row.id === SENDER_ID
    );
    const receiver = balances.rows.find(
      (row) => row.id === RECEIVER_ID
    );

    expect(BigInt(sender.balance_paise)).toBe(50000n);
    expect(BigInt(receiver.balance_paise)).toBe(10000n);

    // No transfer or ledger entries should survive.
    const transfers = await pool.query(
      `SELECT id FROM transfers
       WHERE from_account_id = $1
          OR to_account_id = $1
          OR from_account_id = $2
          OR to_account_id = $2`,
      [SENDER_ID, RECEIVER_ID]
    );

    expect(transfers.rows).toHaveLength(0);

    const ledger = await pool.query(
      `SELECT id FROM ledger_entries
       WHERE account_id = ANY($1::uuid[])`,
      [[SENDER_ID, RECEIVER_ID]]
    );

    expect(ledger.rows).toHaveLength(0);

    const outbox = await pool.query(
      `SELECT id FROM outbox
       WHERE transfer_id IN (
         SELECT id FROM transfers
         WHERE from_account_id = $1
            OR to_account_id = $1
            OR from_account_id = $2
            OR to_account_id = $2
       )`,
      [SENDER_ID, RECEIVER_ID]
    );

    expect(outbox.rows).toHaveLength(0);
  });

  it("prevents concurrent transfers from spending the same balance", async () => {
  const results = await Promise.allSettled([
    createTransfer({
      fromAccountId: SENDER_ID,
      toAccountId: RECEIVER_ID,
      amountPaise: "40000",
      idempotencyKey: "concurrent-transfer-001",
    }),
    createTransfer({
      fromAccountId: SENDER_ID,
      toAccountId: RECEIVER_ID,
      amountPaise: "40000",
      idempotencyKey: "concurrent-transfer-002",
    }),
  ]);

  const successful = results.filter(
    (result) => result.status === "fulfilled"
  );

  const failed = results.filter(
    (result) => result.status === "rejected"
  );

  expect(successful).toHaveLength(1);
  expect(failed).toHaveLength(1);

  if (failed[0].status === "rejected") {
    expect(failed[0].reason.message).toBe("INSUFFICIENT_FUNDS");
  }

  const balances = await pool.query(
    `SELECT id, balance_paise
     FROM accounts
     WHERE id = ANY($1::uuid[])`,
    [[SENDER_ID, RECEIVER_ID]]
  );

  const sender = balances.rows.find(
    (row) => row.id === SENDER_ID
  );

  const receiver = balances.rows.find(
    (row) => row.id === RECEIVER_ID
  );

  expect(BigInt(sender.balance_paise)).toBe(10000n);
  expect(BigInt(receiver.balance_paise)).toBe(50000n);

  const transfers = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM transfers
     WHERE from_account_id = $1`,
    [SENDER_ID]
  );

  expect(transfers.rows[0].count).toBe(1);
});
});
