import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";
import { createTransferLedgerEntries } from "../../src/services/transfers.service";

describe("Double-entry ledger writing", () => {
  let userId: string;
  let fromAccountId: string;
  let toAccountId: string;
  let transferId: string;

  beforeAll(async () => {
    // Create test user using admin connection
    const userResult = await adminPool.query(
      `INSERT INTO users (name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [
        "Ledger Writing Test User",
        "ledger-writing-test@example.com",
        "test-password-hash",
      ]
    );

    userId = userResult.rows[0].id;

    // Create sender and receiver accounts
    const accountsResult = await adminPool.query(
      `INSERT INTO accounts (user_id)
       VALUES ($1), ($1)
       RETURNING id`,
      [userId]
    );

    fromAccountId = accountsResult.rows[0].id;
    toAccountId = accountsResult.rows[1].id;

    // Create a pending transfer
    const transferResult = await adminPool.query(
      `INSERT INTO transfers (
         from_account_id,
         to_account_id,
         amount_paise,
         status
       )
       VALUES ($1, $2, $3, 'PENDING')
       RETURNING id`,
      [fromAccountId, toAccountId, "200000"]
    );

    transferId = transferResult.rows[0].id;
  });

  afterAll(async () => {
    await adminPool.query(
      `DELETE FROM outbox WHERE transfer_id = $1`,
      [transferId]
    );

    await adminPool.query(
      `DELETE FROM idempotency_keys WHERE transfer_id = $1`,
      [transferId]
    );

    // Ledger entries are not deleted: the test transaction rolls them back.

    await adminPool.query(
      `DELETE FROM transfers WHERE id = $1`,
      [transferId]
    );

    await adminPool.query(
      `DELETE FROM accounts WHERE id IN ($1, $2)`,
      [fromAccountId, toAccountId]
    );

    await adminPool.query(
      `DELETE FROM users WHERE id = $1`,
      [userId]
    );
  });

  it("creates exactly one debit and one credit entry", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      await createTransferLedgerEntries(
        client,
        transferId,
        fromAccountId,
        toAccountId,
        "200000"
      );

      const result = await client.query(
        `SELECT account_id, entry_type, amount_paise
         FROM ledger_entries
         WHERE transfer_id = $1
         ORDER BY entry_type`,
        [transferId]
      );

      expect(result.rows).toHaveLength(2);

      const debit = result.rows.find(
        (entry) => entry.entry_type === "DEBIT"
      );

      const credit = result.rows.find(
        (entry) => entry.entry_type === "CREDIT"
      );

      expect(debit).toBeDefined();
      expect(credit).toBeDefined();

      expect(debit.account_id).toBe(fromAccountId);
      expect(credit.account_id).toBe(toAccountId);

      expect(debit.amount_paise).toBe("200000");
      expect(credit.amount_paise).toBe("200000");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

    it("rejects ledger entries when debit and credit amounts do not match the transfer", async () => {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // Mark the transfer as completed.
      await client.query(
        `UPDATE transfers
         SET status = 'COMPLETED'
         WHERE id = $1`,
        [transferId]
      );

      // Intentionally insert an incorrect debit amount.
      await client.query(
        `INSERT INTO ledger_entries (
           transfer_id,
           account_id,
           entry_type,
           amount_paise
         )
         VALUES ($1, $2, 'DEBIT', $3)`,
        [transferId, fromAccountId, "199999"]
      );

      // Insert the correct credit amount.
      await client.query(
        `INSERT INTO ledger_entries (
           transfer_id,
           account_id,
           entry_type,
           amount_paise
         )
         VALUES ($1, $2, 'CREDIT', $3)`,
        [transferId, toAccountId, "200000"]
      );

      // The deferred database trigger should reject this COMMIT.
      let commitError: { code?: string } | undefined;

      try {
        await client.query("COMMIT");
      } catch (error) {
        commitError = error as { code?: string };
      }

      expect(commitError?.code).toBe("23514");

      // Roll back the failed transaction.
      await client.query("ROLLBACK");

      // Verify that the transfer is still pending.
      const transferResult = await pool.query(
        `SELECT status
         FROM transfers
         WHERE id = $1`,
        [transferId]
      );

      expect(transferResult.rows[0].status).toBe("PENDING");

      // Verify that no ledger entries were persisted.
      const entriesResult = await pool.query(
        `SELECT id
         FROM ledger_entries
         WHERE transfer_id = $1`,
        [transferId]
      );

      expect(entriesResult.rows).toHaveLength(0);
    } finally {
      await client.query("ROLLBACK").catch(() => {});
      client.release();
    }
  });
});