
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
const OPERATIONS_PER_RUN = 20;

type Direction = "A_TO_B" | "B_TO_A";

type ConcurrentOperation = {
  direction: Direction;
  amountPaise: bigint;
};

type SuccessfulTransfer = {
  id: string;
  fromAccountId: string;
  toAccountId: string;
  amountPaise: bigint;
};

const concurrentOperationArb: fc.Arbitrary<ConcurrentOperation> =
  fc.record({
    direction: fc.constantFrom("A_TO_B", "B_TO_A"),
    amountPaise: fc.bigInt({
      min: 1n,
      max: 1_500_000n,
    }),
  });

const concurrentSequenceArb: fc.Arbitrary<ConcurrentOperation[]> =
  fc.array(concurrentOperationArb, {
    minLength: OPERATIONS_PER_RUN,
    maxLength: OPERATIONS_PER_RUN,
  });

describe("Randomized concurrency properties - Safe Mode", () => {
  it(
    "preserves transfer invariants under concurrent generated requests",
    async () => {
      const server = await startStressServer();

      try {
        await fc.assert(
          fc.asyncProperty(
            concurrentSequenceArb,
            async (operations) => {
              const fixture = await createStressFixture([
                INITIAL_BALANCE.toString(),
                INITIAL_BALANCE.toString(),
              ]);

              try {
                const [accountA, accountB] = fixture.accountIds;

                // Submit all generated transfers simultaneously.
                const responses = await Promise.all(
                  operations.map(async (operation, index) => {
                    const fromAccountId =
                      operation.direction === "A_TO_B"
                        ? accountA
                        : accountB;

                    const toAccountId =
                      operation.direction === "A_TO_B"
                        ? accountB
                        : accountA;

                    const response = await fetch(
                      `${server.baseUrl}/api/transfers`,
                      {
                        method: "POST",
                        headers: {
                          "Content-Type": "application/json",
                          "Idempotency-Key":
                            `concurrency-${index}-${crypto.randomUUID()}`,
                        },
                        body: JSON.stringify({
                          fromAccountId,
                          toAccountId,
                          amountPaise: operation.amountPaise.toString(),
                        }),
                      },
                    );

                    return {
                      status: response.status,
                      body: await response.json(),
                      fromAccountId,
                      toAccountId,
                      amountPaise: operation.amountPaise,
                    };
                  }),
                );

                const successfulTransfers: SuccessfulTransfer[] = [];

                // Every request must either complete or fail for insufficient funds.
                for (const response of responses) {
                  if (response.status === 201) {
                    expect(response.body.transfer.status).toBe(
                      "COMPLETED",
                    );

                    successfulTransfers.push({
                      id: response.body.transfer.id,
                      fromAccountId: response.fromAccountId,
                      toAccountId: response.toAccountId,
                      amountPaise: response.amountPaise,
                    });
                  } else {
                    expect(response.status).toBe(409);
                    expect(response.body.error.code).toBe(
                      "INSUFFICIENT_FUNDS",
                    );
                  }
                }

                // Independently inspect final account balances.
                const accountsResult = await adminPool.query<{
                  id: string;
                  balance_paise: string;
                }>(
                  `SELECT id, balance_paise
                   FROM accounts
                   WHERE id = ANY($1::uuid[])`,
                  [[accountA, accountB]],
                );

                expect(accountsResult.rows).toHaveLength(2);

                const balances = new Map(
                  accountsResult.rows.map((row) => [
                    row.id,
                    BigInt(row.balance_paise),
                  ]),
                );

                const balanceA = balances.get(accountA)!;
                const balanceB = balances.get(accountB)!;

                // I1: Total money must remain constant.
                expect(balanceA + balanceB).toBe(
                  INITIAL_BALANCE * 2n,
                );

                // I3: Neither account may become negative.
                expect(balanceA).toBeGreaterThanOrEqual(0n);
                expect(balanceB).toBeGreaterThanOrEqual(0n);

                // Every acknowledged transfer must exist exactly once.
                const transfersResult = await adminPool.query<{
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
                  [[accountA, accountB]],
                );

                expect(transfersResult.rows).toHaveLength(
                  successfulTransfers.length,
                );

                const successfulIds = successfulTransfers
                  .map((transfer) => transfer.id)
                  .sort();

                const databaseIds = transfersResult.rows
                  .map((transfer) => transfer.id)
                  .sort();

                expect(databaseIds).toEqual(successfulIds);

                for (const transfer of transfersResult.rows) {
                  expect(transfer.status).toBe("COMPLETED");
                }

                // Inspect all transfer ledger entries for these accounts.
                const ledgerResult = await adminPool.query<{
                  transfer_id: string | null;
                  account_id: string;
                  entry_type: string;
                  amount_paise: string;
                }>(
                  `SELECT transfer_id, account_id,
                          entry_type, amount_paise
                   FROM ledger_entries
                   WHERE account_id = ANY($1::uuid[])
                     AND transfer_id IS NOT NULL`,
                  [[accountA, accountB]],
                );

                // I5: Each successful transfer must have exactly two entries.
                expect(ledgerResult.rows).toHaveLength(
                  successfulTransfers.length * 2,
                );

                let totalDebits = 0n;
                let totalCredits = 0n;

                const ledgerChanges = new Map<string, bigint>([
                  [accountA, 0n],
                  [accountB, 0n],
                ]);

                for (const entry of ledgerResult.rows) {
                  const amount = BigInt(entry.amount_paise);

                  if (entry.entry_type === "DEBIT") {
                    totalDebits += amount;
                    ledgerChanges.set(
                      entry.account_id,
                      ledgerChanges.get(entry.account_id)! - amount,
                    );
                  } else if (entry.entry_type === "CREDIT") {
                    totalCredits += amount;
                    ledgerChanges.set(
                      entry.account_id,
                      ledgerChanges.get(entry.account_id)! + amount,
                    );
                  } else {
                    throw new Error(
                      `Unexpected ledger entry type: ${entry.entry_type}`,
                    );
                  }
                }

                // I2: Total debits must equal total credits.
                expect(totalDebits).toBe(totalCredits);

                // Every transfer has one matching debit and one matching credit.
                for (const transfer of transfersResult.rows) {
                  const entries = ledgerResult.rows.filter(
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

                // I6: Account balance projections must match the ledger.
                expect(balanceA).toBe(
                  INITIAL_BALANCE + ledgerChanges.get(accountA)!,
                );

                expect(balanceB).toBe(
                  INITIAL_BALANCE + ledgerChanges.get(accountB)!,
                );

                // Each successful transfer must have an outbox record.
                const outboxResult = await adminPool.query<{
                  count: string;
                }>(
                  `SELECT COUNT(*) AS count
                   FROM outbox
                   WHERE transfer_id = ANY($1::uuid[])`,
                  [successfulIds],
                );

                expect(Number(outboxResult.rows[0].count)).toBe(
                  successfulTransfers.length,
                );

                // Each successful request must have an idempotency record.
                const idempotencyResult = await adminPool.query<{
                  count: string;
                }>(
                  `SELECT COUNT(*) AS count
                   FROM idempotency_keys
                   WHERE user_id = $1`,
                  [fixture.userId],
                );

                expect(Number(idempotencyResult.rows[0].count)).toBe(
                  successfulTransfers.length,
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
