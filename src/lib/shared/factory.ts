// Types for the agent factory (Module B). Plain JSON, shared by server and browser.
import type { BotInput } from "./types";

export interface AgentDraft {
  /** Everything needed to create the agent. The person can edit it before creating. */
  input: BotInput;
  /** Who designed it: a real model, or the labelled mock-mode keyword heuristic. */
  source: "llm" | "mock-heuristic";
  /** The plain-language request it came from. */
  createdFrom: string;
}
