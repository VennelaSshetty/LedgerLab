import { pool } from "../db/pool";


export async function createAccount(
  userId: string,
  openingBalancePaise: bigint = 0n
) {
  if (openingBalancePaise < 0n) {
    throw new Error("INVALID_OPENING_BALANCE");
  }

  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;

    const result = await client.query(
      `INSERT INTO accounts (user_id, balance_paise)
       VALUES ($1, $2)
       RETURNING id, user_id, balance_paise, status, created_at`,
      [userId, openingBalancePaise.toString()]
    );

    const account = result.rows[0];

    await client.query(
      `INSERT INTO account_opening_balances
         (account_id, amount_paise)
       VALUES ($1, $2)`,
      [account.id, openingBalancePaise.toString()]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return account;
  } catch (error: any) {
    if (transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original error.
      }
    }

    if (error.code === "23503") {
      throw new Error("USER_NOT_FOUND");
    }

    throw error;
  } finally {
    client.release();
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