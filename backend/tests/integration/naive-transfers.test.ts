import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { randomUUID } from "node:crypto";
import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";
import { createNaiveTransfer } from "../../src/services/naive-transfers.service";

describe("Naive transfer concurrency", () => {
  let senderId: string;
  let receiverId: string;

  beforeEach(async () => {
    const userId = randomUUID();

    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [userId, "Naive Test User", `${userId}@test.com`, "test-hash"]
    );

    senderId = randomUUID();
    receiverId = randomUUID();

    await adminPool.query(
      `INSERT INTO accounts (id, user_id, balance_paise, status)
       VALUES
         ($1, $3, 50000, 'ACTIVE'),
         ($2, $3, 10000, 'ACTIVE')`,
      [senderId, receiverId, userId]
    );
  });

  afterAll(async () => {
    await pool.end();
    await adminPool.end();
  });

  it("demonstrates a lost update when two transfers read the same balances", async () => {
    let arrivals = 0;
    let release!: () => void;

    const bothReadBalances = new Promise<void>((resolve) => {
      release = resolve;
    });

    const afterBalanceRead = async () => {
      arrivals += 1;

      if (arrivals === 2) {
        release();
      }

      await bothReadBalances;
    };

    const input = {
      fromAccountId: senderId,
      toAccountId: receiverId,
      amountPaise: "100",
    };

    const results = await Promise.all([
      createNaiveTransfer(input, afterBalanceRead),
      createNaiveTransfer(input, afterBalanceRead),
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].id).not.toBe(results[1].id);

    const balances = await pool.query(
      `SELECT id, balance_paise
       FROM accounts
       WHERE id = ANY($1::uuid[])`,
      [[senderId, receiverId]]
    );

    const sender = balances.rows.find((row) => row.id === senderId);
    const receiver = balances.rows.find((row) => row.id === receiverId);

    // Both transactions wrote balances calculated from the same stale reads.
    expect(BigInt(sender.balance_paise)).toBe(49900n);
    expect(BigInt(receiver.balance_paise)).toBe(10100n);

    const ledger = await pool.query(
      `SELECT account_id, entry_type, SUM(amount_paise)::text AS total_paise
       FROM ledger_entries
       WHERE account_id = ANY($1::uuid[])
       GROUP BY account_id, entry_type`,
      [[senderId, receiverId]]
    );

    const senderDebit = ledger.rows.find(
      (row) => row.account_id === senderId && row.entry_type === "DEBIT"
    );

    const receiverCredit = ledger.rows.find(
      (row) => row.account_id === receiverId && row.entry_type === "CREDIT"
    );

    // The ledger records both transfers: 200 paise in each direction.
    expect(BigInt(senderDebit.total_paise)).toBe(200n);
    expect(BigInt(receiverCredit.total_paise)).toBe(200n);

    // But the cached balances reflect only one 100-paise transfer.
    expect(
      BigInt(sender.balance_paise) - (50000n - 200n)
    ).toBe(100n);

    expect(
      BigInt(receiver.balance_paise) - (10000n + 200n)
    ).toBe(-100n);
  });

  it("creates two separate transfers when the same request is submitted twice", async () => {
  const input = {
    fromAccountId: senderId,
    toAccountId: receiverId,
    amountPaise: "100",
  };

  // Submit the exact same request twice.
  const firstTransfer = await createNaiveTransfer(input);
  const secondTransfer = await createNaiveTransfer(input);

  // Both requests must create independent transfers.
  expect(firstTransfer.id).not.toBe(secondTransfer.id);

  const transferIds = [firstTransfer.id, secondTransfer.id];

  const transfers = await pool.query(
    `SELECT id, status
     FROM transfers
     WHERE id = ANY($1::uuid[])`,
    [transferIds]
  );

  expect(transfers.rows).toHaveLength(2);
  expect(transfers.rows.every((row) => row.status === "COMPLETED")).toBe(true);

  // Each transfer must have one debit and one credit.
  const ledger = await pool.query(
    `SELECT COUNT(*)::int AS count
     FROM ledger_entries
     WHERE transfer_id = ANY($1::uuid[])`,
    [transferIds]
  );

  expect(ledger.rows[0].count).toBe(4);

  // Both sequential transfers must update the balances.
  const balances = await pool.query(
    `SELECT id, balance_paise
     FROM accounts
     WHERE id = ANY($1::uuid[])`,
    [[senderId, receiverId]]
  );

  const sender = balances.rows.find((row) => row.id === senderId);
  const receiver = balances.rows.find((row) => row.id === receiverId);

  expect(BigInt(sender.balance_paise)).toBe(49800n);
  expect(BigInt(receiver.balance_paise)).toBe(10200n);
});
});