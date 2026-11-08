import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
} from "vitest";

import { randomUUID } from "node:crypto";
import { pool } from "../../src/db/pool";
import { adminPool } from "../helpers/admin-pool";

const USER_ID = randomUUID();
const INSERT_USER_ID = randomUUID();
const ACCOUNT_ID = randomUUID();

describe("Database application-role permissions", () => {
  beforeAll(async () => {
    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Permission Test', $2, 'test-hash')`,
      [USER_ID, `permission-${USER_ID}@ledgerlab.local`]
    );

    await adminPool.query(
      `INSERT INTO accounts (id, user_id, balance_paise)
       VALUES ($1, $2, 10000)`,
      [ACCOUNT_ID, USER_ID]
    );
  });

  it("connects using the restricted application role", async () => {
    const result = await pool.query(
      "SELECT current_user"
    );

    expect(result.rows[0].current_user).toBe("ledgerlab_app");
  });

  it("allows SELECT on accounts", async () => {
    const result = await pool.query(
      "SELECT id FROM accounts WHERE id = $1",
      [ACCOUNT_ID]
    );

    expect(result.rows).toHaveLength(1);
  });

  it("allows UPDATE on accounts", async () => {
    await pool.query(
      "UPDATE accounts SET balance_paise = 20000 WHERE id = $1",
      [ACCOUNT_ID]
    );

    const result = await pool.query(
      "SELECT balance_paise FROM accounts WHERE id = $1",
      [ACCOUNT_ID]
    );

    expect(BigInt(result.rows[0].balance_paise)).toBe(20000n);
  });

  it("allows INSERT on users", async () => {
    const result = await pool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Inserted User', $2, 'test-hash')
       RETURNING id`,
      [INSERT_USER_ID, `insert-${INSERT_USER_ID}@ledgerlab.local`]
    );

    expect(result.rows[0].id).toBe(INSERT_USER_ID);
  });

  it("denies DELETE on users", async () => {
    await expect(
      pool.query("DELETE FROM users WHERE id = $1", [USER_ID])
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("denies UPDATE on ledger_entries", async () => {
    await expect(
      pool.query("UPDATE ledger_entries SET amount_paise = 1")
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("denies DELETE on ledger_entries", async () => {
    await expect(
      pool.query("DELETE FROM ledger_entries")
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("denies TRUNCATE on ledger_entries", async () => {
    await expect(
      pool.query("TRUNCATE TABLE ledger_entries")
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("denies CREATE TABLE", async () => {
    await expect(
      pool.query("CREATE TABLE permission_test (id INTEGER)")
    ).rejects.toMatchObject({ code: "42501" });
  });

  afterAll(async () => {
    await adminPool.query(
      "DELETE FROM accounts WHERE id = $1",
      [ACCOUNT_ID]
    );

    await adminPool.query(
      "DELETE FROM users WHERE id = ANY($1::uuid[])",
      [[USER_ID, INSERT_USER_ID]]
    );

    await pool.end();
    await adminPool.end();
  });
});