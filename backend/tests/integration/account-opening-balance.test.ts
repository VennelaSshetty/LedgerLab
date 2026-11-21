
import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";

import { randomUUID } from "node:crypto";

import { createAccount } from "../../src/services/accounts.service";
import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";

const USER_ID = randomUUID();

// This amount is reserved for deliberately triggering the test failure.
const FAILURE_AMOUNT = 987654321012345678n;

describe("Account opening balance creation", () => {
  beforeAll(async () => {
    // Create a dedicated test user using the admin connection.
    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [
        USER_ID,
        "Opening Balance Test",
        `opening-balance-${USER_ID}@test.local`,
        "test-password-hash",
      ]
    );

    // Deliberately reject one specific opening-balance amount.
    // This lets us verify that account creation rolls back atomically.
    await adminPool.query(`
      CREATE OR REPLACE FUNCTION test_reject_opening_balance()
      RETURNS TRIGGER
      LANGUAGE plpgsql
      AS $$
      BEGIN
        IF NEW.amount_paise = 987654321012345678 THEN
          RAISE EXCEPTION 'TEST_OPENING_BALANCE_FAILURE'
            USING ERRCODE = '23514';
        END IF;

        RETURN NEW;
      END;
      $$;
    `);

    await adminPool.query(`
      CREATE TRIGGER test_reject_opening_balance_trigger
      BEFORE INSERT ON account_opening_balances
      FOR EACH ROW
      EXECUTE FUNCTION test_reject_opening_balance();
    `);
  });

  afterAll(async () => {
    // Remove the test-only trigger and function.
    await adminPool.query(`
      DROP TRIGGER IF EXISTS test_reject_opening_balance_trigger
      ON account_opening_balances;
    `);

    await adminPool.query(`
      DROP FUNCTION IF EXISTS test_reject_opening_balance();
    `);

    // Clean up test data in foreign-key-safe order.
    await adminPool.query(
      `DELETE FROM account_opening_balances
       WHERE account_id IN (
         SELECT id FROM accounts WHERE user_id = $1
       )`,
      [USER_ID]
    );

    await adminPool.query(
      `DELETE FROM accounts WHERE user_id = $1`,
      [USER_ID]
    );

    await adminPool.query(
      `DELETE FROM users WHERE id = $1`,
      [USER_ID]
    );
  });

  it("creates an account with a zero opening balance", async () => {
    const account = await createAccount(USER_ID);

    expect(BigInt(account.balance_paise)).toBe(0n);

    const result = await adminPool.query(
      `SELECT amount_paise
       FROM account_opening_balances
       WHERE account_id = $1`,
      [account.id]
    );

    expect(result.rowCount).toBe(1);
    expect(BigInt(result.rows[0].amount_paise)).toBe(0n);
  });

  it("creates an account with the exact non-zero opening balance", async () => {
    const openingBalance = 123456789012345678n;

    const account = await createAccount(USER_ID, openingBalance);

    expect(BigInt(account.balance_paise)).toBe(openingBalance);

    const result = await adminPool.query(
      `SELECT amount_paise
       FROM account_opening_balances
       WHERE account_id = $1`,
      [account.id]
    );

    expect(result.rowCount).toBe(1);
    expect(BigInt(result.rows[0].amount_paise)).toBe(openingBalance);
  });

  it("rejects a negative opening balance without creating an account", async () => {
    const before = await adminPool.query(
      `SELECT COUNT(*)::int AS count
       FROM accounts WHERE user_id = $1`,
      [USER_ID]
    );

    await expect(
      createAccount(USER_ID, -1n)
    ).rejects.toThrow("INVALID_OPENING_BALANCE");

    const after = await adminPool.query(
      `SELECT COUNT(*)::int AS count
       FROM accounts WHERE user_id = $1`,
      [USER_ID]
    );

    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it("rolls back account creation if opening-balance insertion fails", async () => {
    const before = await adminPool.query(
      `SELECT COUNT(*)::int AS count
       FROM accounts WHERE user_id = $1`,
      [USER_ID]
    );

    await expect(
      createAccount(USER_ID, FAILURE_AMOUNT)
    ).rejects.toThrow("TEST_OPENING_BALANCE_FAILURE");

    const after = await adminPool.query(
      `SELECT COUNT(*)::int AS count
       FROM accounts WHERE user_id = $1`,
      [USER_ID]
    );

    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
