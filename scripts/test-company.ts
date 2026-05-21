// Manual test harness for /company mode (Phase 1.7 + 1.8).
// Usage:
//   npx tsx scripts/test-company.ts "Quadax, quadax.com" "Cohere Health"
//   printf "Quadax, quadax.com\nlinkedin.com/company/datavant\n" | npx tsx scripts/test-company.ts

import "dotenv/config";
import { parseCompanyLine, screenCompanies } from "../src/core/company.js";

async function readLines(): Promise<string[]> {
  const args = process.argv.slice(2);
  if (args.length > 0) return args;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main(): Promise<void> {
  const lines = await readLines();
  if (lines.length === 0) {
    console.error("No company lines. Pass as args or pipe via stdin.");
    process.exit(2);
  }

  const identifiers = lines.map((l) => parseCompanyLine(l));

  // Show what we parsed so the user can see the resolution path each line takes.
  console.log("=== PARSED IDENTIFIERS ===");
  for (let i = 0; i < lines.length; i++) {
    console.log(`${i + 1}. "${lines[i]}" → ${JSON.stringify(identifiers[i])}`);
  }
  console.log("");

  const started = Date.now();
  const { results, skipped } = await screenCompanies(identifiers, lines);
  const ms = Date.now() - started;

  for (const r of results) {
    console.log(JSON.stringify(r, null, 2));
    console.log("---");
  }
  if (skipped.length > 0) {
    console.log(`SKIPPED (over the 10-cap): ${JSON.stringify(skipped)}`);
  }
  console.log(`(${results.length} companies in ${ms}ms)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
