
import { beforeEach, describe, expect, it, vi } from "vitest";

const { queryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
}));

vi.mock("../../src/db/verifier-pool", () => ({
  verifierPool: {
    query: queryMock,
  },
}));

import { verifyI1TotalMoney } from "../../src/verifier/checks/i1-total-money";
import { verifyI2DebitCredit } from "../../src/verifier/checks/i2-debit-credit";
import { verifyI3NoNegativeBalances } from "../../src/verifier/checks/i3-no-negative-balances";
import { verifyI5NoPartialTransfers } from "../../src/verifier/checks/i5-no-partial-transfers";
import { verifyI6ProjectionConsistency } from "../../src/verifier/checks/i6-projection-consistency";

function mockRows(rows: unknown[]) {
  queryMock.mockResolvedValue({ rows });
}

describe("Independent ledger verifier checks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("I1 - Total money conservation", () => {
    it("passes when opening and current totals match", async () => {
      mockRows([
        {
          opening_total_paise: "100000",
          current_total_paise: "100000",
          missing_opening_balance_accounts: "0",
        },
      ]);

      const result = await verifyI1TotalMoney();

      expect(result.status).toBe("PASS");
      expect(result.expectedTotalPaise).toBe("100000");
      expect(result.actualTotalPaise).toBe("100000");
    });

    it("fails when current total differs from opening total", async () => {
      mockRows([
        {
          opening_total_paise: "100000",
          current_total_paise: "99000",
          missing_opening_balance_accounts: "0",
        },
      ]);

      const result = await verifyI1TotalMoney();

      expect(result.status).toBe("FAIL");
    });

    it("returns NOT VERIFIED when an opening balance is missing", async () => {
      mockRows([
        {
          opening_total_paise: "100000",
          current_total_paise: "100000",
          missing_opening_balance_accounts: "1",
        },
      ]);

      const result = await verifyI1TotalMoney();

      expect(result.status).toBe("NOT VERIFIED");
    });
  });

  describe("I2 - Debit-credit equality", () => {
    it("passes when all transfers are balanced", async () => {
      mockRows([
        {
          total_debits_paise: "50000",
          total_credits_paise: "50000",
          imbalanced_transfers: "0",
        },
      ]);

      const result = await verifyI2DebitCredit();

      expect(result.status).toBe("PASS");
    });

    it("fails when total debits and credits differ", async () => {
      mockRows([
        {
          total_debits_paise: "50000",
          total_credits_paise: "49000",
          imbalanced_transfers: "1",
        },
      ]);

      const result = await verifyI2DebitCredit();

      expect(result.status).toBe("FAIL");
    });

    it("fails when individual transfers are imbalanced", async () => {
      mockRows([
        {
          total_debits_paise: "50000",
          total_credits_paise: "50000",
          imbalanced_transfers: "1",
        },
      ]);

      const result = await verifyI2DebitCredit();

      expect(result.status).toBe("FAIL");
    });
  });

  describe("I3 - No negative balances", () => {
    it("passes when no negative accounts are found", async () => {
      mockRows([]);

      const result = await verifyI3NoNegativeBalances();

      expect(result.status).toBe("PASS");
    });

    it("fails when a negative account is found", async () => {
      mockRows([
        {
          account_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          balance_paise: "-100",
        },
      ]);

      const result = await verifyI3NoNegativeBalances();

      expect(result.status).toBe("FAIL");
    });
  });

  describe("I5 - No partial transfers", () => {
    it("passes when no invalid transfers are found", async () => {
      mockRows([]);

      const result = await verifyI5NoPartialTransfers();

      expect(result.status).toBe("PASS");
    });

    it("fails when an invalid transfer is found", async () => {
      mockRows([
        {
          transfer_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        },
      ]);

      const result = await verifyI5NoPartialTransfers();

      expect(result.status).toBe("FAIL");
    });
  });

  describe("I6 - Projection-versus-ledger consistency", () => {
    it("passes when no inconsistent accounts are found", async () => {
      mockRows([]);

      const result = await verifyI6ProjectionConsistency();

      expect(result.status).toBe("PASS");
    });

    it("fails when an inconsistent account is found", async () => {
      mockRows([
        {
          account_id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          opening_balance_paise: "1000",
          total_credits_paise: "500",
          total_debits_paise: "600",
          expected_balance_paise: "900",
          actual_balance_paise: "1000",
        },
      ]);

      const result = await verifyI6ProjectionConsistency();

      expect(result.status).toBe("FAIL");
    });
  });

  describe("Database error handling", () => {
    it("returns NOT VERIFIED when database queries fail", async () => {
      queryMock.mockRejectedValue(
        new Error("Database unavailable"),
      );

      const results = await Promise.all([
        verifyI1TotalMoney(),
        verifyI2DebitCredit(),
        verifyI3NoNegativeBalances(),
        verifyI5NoPartialTransfers(),
        verifyI6ProjectionConsistency(),
      ]);

      expect(
        results.every((result) => result.status === "NOT VERIFIED"),
      ).toBe(true);
    });
  });
});
