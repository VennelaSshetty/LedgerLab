
export type InvalidReason =
  | "SAME_ACCOUNT"
  | "MALFORMED_ACCOUNT_ID"
  | "NONEXISTENT_ACCOUNT"
  | "ZERO_AMOUNT"
  | "NEGATIVE_AMOUNT";

export type WorkloadConfig = {
  seed: number;
  accountCount: number;
  transferCount: number;

  minAmountPaise: string;
  maxAmountPaise: string;

  invalidRequestPercentage: number;

  concurrency: number;
};

export type WorkloadTransfer = {
  requestId: string;
  correlationId: string;
  fromAccountId: string;
  toAccountId: string;
  amountPaise: string;
  idempotencyKey: string;
  expectedValidity: "VALID" | "INVALID";
  invalidReason?: InvalidReason;
};

export type GeneratedWorkload = {
  config: WorkloadConfig;
  transfers: WorkloadTransfer[];
};
