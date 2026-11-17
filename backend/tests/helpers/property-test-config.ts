
const DEFAULT_SEED = 20261118;
const DEFAULT_NUM_RUNS = 100;

function readInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined) return fallback;

  if (!/^-?\d+$/.test(value)) {
    throw new Error(`${name} must be an integer`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a safe integer`);
  }

  return parsed;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = readInteger(value, fallback, name);

  if (parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export const propertyTestParameters = {
  seed: readInteger(
    process.env.FC_SEED,
    DEFAULT_SEED,
    "FC_SEED",
  ),
  numRuns: readPositiveInteger(
    process.env.FC_NUM_RUNS,
    DEFAULT_NUM_RUNS,
    "FC_NUM_RUNS",
  ),
  path: process.env.FC_PATH || undefined,
};
