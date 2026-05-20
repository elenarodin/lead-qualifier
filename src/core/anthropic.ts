import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

let client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY is not set");
  }
  client = new Anthropic({ apiKey });
  return client;
}

// Strips ```json fences if the model wraps its output despite instructions.
function stripFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1].trim() : trimmed;
}

interface JsonCallOptions {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

// One call to Claude that must return JSON. Retries once on parse failure with a
// stricter "respond with raw JSON only" reminder before throwing.
export async function callClaudeJson<T>(opts: JsonCallOptions): Promise<T> {
  const { system, user } = opts;
  const maxTokens = opts.maxTokens ?? 1024;
  const temperature = opts.temperature ?? 0;

  const tryCall = async (extraSystem: string): Promise<T> => {
    const anthropic = getAnthropicClient();
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: maxTokens,
      temperature,
      system: extraSystem ? `${system}\n\n${extraSystem}` : system,
      messages: [{ role: "user", content: user }],
    });

    const block = resp.content.find((c) => c.type === "text");
    if (!block || block.type !== "text") {
      throw new Error("Claude returned no text block");
    }
    const raw = stripFences(block.text);
    return JSON.parse(raw) as T;
  };

  try {
    return await tryCall("");
  } catch (err) {
    if (err instanceof SyntaxError) {
      return await tryCall(
        "Your previous response was not valid JSON. Respond with raw JSON only — no prose, no markdown fences, no commentary.",
      );
    }
    throw err;
  }
}
