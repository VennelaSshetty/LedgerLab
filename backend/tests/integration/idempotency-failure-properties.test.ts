
import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { adminPool } from "../helpers/admin-pool";
import {
  createStressFixture,
  cleanupStressFixture,
  startStressServer,
} from "../helpers/transfer-stress-fixtures";
import { propertyTestParameters } from "../helpers/property-test-config";

const INITIAL_BALANCE = 1_000_000n;

type ApiResponse = {
  transfer?: {
    id: string;
    status: string;
  };
  replayed?: boolean;
  error?: {
    code: string;
    message: string;
  };
};

async function postTransfer(
  baseUrl: string,
  fromAccountId: string,
  toAccountId: string,
  amountPaise: string,
  idempotencyKey: string,
): Promise<{ status: number; body: ApiResponse }> {
  const response = await fetch(`${baseUrl}/api/transfers`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      fromAccountId,
      toAccountId,
      amountPaise,
    }),
  });

  return {
    status: response.status,
    body: await response.json() as ApiResponse,
  };
}

async function setAccountStatus(
  accountId: string,
  status: "ACTIVE" | "FROZEN",
): Promise<void> {
  await adminPool.query(
    `UPDATE accounts SET status = $1 WHERE id = $2`,
    [status, accountId],
  );
}

const generatedCaseArb = fc.record({
  amountPaise: fc.bigInt({
    min: 1n,
    max: 10_000n,
  }),
  missingAccountId: fc.uuid(),
});

