import "dotenv/config";

export interface AppConfig {
  telegramBotToken: string;
  anthropicApiKey: string;
  accessCode: string;
  dbPath: string;
  logLevel: "debug" | "info" | "warn" | "error";
}

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function parseLogLevel(v: string | undefined): AppConfig["logLevel"] {
  switch ((v ?? "info").toLowerCase()) {
    case "debug":
    case "info":
    case "warn":
    case "error":
      return v as AppConfig["logLevel"];
    default:
      return "info";
  }
}

export function loadConfig(): AppConfig {
  return {
    telegramBotToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    anthropicApiKey: requireEnv("ANTHROPIC_API_KEY"),
    accessCode: requireEnv("ACCESS_CODE"),
    dbPath: process.env.DB_PATH || "./data/qualifier.db",
    logLevel: parseLogLevel(process.env.LOG_LEVEL),
  };
}
