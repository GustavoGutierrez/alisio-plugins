// Structural contract for the in-development Alisio plugin apps API (`api.apps`). It is not in the
// published @alisio/sdk yet; remove these local types once an SDK release ships them.
import type { JsonSchema, PluginAPI } from "@alisio/sdk";

export interface AppContext {
  sessionId: string;
  workspace: string;
  signal: AbortSignal;
  idempotencyKey?: string;
}
export interface AppAction {
  effect: "read" | "write" | "process";
  inputSchema: JsonSchema;
  handler(input: Record<string, unknown>, context: AppContext): unknown | Promise<unknown>;
}
export interface AppRegistration {
  id: string;
  label: { en: string; es: string };
  html(): string | Promise<string>;
  actions: Record<string, AppAction>;
  dispose?(): void;
  busy?(): boolean;
}
export type EmbeddedPluginAPI = PluginAPI & {
  apps?: { register(app: AppRegistration): () => void };
};