describe("Idempotency and failure properties - Safe Mode", () => {
  it(
    "preserves atomicity across generated duplicate and rejected requests",
    async () => {
      const server = await startStressServer();

      try {
        await fc.assert(
          fc.asyncProperty(
            generatedCaseArb,
            async ({ amountPaise, missingAccountId }) => {
              const fixture = await createStressFixture([
                INITIAL_BALANCE.toString(),
                INITIAL_BALANCE.toString(),
              ]);

              try {
                const [senderId, receiverId] = fixture.accountIds;

                // 1. Identical duplicate request: second request must replay.
                const duplicateKey = "property-duplicate-key";
                const duplicateAmount = amountPaise.toString();

                const firstDuplicate = await postTransfer(
                  server.baseUrl,
                  senderId,
                  receiverId,
                  duplicateAmount,
                  duplicateKey,
                );

                expect(firstDuplicate.status).toBe(201);
                expect(firstDuplicate.body.transfer?.status).toBe(
                  "COMPLETED",
                );

                const secondDuplicate = await postTransfer(
                  server.baseUrl,
                  senderId,
                  receiverId,
                  duplicateAmount,
                  duplicateKey,
                );

                expect(secondDuplicate.status).toBe(200);
                expect(secondDuplicate.body.replayed).toBe(true);
                expect(secondDuplicate.body.transfer?.id).toBe(
                  firstDuplicate.body.transfer?.id,
                );

                // 2. Same key, different request: reject without a second transfer.
                const reusedKey = "property-reused-key";

                const firstReused = await postTransfer(
                  server.baseUrl,
                  senderId,
                  receiverId,
                  "100",
                  reusedKey,
                );

                expect(firstReused.status).toBe(201);

                const secondReused = await postTransfer(
                  server.baseUrl,
                  receiverId,
                  senderId,
                  "200",
                  reusedKey,
                );

                expect(secondReused.status).toBe(409);
                expect(secondReused.body.error?.code).toBe(
                  "IDEMPOTENCY_KEY_REUSED",
                );

                // 3. Malformed account ID.
                const malformed = await postTransfer(
                  server.baseUrl,
                  "not-a-uuid",
                  receiverId,
                  "10",
                  "property-malformed-id",
                );

                expect(malformed.status).toBe(400);
                expect(malformed.body.error?.code).toBe(
                  "INVALID_ACCOUNT_ID",
                );

                // 4. Well-formed but nonexistent account ID.
                const nonexistent = await postTransfer(
                  server.baseUrl,
                  missingAccountId,
                  receiverId,
                  "10",
                  "property-nonexistent-id",
                );

                expect(nonexistent.status).toBe(404);
                expect(nonexistent.body.error?.code).toBe(
                  "ACCOUNT_NOT_FOUND",
                );

                // 5. Frozen sender.
                await setAccountStatus(senderId, "FROZEN");

                try {
                  const frozenSender = await postTransfer(
                    server.baseUrl,
                    senderId,
                    receiverId,
                    "10",
                    "property-frozen-sender",
                  );

                  expect(frozenSender.status).toBe(409);
                  expect(frozenSender.body.error?.code).toBe(
                    "ACCOUNT_NOT_ACTIVE",
                  );
                } finally {
                  await setAccountStatus(senderId, "ACTIVE");
                }

                // 6. Frozen receiver.
                await setAccountStatus(receiverId, "FROZEN");

                try {
                  const frozenReceiver = await postTransfer(
                    server.baseUrl,
                    senderId,
                    receiverId,
                    "10",
                    "property-frozen-receiver",
                  );

                  expect(frozenReceiver.status).toBe(409);
                  expect(frozenReceiver.body.error?.code).toBe(
                    "ACCOUNT_NOT_ACTIVE",
                  );
                } finally {
                  await setAccountStatus(receiverId, "ACTIVE");
                }

                // 7. Insufficient funds.
                const insufficient = await postTransfer(
                  server.baseUrl,
                  senderId,
                  receiverId,
                  "999999999",
                  "property-insufficient-funds",
                );

                expect(insufficient.status).toBe(409);
                expect(insufficient.body.error?.code).toBe(
                  "INSUFFICIENT_FUNDS",
                );

                // 8. Same account as sender and receiver.
                const sameAccount = await postTransfer(
                  server.baseUrl,
                  senderId,
                  senderId,
                  "10",
                  "property-same-account",
                );

                expect(sameAccount.status).toBe(400);
                expect(sameAccount.body.error?.code).toBe(
                  "SAME_ACCOUNT_TRANSFER",
                );

                // Independently inspect PostgreSQL.
                const transfers = await adminPool.query<{
                  id: string;
                  from_account_id: string;
                  to_account_id: string;
                  amount_paise: string;
                  status: string;
                }>(
                  `SELECT id, from_account_id, to_account_id,
                          amount_paise, status
                   FROM transfers
                   WHERE from_account_id = ANY($1::uuid[])
                      OR to_account_id = ANY($1::uuid[])`,
                  [[senderId, receiverId]],
                );

                // Exactly two unique successful transfers:
                // one original duplicate request and one first reused-key request.
                expect(transfers.rows).toHaveLength(2);

                const duplicateTransfer = transfers.rows.find(
                  (row) =>
                    row.id === firstDuplicate.body.transfer?.id,
                );

                const reusedTransfer = transfers.rows.find(
                  (row) =>
                    row.id === firstReused.body.transfer?.id,
                );

                expect(duplicateTransfer).toBeDefined();
                expect(reusedTransfer).toBeDefined();

                for (const transfer of transfers.rows) {
                  expect(transfer.status).toBe("COMPLETED");
                }

                // Check balances using bigint only.
                const accounts = await adminPool.query<{
                  id: string;
                  balance_paise: string;
                  status: string;
                }>(
                  `SELECT id, balance_paise, status
                   FROM accounts
                   WHERE id = ANY($1::uuid[])`,
                  [[senderId, receiverId]],
                );

                const sender = accounts.rows.find(
                  (row) => row.id === senderId,
                );

                const receiver = accounts.rows.find(
                  (row) => row.id === receiverId,
                );

                expect(sender).toBeDefined();
                expect(receiver).toBeDefined();

                const expectedSenderBalance =
                  INITIAL_BALANCE - amountPaise - 100n;

                const expectedReceiverBalance =
                  INITIAL_BALANCE + amountPaise + 100n;

                expect(BigInt(sender!.balance_paise)).toBe(
                  expectedSenderBalance,
                );

                expect(BigInt(receiver!.balance_paise)).toBe(
                  expectedReceiverBalance,
                );

                expect(sender!.status).toBe("ACTIVE");
                expect(receiver!.status).toBe("ACTIVE");

                // Every successful transfer must have two ledger entries.
                const ledger = await adminPool.query<{
                  transfer_id: string;
                  account_id: string;
                  entry_type: string;
                  amount_paise: string;
                }>(
                  `SELECT transfer_id, account_id, entry_type, amount_paise
                   FROM ledger_entries
                   WHERE transfer_id = ANY($1::uuid[])`,
                  [transfers.rows.map((row) => row.id)],
                );

                expect(ledger.rows).toHaveLength(4);

                for (const transfer of transfers.rows) {
                  const entries = ledger.rows.filter(
                    (entry) => entry.transfer_id === transfer.id,
                  );

                  expect(entries).toHaveLength(2);

                  const debit = entries.find(
                    (entry) => entry.entry_type === "DEBIT",
                  );

                  const credit = entries.find(
                    (entry) => entry.entry_type === "CREDIT",
                  );

                  expect(debit?.account_id).toBe(
                    transfer.from_account_id,
                  );

                  expect(credit?.account_id).toBe(
                    transfer.to_account_id,
                  );

                  expect(BigInt(debit!.amount_paise)).toBe(
                    BigInt(transfer.amount_paise),
                  );

                  expect(BigInt(credit!.amount_paise)).toBe(
                    BigInt(transfer.amount_paise),
                  );
                }

                // Only successful unique transfers may have idempotency records.
                const idempotency = await adminPool.query<{
                  key: string;
                  transfer_id: string;
                }>(
                  `SELECT key, transfer_id
                   FROM idempotency_keys
                   WHERE user_id = $1`,
                  [fixture.userId],
                );

                expect(idempotency.rows).toHaveLength(2);

                const idempotencyTransferIds = idempotency.rows
                  .map((row) => row.transfer_id)
                  .sort();

                const transferIds = transfers.rows
                  .map((row) => row.id)
                  .sort();

                expect(idempotencyTransferIds).toEqual(transferIds);

                // Only successful unique transfers may have outbox records.
                const outbox = await adminPool.query<{
                  transfer_id: string;
                }>(
                  `SELECT transfer_id
                   FROM outbox
                   WHERE transfer_id = ANY($1::uuid[])`,
                  [transferIds],
                );

                expect(outbox.rows).toHaveLength(2);

                expect(
                  INITIAL_BALANCE * 2n,
                ).toBe(
                  BigInt(sender!.balance_paise) +
                    BigInt(receiver!.balance_paise),
                );
              } finally {
                await cleanupStressFixture(fixture);
              }
            },
          ),
          propertyTestParameters,
        );
      } finally {
        await server.close();
      }
    },
    180_000,
  );
});
