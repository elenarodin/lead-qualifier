// Manual test harness for Stop Point #2.
// Usage:
//   echo "profile text..." | npm run qualify
//   npm run qualify -- path/to/profile.txt
//   npm run qualify -- --example
//
// Requires ANTHROPIC_API_KEY in env (loaded from .env via dotenv/config).
import "dotenv/config";
import { readFileSync } from "node:fs";
import { qualifyLead, TooShortError } from "../src/core/qualify.js";

const EXAMPLE = `Jane Doe
CTO at ZenPayer Health
Philadelphia, PA · 500+ connections

About
Building prior authorization automation for regional payers. Previously platform lead at Optum, where I owned the claims AI infrastructure. Currently scaling our PA decisioning engine — interested in how we balance precision vs. throughput on denial-edge cases. Recent CMS-0057 prep has been on my mind.

Experience
CTO · ZenPayer Health · Full-time
Jan 2024 - Present · 180 employees
Health Tech

Platform Lead · Optum
2019 - 2023
`;

async function readInput(): Promise<string> {
  const args = process.argv.slice(2);
  if (args.includes("--example")) return EXAMPLE;
  if (args[0] && !args[0].startsWith("-")) {
    return readFileSync(args[0], "utf8");
  }
  // Read from stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const profileText = await readInput();
  if (!profileText.trim()) {
    console.error(
      "No input. Pipe text via stdin, pass a file path, or use --example.",
    );
    process.exit(2);
  }

  const started = Date.now();
  try {
    const { profile, result } = await qualifyLead(profileText);
    const ms = Date.now() - started;
    console.log("=== EXTRACTED PROFILE ===");
    console.log(JSON.stringify(profile, null, 2));
    console.log("\n=== QUALIFICATION RESULT ===");
    console.log(JSON.stringify(result, null, 2));
    console.log(`\n(took ${ms}ms)`);
  } catch (err) {
    if (err instanceof TooShortError) {
      console.error("Profile text too short (< 50 chars).");
      process.exit(3);
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
