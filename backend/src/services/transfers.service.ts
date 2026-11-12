import { pool } from "../db/pool";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { lockAccounts } from "../db/account-lock";
import { withTransactionRetry } from "./transaction-retry";

export type CreateTransferInput = {
  fromAccountId: string;
  toAccountId: string;
  amountPaise: string;
  idempotencyKey: string;
};

export async function getTransferLedger(transferId: string) {
  const transferResult = await pool.query(
    `SELECT id FROM transfers WHERE id = $1`,
    [transferId]
  );

  if (transferResult.rowCount === 0) {
    return null;
  }

  const result = await pool.query(
    `SELECT
       id,
       transfer_id,
       account_id,
       entry_type,
       amount_paise,
       created_at
     FROM ledger_entries
     WHERE transfer_id = $1
     ORDER BY
       CASE entry_type
         WHEN 'DEBIT' THEN 1
         WHEN 'CREDIT' THEN 2
       END`,
    [transferId]
  );

  return result.rows;
}

export async function createTransferLedgerEntries(
  client: PoolClient,
  transferId: string,
  fromAccountId: string,
  toAccountId: string,
  amountPaise: string
) {
  // Create DEBIT entry for the sender
  await client.query(
    `INSERT INTO ledger_entries (
       transfer_id,
       account_id,
       entry_type,
       amount_paise
     )
     VALUES ($1, $2, 'DEBIT', $3)`,
    [transferId, fromAccountId, amountPaise]
  );

  // Create CREDIT entry for the receiver
  await client.query(
    `INSERT INTO ledger_entries (
       transfer_id,
       account_id,
       entry_type,
       amount_paise
     )
     VALUES ($1, $2, 'CREDIT', $3)`,
    [transferId, toAccountId, amountPaise]
  );
}

function validateTransferInput(input: CreateTransferInput) {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  if (
    !uuidRegex.test(input.fromAccountId) ||
    !uuidRegex.test(input.toAccountId)
  ) {
    throw new Error("INVALID_ACCOUNT_ID");
  }

  if (input.fromAccountId === input.toAccountId) {
    throw new Error("SAME_ACCOUNT_TRANSFER");
  }

  if (!/^[1-9]\d*$/.test(input.amountPaise)) {
    throw new Error("INVALID_AMOUNT");
  }

  if (!input.idempotencyKey.trim()) {
    throw new Error("INVALID_IDEMPOTENCY_KEY");
  }
}

function createRequestHash(input: CreateTransferInput) {
  const normalizedRequest = JSON.stringify({
    fromAccountId: input.fromAccountId,
    toAccountId: input.toAccountId,
    amountPaise: input.amountPaise,
  });

  return createHash("sha256")
    .update(normalizedRequest)
    .digest("hex");
}

function isRetryableTransactionError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error)
  ) {
    return false;
  }

  const code = error.code;

  return code === "40P01" || code === "40001";
}

function getRetryDelay(attempt: number): number {
  const baseDelay = 100;
  const maxDelay = 1000;

  const exponentialDelay = Math.min(
    maxDelay,
    baseDelay * 2 ** attempt
  );

  const jitter = Math.random() * exponentialDelay * 0.5;

  return Math.floor(exponentialDelay + jitter);
}

