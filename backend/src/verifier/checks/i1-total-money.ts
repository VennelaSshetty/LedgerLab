
import { verifierPool } from "../../db/verifier-pool";

type CheckStatus = "PASS" | "FAIL" | "NOT VERIFIED";

interface I1Result {
  invariant: "I1";
  name: string;
  status: CheckStatus;
  message: string;
  expectedTotalPaise?: string;
  actualTotalPaise?: string;
  missingOpeningBalanceAccounts?: string;
}

interface I1QueryResult {
  opening_total_paise: string;
  current_total_paise: string;
  missing_opening_balance_accounts: string;
}

export async function verifyI1TotalMoney(
  accountIds?: string[],
): Promise<I1Result> {
  try {
    const result = await verifierPool.query<I1QueryResult>(
      `
      WITH scoped_accounts AS (
        SELECT
          a.id,
          a.balance_paise
        FROM accounts a
        WHERE
          $1::uuid[] IS NULL
          OR a.id = ANY($1::uuid[])
      )
      SELECT
        (
          SELECT COALESCE(SUM(ob.amount_paise), 0)::text
          FROM account_opening_balances ob
          JOIN scoped_accounts sa
            ON sa.id = ob.account_id
        ) AS opening_total_paise,

        (
          SELECT COALESCE(SUM(sa.balance_paise), 0)::text
          FROM scoped_accounts sa
        ) AS current_total_paise,

        (
          SELECT COUNT(*)::text
          FROM scoped_accounts sa
          LEFT JOIN account_opening_balances ob
            ON ob.account_id = sa.id
          WHERE ob.account_id IS NULL
        ) AS missing_opening_balance_accounts;
      `,
      [accountIds ?? null],
    );

    const row = result.rows[0];

    const expectedTotal = BigInt(row.opening_total_paise);
    const actualTotal = BigInt(row.current_total_paise);
    const missingBaselines = BigInt(
      row.missing_opening_balance_accounts,
    );

    if (missingBaselines > 0n) {
      return {
        invariant: "I1",
        name: "Total money conservation",
        status: "NOT VERIFIED",
        message:
          "Cannot verify total money because some accounts are missing opening-balance records.",
        expectedTotalPaise: row.opening_total_paise,
        actualTotalPaise: row.current_total_paise,
        missingOpeningBalanceAccounts:
          row.missing_opening_balance_accounts,
      };
    }

    if (expectedTotal !== actualTotal) {
      return {
        invariant: "I1",
        name: "Total money conservation",
        status: "FAIL",
        message:
          "Total current account balances do not match the original opening balances.",
        expectedTotalPaise: row.opening_total_paise,
        actualTotalPaise: row.current_total_paise,
        missingOpeningBalanceAccounts: "0",
      };
    }

    return {
      invariant: "I1",
      name: "Total money conservation",
      status: "PASS",
      message:
        "Total current account balances match the original opening balances.",
      expectedTotalPaise: row.opening_total_paise,
      actualTotalPaise: row.current_total_paise,
      missingOpeningBalanceAccounts: "0",
    };
  } catch (error) {
    return {
      invariant: "I1",
      name: "Total money conservation",
      status: "NOT VERIFIED",
      message:
        error instanceof Error
          ? `Could not execute verification: ${error.message}`
          : "Could not execute verification due to an unknown error.",
    };
  }
}
