
import { writeFile } from "node:fs/promises";
import type { GeneratedWorkload } from "./types";

/**
 * Converts a generated workload into readable JSON.
 *
 * The output preserves the original configuration and every transfer,
 * including expected validity and invalid reasons.
 */
export function serializeWorkload(workload: GeneratedWorkload): string {
  return JSON.stringify(workload, null, 2) + "\n";
}

/**
 * Exports a generated workload to a JSON file.
 *
 * The caller decides where the file should be saved.
 */
export async function exportWorkload(
  workload: GeneratedWorkload,
  outputPath: string,
): Promise<void> {
  const json = serializeWorkload(workload);

  await writeFile(outputPath, json, "utf8");
}
