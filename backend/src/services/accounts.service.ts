import { pool } from "../db/pool";

export async function createAccount(userId: string) {
  try {
    const result = await pool.query(
      `INSERT INTO accounts (user_id)
       VALUES ($1)
       RETURNING id, user_id, balance_paise, status, created_at`,
      [userId]
    );

    return result.rows[0];
  } catch (error: any) {
    if (error.code === "23503") {
      throw new Error("USER_NOT_FOUND");
    }

    throw error;
  }
}

export async function getAccountBalance(accountId: string) {
  const result = await pool.query(
    `SELECT id, balance_paise, status
     FROM accounts
     WHERE id = $1`,
    [accountId]
  );

  return result.rows[0] ?? null;
}

export async function getAccountTransfers(accountId: string) {
  const accountResult = await pool.query(
    `SELECT id FROM accounts WHERE id = $1`,
    [accountId]
  );

  if (accountResult.rowCount === 0) {
    return null;
  }

  const result = await pool.query(
    `SELECT
       id,
       from_account_id,
       to_account_id,
       amount_paise,
       status,
       created_at
     FROM transfers
     WHERE from_account_id = $1
        OR to_account_id = $1
     ORDER BY created_at DESC, id DESC`,
    [accountId]
  );

  return result.rows;
}