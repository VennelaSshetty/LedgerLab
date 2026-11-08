import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";

const USER_ID = randomUUID();
const SENDER_ID = randomUUID();
const RECEIVER_ID = randomUUID();

const TRANSFER_ID = randomUUID();
const INCOMPLETE_TRANSFER_ID = randomUUID();

async function insertLedgerEntry(
  client: PoolClient,
  transferId: string,
  accountId: string,
  entryType: "DEBIT" | "CREDIT",
  amount: number
): Promise<void> {
  await client.query(
    `INSERT INTO ledger_entries
      (transfer_id, account_id, entry_type, amount_paise)
     VALUES ($1, $2, $3, $4)`,
    [transferId, accountId, entryType, amount]
  );
}

describe("Ledger concurrency protection", () => {
  beforeAll(async () => {
    // Create test fixtures using the admin connection.
    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Ledger Concurrency Test', $2, 'test-hash')`,
      [USER_ID, `ledger-${USER_ID}@ledgerlab.local`]
    );

    await adminPool.query(
      `INSERT INTO accounts (id, user_id, balance_paise)
       VALUES ($1, $3, 100000), ($2, $3, 0)`,
      [SENDER_ID, RECEIVER_ID, USER_ID]
    );

    await adminPool.query(
      `INSERT INTO transfers
        (id, from_account_id, to_account_id, amount_paise, status)
       VALUES
        ($1, $2, $3, 40000, 'PENDING'),
        ($4, $2, $3, 20000, 'PENDING')`,
      [
        TRANSFER_ID,
        SENDER_ID,
        RECEIVER_ID,
        INCOMPLETE_TRANSFER_ID,
      ]
    );
  });

  it("serializes concurrent ledger inserts for the same transfer", async () => {
    const clientA = await pool.connect();
    const clientB = await pool.connect();

    let transactionAStarted = false;

    try {
      await clientA.query("BEGIN");

      await clientA.query(
        `UPDATE transfers
         SET status = 'COMPLETED'
         WHERE id = $1`,
        [TRANSFER_ID]
      );

      await insertLedgerEntry(
        clientA,
        TRANSFER_ID,
        SENDER_ID,
        "DEBIT",
        40000
      );

      await insertLedgerEntry(
        clientA,
        TRANSFER_ID,
        RECEIVER_ID,
        "CREDIT",
        40000
      );

      transactionAStarted = true;

      await clientB.query("BEGIN");

      let transactionBFinished = false;

      const transactionB = insertLedgerEntry(
        clientB,
        TRANSFER_ID,
        SENDER_ID,
        "DEBIT",
        40000
      ).then(
        () => {
          transactionBFinished = true;
          return null;
        },
        (error: { code?: string }) => {
          transactionBFinished = true;
          return error;
        }
      );

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(transactionBFinished).toBe(false);

      await clientA.query("COMMIT");

      const error = await transactionB;

      expect(error).not.toBeNull();
      expect(error?.code).toBe("23505");

      await clientB.query("ROLLBACK");

      const result = await pool.query(
        `SELECT entry_type, amount_paise
         FROM ledger_entries
         WHERE transfer_id = $1`,
        [TRANSFER_ID]
      );

      expect(result.rows).toHaveLength(2);

      expect(
        result.rows.map((row) => row.entry_type).sort()
      ).toEqual(["CREDIT", "DEBIT"]);
    } catch (error) {
      if (transactionAStarted) {
        await clientA.query("ROLLBACK").catch(() => {});
      }

      await clientB.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      clientA.release();
      clientB.release();
    }
  });

  it("rejects a completed transfer with an incomplete ledger", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE transfers
         SET status = 'COMPLETED'
         WHERE id = $1`,
        [INCOMPLETE_TRANSFER_ID]
      );

      await insertLedgerEntry(
        client,
        INCOMPLETE_TRANSFER_ID,
        SENDER_ID,
        "DEBIT",
        20000
      );

      await expect(client.query("COMMIT")).rejects.toThrow();

      await client.query("ROLLBACK");

      const result = await pool.query(
        `SELECT status
         FROM transfers
         WHERE id = $1`,
        [INCOMPLETE_TRANSFER_ID]
      );

      expect(result.rows[0].status).toBe("PENDING");

      const entries = await pool.query(
        `SELECT id
         FROM ledger_entries
         WHERE transfer_id = $1`,
        [INCOMPLETE_TRANSFER_ID]
      );

      expect(entries.rows).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });

  afterAll(async () => {
    // Ledger entries are append-only, so these random test fixtures
    // are intentionally retained rather than deleted.
    await pool.end();
    await adminPool.end();
  });
});