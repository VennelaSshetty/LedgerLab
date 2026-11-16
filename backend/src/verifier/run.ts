
import { verifierPool } from "../db/verifier-pool";

import { verifyI1TotalMoney } from "./checks/i1-total-money";
import { verifyI2DebitCredit } from "./checks/i2-debit-credit";
import { verifyI3NoNegativeBalances } from "./checks/i3-no-negative-balances";
import { verifyI5NoPartialTransfers } from "./checks/i5-no-partial-transfers";
import { verifyI6ProjectionConsistency } from "./checks/i6-projection-consistency";

type CheckStatus = "PASS" | "FAIL" | "NOT VERIFIED";

interface VerificationResult {
  invariant: string;
  name: string;
  status: CheckStatus;
  message: string;
}

async function runVerification(): Promise<void> {
  console.log("\n========================================");
  console.log("       LEDGERLAB INDEPENDENT VERIFIER");
  console.log("========================================\n");

  try {
    const results: VerificationResult[] = await Promise.all([
      verifyI1TotalMoney(),
      verifyI2DebitCredit(),
      verifyI3NoNegativeBalances(),

      // I4 requires acknowledgement-history recording.
      // It remains unverified until that implementation exists.
      Promise.resolve({
        invariant: "I4",
        name: "Acknowledged transfer exactly once",
        status: "NOT VERIFIED" as const,
        message:
          "Acknowledgement history recording has not been implemented.",
      }),

      verifyI5NoPartialTransfers(),
      verifyI6ProjectionConsistency(),
    ]);

    for (const result of results) {
      console.log(
        `[${result.status.padEnd(12)}] ${result.invariant} - ${result.name}`,
      );
      console.log(`               ${result.message}\n`);
    }

    const hasFailure = results.some(
      (result) => result.status === "FAIL",
    );

    const hasUnverified = results.some(
      (result) => result.status === "NOT VERIFIED",
    );

    const overallStatus: CheckStatus = hasFailure
      ? "FAIL"
      : hasUnverified
        ? "NOT VERIFIED"
        : "PASS";

    console.log("========================================");
    console.log(`OVERALL RESULT: ${overallStatus}`);
    console.log("========================================\n");

    if (overallStatus === "FAIL") {
      process.exitCode = 1;
    } else if (overallStatus === "NOT VERIFIED") {
      process.exitCode = 2;
    }
  } finally {
    await verifierPool.end();
  }
}

runVerification().catch((error: unknown) => {
  console.error("\nVerifier execution failed:", error);
  process.exitCode = 1;
});
