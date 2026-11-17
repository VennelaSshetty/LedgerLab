
import { afterAll, describe, expect, it } from "vitest";
import * as fc from "fast-check";

import {
  createStressFixture,
  cleanupStressFixture,
  startStressServer,
  type StressFixture,
  type StressServer,
} from "../helpers/transfer-stress-fixtures";

import { adminPool } from "../helpers/admin-pool";
import { propertyTestParameters } from "../helpers/property-test-config";
import { POSTGRES_BIGINT_MAX } from "../helpers/transfer-arbitraries";

type TransferOperation = {
  amountPaise: bigint;
};

type ExpectedOutcome = {
  success: boolean;
  senderBalance: bigint;
  receiverBalance: bigint;
};

const INITIAL_SENDER_BALANCE = 1_000_000n;
const INITIAL_RECEIVER_BALANCE = 500_000n;
const OPERATIONS_PER_RUN = 20;

const transferSequenceArb: fc.Arbitrary<TransferOperation[]> =
  fc.array(
    fc.record({
      amountPaise: fc.bigInt({
        min: 1n,
        max: 300_000n,
      }),
    }),
    {
      minLength: OPERATIONS_PER_RUN,
      maxLength: OPERATIONS_PER_RUN,
    },
  );

describe("Database-backed transfer properties - Safe Mode", () => {
  let fixture: StressFixture | undefined;
  let server: StressServer | undefined;

  afterAll(async () => {
    if (server) {
      await server.close();
    }

    if (fixture) {
      await cleanupStressFixture(fixture);
    }
  });

  it("matches generated transfer outcomes against PostgreSQL state", async () => {
    server = await startStressServer();

    await fc.assert(
      fc.asyncProperty(
        transferSequenceArb,
        async (operations) => {
          // Each generated run gets fresh isolated accounts.
          fixture = await createStressFixture([
            INITIAL_SENDER_BALANCE.toString(),
            INITIAL_RECEIVER_BALANCE.toString(),
          ]);

          const [senderId, receiverId] = fixture.accountIds;

          let expectedSenderBalance = INITIAL_SENDER_BALANCE;
          let expectedReceiverBalance = INITIAL_RECEIVER_BALANCE;

          const expectedOutcomes: ExpectedOutcome[] = [];

          for (let index = 0; index < operations.length; index++) {
            const operation = operations[index];
            const amount = operation.amountPaise;

            const expectedSuccess =
              expectedSenderBalance >= amount &&
              expectedReceiverBalance <= POSTGRES_BIGINT_MAX - amount;

            if (expectedSuccess) {
              expectedSenderBalance -= amount;
              expectedReceiverBalance += amount;
            }

            expectedOutcomes.push({
              success: expectedSuccess,
              senderBalance: expectedSenderBalance,
              receiverBalance: expectedReceiverBalance,
            });

            const response = await fetch(
              `${server!.baseUrl}/api/transfers`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Key": `property-${index}-${crypto.randomUUID()}`,
                },
                body: JSON.stringify({
                  fromAccountId: senderId,
                  toAccountId: receiverId,
                  amountPaise: amount.toString(),
                }),
              },
            );

            const responseBody = await response.json();

            if (expectedSuccess) {
              expect(response.status).toBe(201);
              expect(responseBody.transfer.status).toBe("COMPLETED");
            } else {
              expect(response.status).toBe(409);
              expect(responseBody.error.code).toBe("INSUFFICIENT_FUNDS");
            }
          }

          // Independently inspect PostgreSQL using the admin connection.
          const balancesResult = await adminPool.query<{
            id: string;
            balance_paise: string;
          }>(
            `SELECT id, balance_paise
             FROM accounts
             WHERE id = ANY($1::uuid[])`,
            [[senderId, receiverId]],
          );

          const sender = balancesResult.rows.find(
            (row) => row.id === senderId,
          );

          const receiver = balancesResult.rows.find(
            (row) => row.id === receiverId,
          );

          expect(sender).toBeDefined();
          expect(receiver).toBeDefined();

          expect(BigInt(sender!.balance_paise)).toBe(
            expectedSenderBalance,
          );

          expect(BigInt(receiver!.balance_paise)).toBe(
            expectedReceiverBalance,
          );

          // Every successful transfer must have exactly two ledger entries.
          const transferResult = await adminPool.query<{
            id: string;
            amount_paise: string;
            status: string;
          }>(
            `SELECT id, amount_paise, status
             FROM transfers
             WHERE from_account_id = $1
               AND to_account_id = $2`,
            [senderId, receiverId],
          );

          const successfulCount = expectedOutcomes.filter(
            (outcome) => outcome.success,
          ).length;

          expect(transferResult.rows).toHaveLength(successfulCount);

          for (const transfer of transferResult.rows) {
            expect(transfer.status).toBe("COMPLETED");

            const ledgerResult = await adminPool.query<{
              account_id: string;
              entry_type: string;
              amount_paise: string;
            }>(
              `SELECT account_id, entry_type, amount_paise
               FROM ledger_entries
               WHERE transfer_id = $1`,
              [transfer.id],
            );

            expect(ledgerResult.rows).toHaveLength(2);

            const debit = ledgerResult.rows.find(
              (entry) => entry.entry_type === "DEBIT",
            );

            const credit = ledgerResult.rows.find(
              (entry) => entry.entry_type === "CREDIT",
            );

            expect(debit?.account_id).toBe(senderId);
            expect(credit?.account_id).toBe(receiverId);

            expect(BigInt(debit!.amount_paise)).toBe(
              BigInt(transfer.amount_paise),
            );

            expect(BigInt(credit!.amount_paise)).toBe(
              BigInt(transfer.amount_paise),
            );
          }

          // No failed operation may leave an outbox event.
          const outboxResult = await adminPool.query<{ count: string }>(
            `SELECT COUNT(*) AS count
             FROM outbox
             WHERE transfer_id IN (
               SELECT id
               FROM transfers
               WHERE from_account_id = $1
                 AND to_account_id = $2
             )`,
            [senderId, receiverId],
          );

          expect(Number(outboxResult.rows[0].count)).toBe(
            successfulCount,
          );

          expect(
            expectedSenderBalance + expectedReceiverBalance,
          ).toBe(
            INITIAL_SENDER_BALANCE + INITIAL_RECEIVER_BALANCE,
          );

          // Clean this generated run before fast-check tries another.
          await cleanupStressFixture(fixture);
          fixture = undefined;
        },
      ),
      {
        ...propertyTestParameters,
        numRuns: Math.min(propertyTestParameters.numRuns, 50),
           },
    );
  }, 120_000);
});
