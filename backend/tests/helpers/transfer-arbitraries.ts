import * as fc from "fast-check";
import type { CreateTransferInput } from "../../src/services/transfers.service";

export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

// Money generators: always bigint, never JavaScript Number.
export const paiseBalanceArb = fc.bigInt({
  min: 0n,
  max: POSTGRES_BIGINT_MAX,
});

export const positiveAmountPaiseArb = fc.bigInt({
  min: 1n,
  max: POSTGRES_BIGINT_MAX,
});

// Two distinct UUID account IDs.
export const accountPairArb = fc
  .tuple(fc.uuid(), fc.uuid())
  .filter(([from, to]) => from !== to)
  .map(([fromAccountId, toAccountId]) => ({
    fromAccountId,
    toAccountId,
  }));

// PostgreSQL VARCHAR(255), non-empty, non-whitespace keys.
const idempotencyCharacters =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-".split("");

export const idempotencyKeyArb = fc
  .array(fc.constantFrom(...idempotencyCharacters), {
    minLength: 1,
    maxLength: 255,
  })
  .map((characters) => characters.join(""));

export type AccountStatus = "ACTIVE" | "FROZEN";

export const accountStatusArb: fc.Arbitrary<AccountStatus> =
  fc.constantFrom("ACTIVE", "FROZEN");

export const frozenAccountArb = fc.record({
  id: fc.uuid(),
  balancePaise: paiseBalanceArb,
  status: fc.constant("FROZEN" as const),
});

// Valid service-level transfer inputs.
export const validTransferArb: fc.Arbitrary<CreateTransferInput> =
  fc.record({
    accounts: accountPairArb,
    amountPaise: positiveAmountPaiseArb,
    idempotencyKey: idempotencyKeyArb,
    correlationId: fc.uuid(),
  }).map(({ accounts, amountPaise, idempotencyKey, correlationId }) => ({
    ...accounts,
    amountPaise: amountPaise.toString(),
    idempotencyKey,
    correlationId,
  }));

export type InvalidTransferReason =
  | "SAME_ACCOUNT"
  | "MALFORMED_ACCOUNT_ID"
  | "ZERO_AMOUNT"
  | "NEGATIVE_AMOUNT"
  | "EMPTY_IDEMPOTENCY_KEY";

export type InvalidTransferCase = {
  reason: InvalidTransferReason;
  input: CreateTransferInput;
};

// Each invalid case starts from an otherwise valid transfer.
export const invalidTransferArb: fc.Arbitrary<InvalidTransferCase> =
  fc.oneof(
    validTransferArb.map((input) => ({
      reason: "SAME_ACCOUNT" as const,
      input: {
        ...input,
        toAccountId: input.fromAccountId,
      },
    })),

    validTransferArb.map((input) => ({
      reason: "MALFORMED_ACCOUNT_ID" as const,
      input: {
        ...input,
        fromAccountId: "not-a-uuid",
      },
    })),

    validTransferArb.map((input) => ({
      reason: "ZERO_AMOUNT" as const,
      input: {
        ...input,
        amountPaise: "0",
      },
    })),

    validTransferArb.map((input) => ({
      reason: "NEGATIVE_AMOUNT" as const,
      input: {
        ...input,
        amountPaise: "-1",
      },
    })),

    validTransferArb.map((input) => ({
      reason: "EMPTY_IDEMPOTENCY_KEY" as const,
      input: {
        ...input,
        idempotencyKey: "   ",
      },
    })),
  );