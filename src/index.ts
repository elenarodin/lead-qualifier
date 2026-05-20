import { startBot } from "./adapters/telegram.js";
import { loadConfig } from "./config.js";
import { openDatabase } from "./db/schema.js";
import { VERSION } from "./version.js";

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`[info] Kombocode Qualifier v${VERSION} starting…`);
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const bot = startBot(config, db);

  // eslint-disable-next-line no-console
  console.log(
    `[info] bot live (polling) — db at ${config.dbPath}`,
  );

  const shutdown = (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`\n[info] ${signal} — shutting down`);
    bot.stop(signal);
    db.close();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
