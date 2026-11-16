import { adminPool } from "./admin-pool";

export async function deleteLedgerEntriesForTests(
  accountIds: string[],
): Promise<void> {
  const client = await adminPool.connect();

  try {
    await client.query("BEGIN");

    // Temporarily disable user-defined ledger protection triggers.
    // This is restricted to test cleanup, not application code.
    await client.query(
      "ALTER TABLE public.ledger_entries DISABLE TRIGGER USER",
    );

    await client.query(
      `DELETE FROM public.ledger_entries
       WHERE account_id = ANY($1::uuid[])`,
      [accountIds],
    );

    // Restore the protections before committing.
    await client.query(
      "ALTER TABLE public.ledger_entries ENABLE TRIGGER USER",
    );

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}