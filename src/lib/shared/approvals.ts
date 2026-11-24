// Types for Module G: approvals, audit log and the simulated outbox. Plain JSON.

export type AuditEvent =
  | "requested" // an agent asked to run a sensitive action
  | "approved" // a person approved it
  | "rejected" // a person rejected it
  | "auto-approved" // Controlled Access: it matched a pre-approved rule inside its limit
  | "limit-reached" // Controlled Access: the automatic limit was used up, so it asks a person
  | "executed" // the action actually ran
  | "not-executed"; // the action did NOT run (rejected, stopped or cancelled)

export interface AuditEntry {
  id: string;
  at: string;
  conversationId: string;
  botId: string;
  botName: string;
  toolCallId: string;
  tool: string;
  label: string;
  detail?: string;
  /** The action's arguments, truncated, with anything that looks like a secret removed. */
  argsPreview?: string;
  event: AuditEvent;
  by: "person" | "policy" | "system";
  note?: string;
}

export interface PendingApproval {
  conversationId: string;
  botId: string;
  botName: string;
  toolCallId: string;
  label: string;
  detail?: string;
  argsPreview?: string;
  createdAt: string;
}

/** A message an agent "sent". SIMULATED: it is stored here and goes nowhere. */
export interface OutboxItem {
  id: string;
  at: string;
  botId: string;
  botName: string;
  channel: "email" | "slack";
  to: string;
  subject?: string;
  body: string;
  simulated: true;
}
