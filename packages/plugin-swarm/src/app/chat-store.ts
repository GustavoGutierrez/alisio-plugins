import { join } from "node:path";
import { atomicWrite, Mutex, readText } from "../storage.js";

export const MAX_CHAT_HISTORY = 100;
const MAX_CHAT_TEXT = 8000;

export interface ChatMessage {
  from: "operator" | "lieutenant";
  text: string;
  at: string;
}

const isMessage = (value: unknown): value is ChatMessage => {
  const record = value as Record<string, unknown> | null;
  return (
    Boolean(record) &&
    typeof record === "object" &&
    (record?.from === "operator" || record?.from === "lieutenant") &&
    typeof record.text === "string" &&
    typeof record.at === "string" &&
    !Number.isNaN(Date.parse(record.at))
  );
};

/**
 * The persisted Lieutenant conversation of one project: a bounded, schema-versioned file under
 * `.alisio/swarm/chat.json`. History is a convenience, so a corrupt file reads as empty.
 */
export class ChatStore {
  private readonly file: string;
  private readonly lock = new Mutex();

  constructor(projectDir: string) {
    this.file = join(projectDir, ".alisio", "swarm", "chat.json");
  }

  async read(): Promise<ChatMessage[]> {
    const raw = await readText(this.file);
    if (raw === undefined) return [];
    try {
      const parsed = JSON.parse(raw) as { schemaVersion?: unknown; messages?: unknown };
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.messages)) return [];
      return parsed.messages.filter(isMessage).map((entry) => ({ ...entry }));
    } catch {
      return [];
    }
  }

  append(...messages: ChatMessage[]): Promise<void> {
    return this.lock.run(async () => {
      const next = [
        ...(await this.read()),
        ...messages.map((entry) => ({ ...entry, text: entry.text.slice(0, MAX_CHAT_TEXT) })),
      ].slice(-MAX_CHAT_HISTORY);
      await atomicWrite(this.file, `${JSON.stringify({ schemaVersion: 1, messages: next })}\n`);
    });
  }
}
