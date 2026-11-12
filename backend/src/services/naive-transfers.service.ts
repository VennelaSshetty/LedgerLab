import { pool } from "../db/pool";
import type { PoolClient } from "pg";
import { createTransferLedgerEntries } from "./transfers.service";

export type CreateNaiveTransferInput = {
  fromAccountId: string;
  toAccountId: string;
  amountPaise: string;
};

type NaiveAccount = {
  id: string;
  balance_paise: string;
  status: string;
};

function validateNaiveTransferInput(
  input: CreateNaiveTransferInput
): void {
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
}

export async function createNaiveTransfer(
  input: CreateNaiveTransferInput,
  afterBalanceRead?: () => Promise<void>
) {
  validateNaiveTransferInput(input);

  const client: PoolClient = await pool.connect();

  let commitStarted = false;

  try {
    await client.query("BEGIN");

    // Intentionally no SELECT FOR UPDATE.
    // Concurrent transactions can read the same old balances.
    const accountResult = await client.query<NaiveAccount>(
      `
      SELECT id, balance_paise, status
      FROM accounts
      WHERE id = ANY($1::uuid[])
      `,
      [[input.fromAccountId, input.toAccountId]]
    );

    if (accountResult.rows.length !== 2) {
      throw new Error("ACCOUNT_NOT_FOUND");
    }

    const sender = accountResult.rows.find(
      (account) => account.id === input.fromAccountId
    );

    const receiver = accountResult.rows.find(
      (account) => account.id === input.toAccountId
    );

    if (!sender || !receiver) {
      throw new Error("ACCOUNT_NOT_FOUND");
    }

    // Test-only synchronization point.
// Production route does not provide this callback.
if (afterBalanceRead) {
  await afterBalanceRead();
}

    if (sender.status !== "ACTIVE" || receiver.status !== "ACTIVE") {
      throw new Error("ACCOUNT_NOT_ACTIVE");
    }

    const amount = BigInt(input.amountPaise);
    const senderBalance = BigInt(sender.balance_paise);
    const receiverBalance = BigInt(receiver.balance_paise);

    if (senderBalance < amount) {
      throw new Error("INSUFFICIENT_FUNDS");
    }

    // These values are calculated from the balances read above.
    // This intentionally allows stale values during concurrent transfers.
    const newSenderBalance = senderBalance - amount;
    const newReceiverBalance = receiverBalance + amount;

    const transferResult = await client.query(
      `
      INSERT INTO transfers (
        from_account_id,
        to_account_id,
        amount_paise,
        status
      )
      VALUES ($1, $2, $3, 'PENDING')
      RETURNING
        id,
        from_account_id,
        to_account_id,
        amount_paise,
        status,
        created_at
      `,
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

    // Intentionally overwrite with values calculated from the earlier read.
    await client.query(
      `
      UPDATE accounts
      SET balance_paise = $1, updated_at = NOW()
      WHERE id = $2
      `,
      [newSenderBalance.toString(), input.fromAccountId]
    );

    await client.query(
      `
      UPDATE accounts
      SET balance_paise = $1, updated_at = NOW()
      WHERE id = $2
      `,
      [newReceiverBalance.toString(), input.toAccountId]
    );

    await client.query(
      `
      UPDATE transfers
      SET status = 'COMPLETED'
      WHERE id = $1
      `,
      [transfer.id]
    );

    const payload = {
      transferId: transfer.id,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountPaise: input.amountPaise,
    };

    await client.query(
      `
      INSERT INTO outbox (
        transfer_id,
        event_type,
        payload
      )
      VALUES ($1, 'TRANSFER_COMPLETED', $2::jsonb)
      `,
      [transfer.id, JSON.stringify(payload)]
    );

    commitStarted = true;
    await client.query("COMMIT");

    return {
      ...transfer,
      status: "COMPLETED",
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort rollback only.
    }

    if (commitStarted) {
      throw new Error("TRANSFER_COMMIT_OUTCOME_UNKNOWN");
    }

    throw error;
  } finally {
    client.release();
  }
}