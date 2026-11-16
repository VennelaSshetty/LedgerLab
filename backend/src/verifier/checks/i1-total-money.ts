
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

export async function verifyI1TotalMoney(): Promise<I1Result> {
  try {
    const result = await verifierPool.query<I1QueryResult>(`
      SELECT
        (
          SELECT COALESCE(SUM(amount_paise), 0)::text
          FROM account_opening_balances
        ) AS opening_total_paise,

        (
          SELECT COALESCE(SUM(balance_paise), 0)::text
          FROM accounts
        ) AS current_total_paise,

        (
          SELECT COUNT(*)::text
          FROM accounts a
          LEFT JOIN account_opening_balances ob
            ON ob.account_id = a.id
          WHERE ob.account_id IS NULL
        ) AS missing_opening_balance_accounts;
    `);

    const row = result.rows[0];

    const expectedTotal = BigInt(row.opening_total_paise);
    const actualTotal = BigInt(row.current_total_paise);
    const missingBaselines = BigInt(
      row.missing_opening_balance_accounts
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
