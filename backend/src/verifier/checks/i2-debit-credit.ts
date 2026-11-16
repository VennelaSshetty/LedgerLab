
import { verifierPool } from "../../db/verifier-pool";

type CheckStatus = "PASS" | "FAIL" | "NOT VERIFIED";

interface I2Result {
  invariant: "I2";
  name: string;
  status: CheckStatus;
  message: string;
  totalDebitsPaise?: string;
  totalCreditsPaise?: string;
  imbalancedTransfers?: string;
}

interface I2QueryResult {
  total_debits_paise: string;
  total_credits_paise: string;
  imbalanced_transfers: string;
}

export async function verifyI2DebitCredit(): Promise<I2Result> {
  try {
    const result = await verifierPool.query<I2QueryResult>(`
      WITH per_transfer AS (
        SELECT
          transfer_id,
          COALESCE(
            SUM(amount_paise) FILTER (WHERE entry_type = 'DEBIT'),
            0
          ) AS debit_total,
          COALESCE(
            SUM(amount_paise) FILTER (WHERE entry_type = 'CREDIT'),
            0
          ) AS credit_total
        FROM ledger_entries
        GROUP BY transfer_id
      )
      SELECT
        (
          SELECT COALESCE(
            SUM(amount_paise) FILTER (WHERE entry_type = 'DEBIT'),
            0
          )::text
          FROM ledger_entries
        ) AS total_debits_paise,

        (
          SELECT COALESCE(
            SUM(amount_paise) FILTER (WHERE entry_type = 'CREDIT'),
            0
          )::text
          FROM ledger_entries
        ) AS total_credits_paise,

        (
          SELECT COUNT(*)::text
          FROM per_transfer
          WHERE debit_total <> credit_total
        ) AS imbalanced_transfers;
    `);

    const row = result.rows[0];

    const totalDebits = BigInt(row.total_debits_paise);
    const totalCredits = BigInt(row.total_credits_paise);
    const imbalancedTransfers = BigInt(row.imbalanced_transfers);

    if (
      totalDebits !== totalCredits ||
      imbalancedTransfers > 0n
    ) {
      return {
        invariant: "I2",
        name: "Debit-credit equality",
        status: "FAIL",
        message:
          "Ledger debit and credit amounts are not balanced.",
        totalDebitsPaise: row.total_debits_paise,
        totalCreditsPaise: row.total_credits_paise,
        imbalancedTransfers: row.imbalanced_transfers,
      };
    }

    return {
      invariant: "I2",
      name: "Debit-credit equality",
      status: "PASS",
      message:
        "Total debits equal total credits, and every transfer is individually balanced.",
      totalDebitsPaise: row.total_debits_paise,
      totalCreditsPaise: row.total_credits_paise,
      imbalancedTransfers: "0",
    };
  } catch (error) {
    return {
      invariant: "I2",
      name: "Debit-credit equality",
      status: "NOT VERIFIED",
      message:
        error instanceof Error
          ? `Could not execute verification: ${error.message}`
          : "Could not execute verification due to an unknown error.",
    };
  }
}
