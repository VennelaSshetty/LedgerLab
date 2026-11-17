import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { propertyTestParameters } from "../helpers/property-test-config";

import {
  POSTGRES_BIGINT_MAX,
  paiseBalanceArb,
  positiveAmountPaiseArb,
  accountPairArb,
  idempotencyKeyArb,
  accountStatusArb,
  frozenAccountArb,
  validTransferArb,
  invalidTransferArb,
} from "../helpers/transfer-arbitraries";

describe("transfer arbitraries", () => {
  it("generates non-negative PostgreSQL BIGINT balances", () => {
    fc.assert(
      fc.property(paiseBalanceArb, (balance) => {
        return balance >= 0n && balance <= POSTGRES_BIGINT_MAX;
      }),
      propertyTestParameters,
    );
  });

  it("generates positive PostgreSQL BIGINT transfer amounts", () => {
    fc.assert(
      fc.property(positiveAmountPaiseArb, (amount) => {
        return amount > 0n && amount <= POSTGRES_BIGINT_MAX;
      }),
      propertyTestParameters,
    );
  });

  it("generates distinct UUID account pairs", () => {
    fc.assert(
      fc.property(accountPairArb, ({ fromAccountId, toAccountId }) => {
        return (
          fromAccountId !== toAccountId &&
          /^[0-9a-f-]{36}$/i.test(fromAccountId) &&
          /^[0-9a-f-]{36}$/i.test(toAccountId)
        );
      }),
      propertyTestParameters,
    );
  });

  it("generates non-empty idempotency keys within 255 characters", () => {
    fc.assert(
      fc.property(idempotencyKeyArb, (key) => {
        return key.trim().length > 0 && key.length <= 255;
      }),
      propertyTestParameters,
    );
  });

  it("generates only supported account statuses", () => {
    fc.assert(
      fc.property(accountStatusArb, (status) => {
        return status === "ACTIVE" || status === "FROZEN";
      }),
      propertyTestParameters,
    );
  });

  it("generates frozen accounts with non-negative balances", () => {
    fc.assert(
      fc.property(frozenAccountArb, (account) => {
        return (
          account.status === "FROZEN" &&
          account.balancePaise >= 0n &&
          account.balancePaise <= POSTGRES_BIGINT_MAX
        );
      }),
      propertyTestParameters,
    );
  });

  it("generates valid transfer inputs", () => {
    fc.assert(
      fc.property(validTransferArb, (input) => {
        return (
          input.fromAccountId !== input.toAccountId &&
          /^[0-9a-f-]{36}$/i.test(input.fromAccountId) &&
          /^[0-9a-f-]{36}$/i.test(input.toAccountId) &&
          BigInt(input.amountPaise) > 0n &&
          input.idempotencyKey.trim().length > 0 &&
          input.idempotencyKey.length <= 255
        );
      }),
      propertyTestParameters,
    );
  });

  it("generates invalid transfer inputs matching their declared reason", () => {
    fc.assert(
      fc.property(invalidTransferArb, ({ reason, input }) => {
        switch (reason) {
          case "SAME_ACCOUNT":
            return input.fromAccountId === input.toAccountId;

          case "MALFORMED_ACCOUNT_ID":
            return !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              input.fromAccountId,
            );

          case "ZERO_AMOUNT":
            return input.amountPaise === "0";

          case "NEGATIVE_AMOUNT":
            return input.amountPaise === "-1";

          case "EMPTY_IDEMPOTENCY_KEY":
            return input.idempotencyKey.trim().length === 0;
        }
      }),
      propertyTestParameters,
    );
  });
});