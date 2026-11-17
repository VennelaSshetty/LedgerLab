import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

import {
  POSTGRES_BIGINT_MAX,
  paiseBalanceArb,
  positiveAmountPaiseArb,
} from "../helpers/transfer-arbitraries";

import { propertyTestParameters } from "../helpers/property-test-config";

import { applyTransferModel } from "../helpers/transfer-reference-model";

describe("Pure transfer properties", () => {
  it("conserves total money after every successful transfer", () => {
    fc.assert(
      fc.property(
        paiseBalanceArb,
        paiseBalanceArb,
        positiveAmountPaiseArb,
        (senderBalance, receiverBalance, amount) => {
          fc.pre(senderBalance >= amount);
          fc.pre(receiverBalance <= POSTGRES_BIGINT_MAX - amount);

          const result = applyTransferModel(
            senderBalance,
            receiverBalance,
            amount,
          );

          expect(result.success).toBe(true);

          if (!result.success) return;

          expect(
            result.senderBalance + result.receiverBalance,
          ).toBe(senderBalance + receiverBalance);
        },
      ),
      propertyTestParameters,
    );
  });

  it("updates sender and receiver balances correctly", () => {
    fc.assert(
      fc.property(
        paiseBalanceArb,
        paiseBalanceArb,
        positiveAmountPaiseArb,
        (senderBalance, receiverBalance, amount) => {
          fc.pre(senderBalance >= amount);
          fc.pre(receiverBalance <= POSTGRES_BIGINT_MAX - amount);

          const result = applyTransferModel(
            senderBalance,
            receiverBalance,
            amount,
          );

          expect(result.success).toBe(true);

          if (!result.success) return;

          expect(result.senderBalance).toBe(senderBalance - amount);
          expect(result.receiverBalance).toBe(receiverBalance + amount);
        },
      ),
      propertyTestParameters,
    );
  });

  it("rejects insufficient funds without changing either balance", () => {
    fc.assert(
      fc.property(
        paiseBalanceArb,
        paiseBalanceArb,
        positiveAmountPaiseArb,
        (senderBalance, receiverBalance, amount) => {
          fc.pre(senderBalance < amount);

          const result = applyTransferModel(
            senderBalance,
            receiverBalance,
            amount,
          );

          expect(result.success).toBe(false);

          if (result.success) return;

          expect(result.reason).toBe("INSUFFICIENT_FUNDS");
          expect(result.senderBalance).toBe(senderBalance);
          expect(result.receiverBalance).toBe(receiverBalance);
        },
      ),
      propertyTestParameters,
    );
  });

  it("allows transferring the sender's exact available balance", () => {
    fc.assert(
      fc.property(
        positiveAmountPaiseArb,
        (senderBalance) => {
          const result = applyTransferModel(
            senderBalance,
            0n,
            senderBalance,
          );

          expect(result.success).toBe(true);

          if (!result.success) return;

          expect(result.senderBalance).toBe(0n);
          expect(result.receiverBalance).toBe(senderBalance);
        },
      ),
      propertyTestParameters,
    );
  });

  it("rejects a transfer one paise above the sender's balance", () => {
    fc.assert(
      fc.property(
        paiseBalanceArb,
        (senderBalance) => {
          fc.pre(senderBalance < POSTGRES_BIGINT_MAX);

          const result = applyTransferModel(
            senderBalance,
            0n,
            senderBalance + 1n,
          );

          expect(result.success).toBe(false);

          if (result.success) return;

          expect(result.reason).toBe("INSUFFICIENT_FUNDS");
          expect(result.senderBalance).toBe(senderBalance);
          expect(result.receiverBalance).toBe(0n);
        },
      ),
      propertyTestParameters,
    );
  });

  it("rejects zero and negative transfer amounts", () => {
    fc.assert(
      fc.property(
        paiseBalanceArb,
        paiseBalanceArb,
        fc.constantFrom(0n, -1n),
        (senderBalance, receiverBalance, amount) => {
          const result = applyTransferModel(
            senderBalance,
            receiverBalance,
            amount,
          );

          expect(result.success).toBe(false);

          if (result.success) return;

          expect(result.reason).toBe("INVALID_AMOUNT");
          expect(result.senderBalance).toBe(senderBalance);
          expect(result.receiverBalance).toBe(receiverBalance);
        },
      ),
      propertyTestParameters,
    );
  });

  it("rejects receiver balance overflow beyond PostgreSQL BIGINT", () => {
    fc.assert(
      fc.property(
        positiveAmountPaiseArb,
        (amount) => {
          const receiverBalance = POSTGRES_BIGINT_MAX - amount + 1n;

          const result = applyTransferModel(
            amount,
            receiverBalance,
            amount,
          );

          expect(result.success).toBe(false);

          if (result.success) return;

          expect(result.reason).toBe("BALANCE_OVERFLOW");
          expect(result.senderBalance).toBe(amount);
          expect(result.receiverBalance).toBe(receiverBalance);
        },
      ),
      propertyTestParameters,
    );
  });
});