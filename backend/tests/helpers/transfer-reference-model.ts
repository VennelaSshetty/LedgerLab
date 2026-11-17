import { POSTGRES_BIGINT_MAX } from "./transfer-arbitraries";

export type TransferModelResult =
  | {
      success: true;
      senderBalance: bigint;
      receiverBalance: bigint;
    }
  | {
      success: false;
      reason:
        | "INVALID_AMOUNT"
        | "INSUFFICIENT_FUNDS"
        | "BALANCE_OVERFLOW";
      senderBalance: bigint;
      receiverBalance: bigint;
    };

export function applyTransferModel(
  senderBalance: bigint,
  receiverBalance: bigint,
  amountPaise: bigint,
): TransferModelResult {
  if (amountPaise <= 0n) {
    return {
      success: false,
      reason: "INVALID_AMOUNT",
      senderBalance,
      receiverBalance,
    };
  }

  if (senderBalance < amountPaise) {
    return {
      success: false,
      reason: "INSUFFICIENT_FUNDS",
      senderBalance,
      receiverBalance,
    };
  }

  if (receiverBalance > POSTGRES_BIGINT_MAX - amountPaise) {
    return {
      success: false,
      reason: "BALANCE_OVERFLOW",
      senderBalance,
      receiverBalance,
    };
  }

  return {
    success: true,
    senderBalance: senderBalance - amountPaise,
    receiverBalance: receiverBalance + amountPaise,
  };
}