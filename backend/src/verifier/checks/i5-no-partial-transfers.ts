import { verifierPool } from "../../db/verifier-pool";

type CheckStatus = "PASS" | "FAIL" | "NOT VERIFIED";

interface I5Result {
  invariant: "I5";
  name: string;
  status: CheckStatus;
  message: string;
  invalidTransferCount?: string;
  invalidTransfers?: Array<{
    transferId: string;
    status: string;
    ledgerEntryCount: string;
    debitCount: string;
    creditCount: string;
    invalidAmountCount: string;
    invalidAccountCount: string;
  }>;
}

interface InvalidTransferRow {
  transfer_id: string;
  status: string;
  ledger_entry_count: string;
  debit_count: string;
  credit_count: string;
  invalid_amount_count: string;
  invalid_account_count: string;
}

export async function verifyI5NoPartialTransfers(
  accountIds?: string[],
): Promise<I5Result> {
  try {
    const result = await verifierPool.query<InvalidTransferRow>(
      `
      SELECT
        t.id::text AS transfer_id,
        t.status,
        COUNT(le.id)::text AS ledger_entry_count,

        COUNT(le.id) FILTER (
          WHERE le.entry_type = 'DEBIT'
        )::text AS debit_count,

        COUNT(le.id) FILTER (
          WHERE le.entry_type = 'CREDIT'
        )::text AS credit_count,

        COUNT(le.id) FILTER (
          WHERE le.id IS NOT NULL
            AND le.amount_paise <> t.amount_paise
        )::text AS invalid_amount_count,

        COUNT(le.id) FILTER (
          WHERE
            (le.entry_type = 'DEBIT'
              AND le.account_id <> t.from_account_id)
            OR
            (le.entry_type = 'CREDIT'
              AND le.account_id <> t.to_account_id)
        )::text AS invalid_account_count

      FROM transfers t

      LEFT JOIN ledger_entries le
        ON le.transfer_id = t.id

      WHERE
        $1::uuid[] IS NULL
        OR t.from_account_id = ANY($1::uuid[])
        OR t.to_account_id = ANY($1::uuid[])

      GROUP BY
        t.id,
        t.status,
        t.amount_paise,
        t.from_account_id,
        t.to_account_id

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
        OR
        (
          t.status IN ('PENDING', 'FAILED')
          AND COUNT(le.id) <> 0
        )

      ORDER BY t.id;
      `,
      [accountIds ?? null],
    );

    if (result.rows.length > 0) {
      return {
        invariant: "I5",
        name: "No partial transfers",
        status: "FAIL",
        message:
          "One or more transfers have missing, extra, or inconsistent ledger entries.",
        invalidTransferCount: String(result.rows.length),
        invalidTransfers: result.rows.map((row) => ({
          transferId: row.transfer_id,
          status: row.status,
          ledgerEntryCount: row.ledger_entry_count,
          debitCount: row.debit_count,
          creditCount: row.credit_count,
          invalidAmountCount: row.invalid_amount_count,
          invalidAccountCount: row.invalid_account_count,
        })),
      };
    }

    return {
      invariant: "I5",
      name: "No partial transfers",
      status: "PASS",
      message:
        "Every transfer has ledger entries consistent with its status, amount, and accounts.",
      invalidTransferCount: "0",
      invalidTransfers: [],
    };
  } catch (error) {
    return {
      invariant: "I5",
      name: "No partial transfers",
      status: "NOT VERIFIED",
      message:
        error instanceof Error
          ? `Could not execute verification: ${error.message}`
          : "Could not execute verification due to an unknown error.",
    };
  }
}