import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";
import { lockAccounts } from "../../src/db/account-lock";

const USER_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const SENDER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const RECEIVER_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

const TRANSFER_AMOUNT = 40000n;

async function attemptTransfer(): Promise<boolean> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const accounts = await lockAccounts(client, [
      SENDER_ID,
      RECEIVER_ID,
    ]);

    const sender = accounts.find((a) => a.id === SENDER_ID)!;
    const receiver = accounts.find((a) => a.id === RECEIVER_ID)!;

    const senderBalance = BigInt(sender.balance_paise);
    const receiverBalance = BigInt(receiver.balance_paise);

    if (senderBalance < TRANSFER_AMOUNT) {
      throw new Error("Insufficient balance");
    }

    await client.query(
      `UPDATE accounts SET balance_paise = $1 WHERE id = $2`,
      [(senderBalance - TRANSFER_AMOUNT).toString(), SENDER_ID]
    );

    await client.query(
      `UPDATE accounts SET balance_paise = $1 WHERE id = $2`,
      [(receiverBalance + TRANSFER_AMOUNT).toString(), RECEIVER_ID]
    );

    await client.query("COMMIT");
    return true;
  } catch {
    await client.query("ROLLBACK");
    return false;
  } finally {
    client.release();
  }
}

describe("Account concurrency protection", () => {
  beforeAll(async () => {
    // Clean up previous test fixtures using the admin connection.
    await adminPool.query(
      "DELETE FROM accounts WHERE id = ANY($1::uuid[])",
      [[SENDER_ID, RECEIVER_ID]]
    );

    await adminPool.query(
      "DELETE FROM users WHERE id = $1",
      [USER_ID]
    );

    // Create the test user.
    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Concurrency Test', 'concurrency-test@ledgerlab.local', 'test-hash')`,
      [USER_ID]
    );

    // Create sender and receiver accounts.
    await adminPool.query(
      `INSERT INTO accounts (id, user_id, balance_paise)
       VALUES ($1, $3, 50000), ($2, $3, 0)`,
      [SENDER_ID, RECEIVER_ID, USER_ID]
    );
  });

  afterAll(async () => {
    // Clean up using the admin connection.
    await adminPool.query(
      "DELETE FROM accounts WHERE id = ANY($1::uuid[])",
      [[SENDER_ID, RECEIVER_ID]]
    );

    await adminPool.query(
      "DELETE FROM users WHERE id = $1",
      [USER_ID]
    );

    await pool.end();
    await adminPool.end();
  });

  it("allows only one of two simultaneous transfers to spend the balance", async () => {
    const results = await Promise.all([
      attemptTransfer(),
      attemptTransfer(),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => !result)).toHaveLength(1);

    const balances = await pool.query(
      `SELECT id, balance_paise
       FROM accounts
       WHERE id IN ($1, $2)
       ORDER BY id`,
      [SENDER_ID, RECEIVER_ID]
    );

    const sender = balances.rows.find(
      (row) => row.id === SENDER_ID
    );

    const receiver = balances.rows.find(
      (row) => row.id === RECEIVER_ID
    );

    expect(BigInt(sender.balance_paise)).toBe(10000n);
    expect(BigInt(receiver.balance_paise)).toBe(40000n);
  });
});