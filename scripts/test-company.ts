// Manual test harness for Stop Point #2 (Phase 1.7).
// Usage:
//   npx tsx scripts/test-company.ts "Cohere Health"
//   npx tsx scripts/test-company.ts "Cohere Health" "Medidata" "Acme Retail"
//   printf "Cohere\nMedidata\n" | npx tsx scripts/test-company.ts

import "dotenv/config";
import { screenCompanies } from "../src/core/company.js";

async function readNames(): Promise<string[]> {
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
  const names = await readNames();
  if (names.length === 0) {
    console.error("No company names. Pass as args or pipe via stdin.");
    process.exit(2);
  }

  const started = Date.now();
  const { results, skipped } = await screenCompanies(names);
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
