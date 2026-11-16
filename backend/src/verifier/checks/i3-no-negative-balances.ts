
import { verifierPool } from "../../db/verifier-pool";

type CheckStatus = "PASS" | "FAIL" | "NOT VERIFIED";

interface I3Result {
  invariant: "I3";
  name: string;
  status: CheckStatus;
  message: string;
  negativeAccountCount?: string;
  negativeAccounts?: Array<{
    accountId: string;
    balancePaise: string;
  }>;
}

interface NegativeAccountRow {
  account_id: string;
  balance_paise: string;
}

export async function verifyI3NoNegativeBalances(): Promise<I3Result> {
  try {
    const result = await verifierPool.query<NegativeAccountRow>(`
      SELECT
        id::text AS account_id,
        balance_paise::text AS balance_paise
      FROM accounts
      WHERE balance_paise < 0
      ORDER BY id;
    `);

    if (result.rows.length > 0) {
      return {
        invariant: "I3",
        name: "No negative balances",
        status: "FAIL",
        message: "One or more accounts have negative balances.",
        negativeAccountCount: String(result.rows.length),
        negativeAccounts: result.rows.map((row) => ({
          accountId: row.account_id,
          balancePaise: row.balance_paise,
        })),
      };
    }

    return {
      invariant: "I3",
      name: "No negative balances",
      status: "PASS",
      message: "No accounts have negative balances.",
      negativeAccountCount: "0",
      negativeAccounts: [],
    };
  } catch (error) {
    return {
      invariant: "I3",
      name: "No negative balances",
      status: "NOT VERIFIED",
      message:
        error instanceof Error
          ? `Could not execute verification: ${error.message}`
          : "Could not execute verification due to an unknown error.",
    };
  }
}
