import { verifierPool } from "../../db/verifier-pool";

type CheckStatus = "PASS" | "FAIL" | "NOT VERIFIED";

interface I6Result {
  invariant: "I6";
  name: string;
  status: CheckStatus;
  message: string;
  inconsistentAccountCount?: string;
  inconsistentAccounts?: Array<{
    accountId: string;
    openingBalancePaise: string | null;
    totalCreditsPaise: string;
    totalDebitsPaise: string;
    expectedBalancePaise: string | null;
    actualBalancePaise: string;
  }>;
}

interface InconsistentAccountRow {
  account_id: string;
  opening_balance_paise: string | null;
  total_credits_paise: string;
  total_debits_paise: string;
  expected_balance_paise: string | null;
  actual_balance_paise: string;
}

export async function verifyI6ProjectionConsistency(
  accountIds?: string[],
): Promise<I6Result> {
  try {
    const result = await verifierPool.query<InconsistentAccountRow>(
      `
      WITH scoped_accounts AS (
        SELECT
          a.id,
          a.balance_paise
        FROM accounts a
        WHERE
          $1::uuid[] IS NULL
          OR a.id = ANY($1::uuid[])
      ),

      ledger_totals AS (
        SELECT
          le.account_id,

          COALESCE(
            SUM(le.amount_paise) FILTER (
              WHERE le.entry_type = 'CREDIT'
            ),
            0
          ) AS total_credits,

          COALESCE(
            SUM(le.amount_paise) FILTER (
              WHERE le.entry_type = 'DEBIT'
            ),
            0
          ) AS total_debits

        FROM ledger_entries le

        JOIN scoped_accounts sa
          ON sa.id = le.account_id

        GROUP BY le.account_id
      ),

      account_balances AS (
        SELECT
          sa.id AS account_id,
          ob.amount_paise AS opening_balance,
          COALESCE(lt.total_credits, 0) AS total_credits,
          COALESCE(lt.total_debits, 0) AS total_debits,
          sa.balance_paise AS actual_balance,

          CASE
            WHEN ob.account_id IS NULL THEN NULL
            ELSE
              ob.amount_paise
              + COALESCE(lt.total_credits, 0)
              - COALESCE(lt.total_debits, 0)
          END AS expected_balance

        FROM scoped_accounts sa

        LEFT JOIN account_opening_balances ob
          ON ob.account_id = sa.id

        LEFT JOIN ledger_totals lt
          ON lt.account_id = sa.id
      )

      SELECT
        account_id::text AS account_id,
        opening_balance::text AS opening_balance_paise,
        total_credits::text AS total_credits_paise,
        total_debits::text AS total_debits_paise,
        expected_balance::text AS expected_balance_paise,
        actual_balance::text AS actual_balance_paise

      FROM account_balances

      WHERE
        opening_balance IS NULL
        OR actual_balance::numeric <> expected_balance

      ORDER BY account_id;
      `,
      [accountIds ?? null],
    );

    if (result.rows.length > 0) {
      return {
        invariant: "I6",
        name: "Projection-versus-ledger consistency",
        status: "FAIL",
        message:
          "One or more account projections do not match their opening balances and ledger entries.",
        inconsistentAccountCount: String(result.rows.length),
        inconsistentAccounts: result.rows.map((row) => ({
          accountId: row.account_id,
          openingBalancePaise: row.opening_balance_paise,
          totalCreditsPaise: row.total_credits_paise,
          totalDebitsPaise: row.total_debits_paise,
          expectedBalancePaise: row.expected_balance_paise,
          actualBalancePaise: row.actual_balance_paise,
        })),
      };
    }

    return {
      invariant: "I6",
      name: "Projection-versus-ledger consistency",
      status: "PASS",
      message:
        "Every account balance matches its opening balance and ledger entries.",
      inconsistentAccountCount: "0",
      inconsistentAccounts: [],
    };
  } catch (error) {
    return {
      invariant: "I6",
      name: "Projection-versus-ledger consistency",
      status: "NOT VERIFIED",
      message:
        error instanceof Error
          ? `Could not execute verification: ${error.message}`
          : "Could not execute verification due to an unknown error.",
    };
  }
}