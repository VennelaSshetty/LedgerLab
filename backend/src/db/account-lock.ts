import type { PoolClient } from "pg";

export interface LockedAccount {
  id: string;
  balance_paise: string;
}

export async function lockAccounts(
  client: PoolClient,
  accountIds: string[]
): Promise<LockedAccount[]> {
  const result = await client.query<LockedAccount>(
    `
      SELECT id, balance_paise
      FROM accounts
      WHERE id = ANY($1::uuid[])
      ORDER BY id
      FOR UPDATE
    `,
    [accountIds]
  );

  if (result.rows.length !== new Set(accountIds).size) {
    throw new Error("One or more accounts do not exist");
  }

  return result.rows;
}