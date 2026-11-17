import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifierPool } from "../db/verifier-pool";

type Status = "PASS" | "FAIL" | "NOT VERIFIED";

interface Result {
  invariant: string;
  status: Status;
  message: string;
}

async function runComparisonVerification(): Promise<void> {
  const workloadPath = resolve(
    process.cwd(),
    "workloads/naive-comparison-workload-12345.json",
  );

  const workload = JSON.parse(await readFile(workloadPath, "utf8"));

  const accountIds = [
    ...new Set<string>(
      workload.transfers
        .filter((transfer: { expectedValidity: string }) =>
          transfer.expectedValidity === "VALID"
        )
        .flatMap((transfer: {
          fromAccountId: string;
          toAccountId: string;
        }) => [transfer.fromAccountId, transfer.toAccountId]),
    ),
  ];

  if (accountIds.length !== 10) {
    throw new Error(
      `Expected 10 valid workload accounts, found ${accountIds.length}.`,
    );
  }

  console.log("\n===== SCOPED COMPARISON VERIFIER =====");
  console.log("Workload seed:", workload.config.seed);
  console.log("Scoped accounts:", accountIds.length);

  const results: Result[] = [];

  // I1: Total money conservation, restricted to the 10 accounts.
  const i1 = await verifierPool.query<{
    account_count: string;
    baseline_count: string;
    opening_total: string;
    current_total: string;
  }>(
    `
    SELECT
      COUNT(a.id)::text AS account_count,
      COUNT(ob.account_id)::text AS baseline_count,
      COALESCE(SUM(ob.amount_paise), 0)::text AS opening_total,
      COALESCE(SUM(a.balance_paise), 0)::text AS current_total
    FROM accounts a
    LEFT JOIN account_opening_balances ob
      ON ob.account_id = a.id
    WHERE a.id = ANY($1::uuid[]);
    `,
    [accountIds],
  );

  const money = i1.rows[0];
  const i1Valid =
    BigInt(money.account_count) === 10n &&
    BigInt(money.baseline_count) === 10n;

  results.push({
    invariant: "I1",
    status: !i1Valid
      ? "NOT VERIFIED"
      : BigInt(money.opening_total) === BigInt(money.current_total)
        ? "PASS"
        : "FAIL",
    message: `Accounts: ${money.account_count}/10; baselines: ${money.baseline_count}/10; opening total: ${money.opening_total}; current total: ${money.current_total} paise.`,
  });

  // I2: Debit-credit equality for transfers touching the scoped accounts.
  const i2 = await verifierPool.query<{
    debits: string;
    credits: string;
    imbalanced: string;
  }>(
    `
    WITH scoped_transfers AS (
      SELECT id
      FROM transfers
      WHERE from_account_id = ANY($1::uuid[])
         OR to_account_id = ANY($1::uuid[])
    ),
    per_transfer AS (
      SELECT
        le.transfer_id,
        COALESCE(SUM(le.amount_paise) FILTER (
          WHERE le.entry_type = 'DEBIT'
        ), 0) AS debits,
        COALESCE(SUM(le.amount_paise) FILTER (
          WHERE le.entry_type = 'CREDIT'
        ), 0) AS credits
      FROM ledger_entries le
      JOIN scoped_transfers st ON st.id = le.transfer_id
      GROUP BY le.transfer_id
    )
    SELECT
      COALESCE(SUM(debits), 0)::text AS debits,
      COALESCE(SUM(credits), 0)::text AS credits,
      COUNT(*) FILTER (
        WHERE debits <> credits
      )::text AS imbalanced
    FROM per_transfer;
    `,
    [accountIds],
  );

  const debitCredit = i2.rows[0];
  results.push({
    invariant: "I2",
    status:
      BigInt(debitCredit.debits) === BigInt(debitCredit.credits) &&
      BigInt(debitCredit.imbalanced) === 0n
        ? "PASS"
        : "FAIL",
    message: `Debits: ${debitCredit.debits}; credits: ${debitCredit.credits} paise; imbalanced transfers: ${debitCredit.imbalanced}.`,
  });

  // I3: No negative balances in the scoped accounts.
  const i3 = await verifierPool.query<{ count: string }>(
    `
    SELECT COUNT(*)::text AS count
    FROM accounts
    WHERE id = ANY($1::uuid[])
      AND balance_paise < 0;
    `,
    [accountIds],
  );

  results.push({
    invariant: "I3",
    status: BigInt(i3.rows[0].count) === 0n ? "PASS" : "FAIL",
    message: `Negative balances: ${i3.rows[0].count}.`,
  });

  // I4: Acknowledgement history is not currently implemented.
  results.push({
    invariant: "I4",
    status: "NOT VERIFIED",
    message: "Acknowledgement-history recording has not been implemented.",
  });

  // I5: No partial transfers touching the scoped accounts.
  const i5 = await verifierPool.query<{ count: string }>(
    `
    SELECT COUNT(*)::text AS count
    FROM (
      SELECT
        t.id,
        t.status,
        t.amount_paise,
        t.from_account_id,
        t.to_account_id
      FROM transfers t
      LEFT JOIN ledger_entries le ON le.transfer_id = t.id
      WHERE t.from_account_id = ANY($1::uuid[])
         OR t.to_account_id = ANY($1::uuid[])
      GROUP BY
        t.id, t.status, t.amount_paise,
        t.from_account_id, t.to_account_id
      HAVING
        (
          t.status = 'COMPLETED'
          AND (
            COUNT(le.id) <> 2
            OR COUNT(le.id) FILTER (
              WHERE le.entry_type = 'DEBIT'
            ) <> 1
            OR COUNT(le.id) FILTER (
              WHERE le.entry_type = 'CREDIT'
            ) <> 1
            OR COUNT(le.id) FILTER (
              WHERE le.id IS NOT NULL
                AND le.amount_paise <> t.amount_paise
            ) > 0
            OR COUNT(le.id) FILTER (
              WHERE
                (le.entry_type = 'DEBIT'
                  AND le.account_id <> t.from_account_id)
                OR
                (le.entry_type = 'CREDIT'
                  AND le.account_id <> t.to_account_id)
            ) > 0
          )
        )
        OR (
          t.status IN ('PENDING', 'FAILED')
          AND COUNT(le.id) <> 0
        )
    ) invalid_transfers;
    `,
    [accountIds],
  );

  results.push({
    invariant: "I5",
    status: BigInt(i5.rows[0].count) === 0n ? "PASS" : "FAIL",
    message: `Invalid or partial transfers: ${i5.rows[0].count}.`,
  });

  // I6: Account balance projections match opening balances plus ledger.
  const i6 = await verifierPool.query<{ count: string }>(
    `
    WITH ledger_totals AS (
      SELECT
        account_id,
        COALESCE(SUM(amount_paise) FILTER (
          WHERE entry_type = 'CREDIT'
        ), 0) AS credits,
        COALESCE(SUM(amount_paise) FILTER (
          WHERE entry_type = 'DEBIT'
        ), 0) AS debits
      FROM ledger_entries
      WHERE account_id = ANY($1::uuid[])
      GROUP BY account_id
    )
    SELECT COUNT(*)::text AS count
    FROM accounts a
    LEFT JOIN account_opening_balances ob
      ON ob.account_id = a.id
    LEFT JOIN ledger_totals lt
      ON lt.account_id = a.id
    WHERE a.id = ANY($1::uuid[])
      AND (
        ob.account_id IS NULL
        OR a.balance_paise::numeric <>
          ob.amount_paise
          + COALESCE(lt.credits, 0)
          - COALESCE(lt.debits, 0)
      );
    `,
    [accountIds],
  );

  results.push({
    invariant: "I6",
    status: BigInt(i6.rows[0].count) === 0n ? "PASS" : "FAIL",
    message: `Inconsistent account projections: ${i6.rows[0].count}.`,
  });

  console.log("\n========== RESULTS ==========");

  for (const result of results) {
    console.log(`[${result.status}] ${result.invariant}: ${result.message}`);
  }

  const hasFailure = results.some((result) => result.status === "FAIL");
  const hasUnverified = results.some(
    (result) => result.status === "NOT VERIFIED",
  );

  const overall: Status = hasFailure
    ? "FAIL"
    : hasUnverified
      ? "NOT VERIFIED"
      : "PASS";

  console.log("\nOVERALL RESULT:", overall);
  console.log("==============================\n");

  if (overall === "FAIL") process.exitCode = 1;
  if (overall === "NOT VERIFIED") process.exitCode = 2;
}

runComparisonVerification()
  .catch((error: unknown) => {
    console.error("Scoped verification failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await verifierPool.end();
  });