async function createTransferAttempt(input: CreateTransferInput) {
  const client = await pool.connect();
 let commitStarted = false;
  try {
    await client.query("BEGIN");

        // Get the owner of the sender account.
    const accountResult = await client.query(
      `SELECT user_id
       FROM accounts
       WHERE id = $1`,
      [input.fromAccountId]
    );

   if (accountResult.rows.length === 0) {
      throw new Error("ACCOUNT_NOT_FOUND");
    }

    const userId = accountResult.rows[0].user_id;

    // Serialize requests using the same user's idempotency key.
await client.query(
  `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
  [`${userId}:${input.idempotencyKey}`]
);

    // Generate a fingerprint of the request.
    const requestHash = createRequestHash(input);

    // Check whether this user has already used this idempotency key.
    const existingResult = await client.query(
      `SELECT
         ik.request_hash,
         t.id,
         t.from_account_id,
         t.to_account_id,
         t.amount_paise,
         t.status,
         t.created_at
       FROM idempotency_keys ik
       JOIN transfers t ON t.id = ik.transfer_id
       WHERE ik.user_id = $1
         AND ik.key = $2`,
      [userId, input.idempotencyKey]
    );

    if (existingResult.rows.length > 0) {
      const existingTransfer = existingResult.rows[0];

      // Same key, different request: reject it.
      if (existingTransfer.request_hash !== requestHash) {
        throw new Error("IDEMPOTENCY_KEY_REUSED");
      }

     // Same key, same request: return the original transfer.
commitStarted = true;
await client.query("COMMIT");

      return {
        transfer: {
          id: existingTransfer.id,
          fromAccountId: existingTransfer.from_account_id,
          toAccountId: existingTransfer.to_account_id,
          amountPaise: existingTransfer.amount_paise,
          status: existingTransfer.status,
          createdAt: existingTransfer.created_at,
        },
        replayed: true,
      };
    }
 
    // Lock both accounts in a consistent order.
const lockedAccounts = await lockAccounts(client, [
  input.fromAccountId,
  input.toAccountId,
]);

const fromAccount = lockedAccounts.find(
  (account) => account.id === input.fromAccountId
);

const toAccount = lockedAccounts.find(
  (account) => account.id === input.toAccountId
);

if (!fromAccount || !toAccount) {
  throw new Error("ACCOUNT_NOT_FOUND");
}

if (fromAccount.status !== "ACTIVE" || toAccount.status !== "ACTIVE") {
  throw new Error("ACCOUNT_NOT_ACTIVE");
}

if (BigInt(fromAccount.balance_paise) < BigInt(input.amountPaise)) {
  throw new Error("INSUFFICIENT_FUNDS");
}

const transferResult = await client.query(
  `INSERT INTO transfers (
     from_account_id,
     to_account_id,
     amount_paise,
     status
   )
   VALUES ($1, $2, $3, 'PENDING')
   RETURNING id, from_account_id, to_account_id, amount_paise, status, created_at`,
  [
    input.fromAccountId,
    input.toAccountId,
    input.amountPaise,
  ]
);

const transfer = transferResult.rows[0];

await createTransferLedgerEntries(
  client,
  transfer.id,
  input.fromAccountId,
  input.toAccountId,
  input.amountPaise
);

await client.query(
  `UPDATE accounts
   SET balance_paise = balance_paise - $1,
       updated_at = NOW()
   WHERE id = $2`,
  [input.amountPaise, input.fromAccountId]
);

await client.query(
  `UPDATE accounts
   SET balance_paise = balance_paise + $1,
       updated_at = NOW()
   WHERE id = $2`,
  [input.amountPaise, input.toAccountId]
);

await client.query(
  `UPDATE transfers
   SET status = 'COMPLETED'
   WHERE id = $1`,
  [transfer.id]
);

// Store the idempotency key for future retries.
await client.query(
  `INSERT INTO idempotency_keys (
     user_id,
     key,
     request_hash,
     transfer_id
   )
   VALUES ($1, $2, $3, $4)`,
  [userId, input.idempotencyKey, requestHash, transfer.id]
);

// Record the event for later publishing to Kafka.
await client.query(
  `INSERT INTO outbox (
     transfer_id,
     event_type,
     payload
   )
   VALUES ($1, $2, $3)`,
  [
    transfer.id,
    "TRANSFER_COMPLETED",
    JSON.stringify({
      transferId: transfer.id,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountPaise: input.amountPaise,
    }),
  ]
);

// Commit all transfer operations atomically.
commitStarted = true;
await client.query("COMMIT");

return {
  transfer: {
    id: transfer.id,
    fromAccountId: transfer.from_account_id,
    toAccountId: transfer.to_account_id,
    amountPaise: transfer.amount_paise,
    status: "COMPLETED",
    createdAt: transfer.created_at,
  },
  replayed: false,
};

 } catch (error) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }

  if (commitStarted) {
    throw new Error("TRANSFER_COMMIT_OUTCOME_UNKNOWN", {
      cause: error,
    });
  }

  throw error;
} finally {
    client.release();
  }
}

export async function createTransfer(input: CreateTransferInput) {
  validateTransferInput(input);

  return withTransactionRetry(() => createTransferAttempt(input));
}