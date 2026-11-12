import dotenv from "dotenv";
import path from "node:path";

// Load backend environment variables before reading them.
dotenv.config({
  path: path.resolve(__dirname, "../../.env"),
});

const naiveModeEnabled =
  process.env.NAIVE_MODE_ENABLED ?? "false";

const nodeEnv = process.env.NODE_ENV ?? "development";

if (naiveModeEnabled !== "true" && naiveModeEnabled !== "false") {
  throw new Error(
    "NAIVE_MODE_ENABLED must be either 'true' or 'false'"
  );
}

if (
  naiveModeEnabled === "true" &&
  nodeEnv !== "development" &&
  nodeEnv !== "test"
) {
  throw new Error(
    "Naive Mode can only be enabled in development or test environments"
  );
}

export const isNaiveModeEnabled = naiveModeEnabled === "true";