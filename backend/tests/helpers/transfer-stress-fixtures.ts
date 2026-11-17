import { randomUUID } from "node:crypto";
import type { Server } from "node:http";

import app from "../../src/app";
import { adminPool } from "./admin-pool";
import { deleteLedgerEntriesForTests } from "./cleanup-ledger-entries";

export type StressFixture = {
  userId: string;
  accountIds: string[];
};

export type StressServer = {
  baseUrl: string;
  close: () => Promise<void>;
};

/**
 * Creates an isolated user and accounts with controlled opening balances.
 *
 * Balances are strings so PostgreSQL BIGINT values never pass through
 * JavaScript Number.
 */
export async function createStressFixture(
  openingBalancesPaise: string[],
): Promise<StressFixture> {
  if (openingBalancesPaise.length < 2) {
    throw new Error("A stress fixture requires at least two accounts.");
  }

  for (const balance of openingBalancesPaise) {
    if (!/^(0|[1-9]\d*)$/.test(balance)) {
      throw new Error(`Invalid opening balance: ${balance}`);
    }
  }

  const userId = randomUUID();
  const accountIds = openingBalancesPaise.map(() => randomUUID());

  try {
    await adminPool.query(
      `INSERT INTO users (id, name, email, password_hash)
       VALUES ($1, 'Transfer Stress Test', $2, 'stress-test-hash')`,
      [userId, `stress-${userId}@ledgerlab.local`],
    );

    await adminPool.query(
      `INSERT INTO accounts (id, user_id, balance_paise)
       SELECT fixture.account_id, $2, fixture.balance
       FROM unnest($1::uuid[], $3::bigint[])
         AS fixture(account_id, balance)`,
      [accountIds, userId, openingBalancesPaise],
    );

    await adminPool.query(
      `INSERT INTO account_opening_balances
         (account_id, amount_paise)
       SELECT fixture.account_id, fixture.balance
       FROM unnest($1::uuid[], $2::bigint[])
         AS fixture(account_id, balance)`,
      [accountIds, openingBalancesPaise],
    );

    return { userId, accountIds };
  } catch (error) {
    await cleanupStressFixture({ userId, accountIds }).catch(() => {});
    throw error;
  }
}

/**
 * Removes all database records belonging to this isolated fixture.
 */
export async function cleanupStressFixture(
  fixture: StressFixture,
): Promise<void> {
  const { userId, accountIds } = fixture;

  const transfers = await adminPool.query<{ id: string }>(
    `SELECT id
     FROM transfers
     WHERE from_account_id = ANY($1::uuid[])
        OR to_account_id = ANY($1::uuid[])`,
    [accountIds],
  );

  const transferIds = transfers.rows.map((row) => row.id);

  // Use the existing test-only helper to handle append-only ledger triggers.
  await deleteLedgerEntriesForTests(accountIds);

  if (transferIds.length > 0) {
    await adminPool.query(
      `DELETE FROM idempotency_keys
       WHERE transfer_id = ANY($1::uuid[])`,
      [transferIds],
    );

    await adminPool.query(
      `DELETE FROM outbox
       WHERE transfer_id = ANY($1::uuid[])`,
      [transferIds],
    );

    await adminPool.query(
      `DELETE FROM transfers
       WHERE id = ANY($1::uuid[])`,
      [transferIds],
    );
  }

  await adminPool.query(
    `DELETE FROM account_opening_balances
     WHERE account_id = ANY($1::uuid[])`,
    [accountIds],
  );

  await adminPool.query(
    `DELETE FROM accounts
     WHERE id = ANY($1::uuid[])`,
    [accountIds],
  );

  await adminPool.query(
    `DELETE FROM users
     WHERE id = $1`,
    [userId],
  );
}

/**
 * Starts the actual Express application on an available local port.
 */
export async function startStressServer(): Promise<StressServer> {
  const server: Server = app.listen(
  0,
  "127.0.0.1",
  2048,
);

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();

  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Could not determine stress-test server port.");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,

    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
