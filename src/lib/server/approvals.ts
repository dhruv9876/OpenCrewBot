// Module G: human approval and autonomy.
//
// Three permission levels per agent (Bot.approval):
//   ask         Ask First: every external or sensitive action waits for a person.
//   controlled  Controlled Access: actions matching Bot.autoApprove.tools run by themselves, up to
//               maxPerConversation per chat. Anything else, or anything past the limit, asks a person.
//   full        Full Access: permitted actions run without asking (and are still audit-logged).
//
// Enforcement of "rejected means never executed" is done by the agent harness (a declined tool call
// is never run). This file adds what the harness lacks: an append-only audit log that records the
// request, the decision, who made it, and whether the action really ran, plus the per-tool policy
// for Controlled Access and a simulated outbox that gives agents a safe external action to try.
import { randomUUID } from "node:crypto";
import type { Client } from "@libsql/client";
import type { Bot, ChatMessage } from "@/lib/shared/types";
import type { AuditEntry, AuditEvent, OutboxItem, PendingApproval } from "@/lib/shared/approvals";
import * as store from "./db";
import { publish } from "./bus";

// ── tables (created on first use, so no migration is needed) ─────────────

let ready: Promise<void> | undefined;

async function client(): Promise<Client> {
  const c = await store.db();
  ready ??= c
    .batch(
      [
        `CREATE TABLE IF NOT EXISTS audit_log (
          id TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          conversation_id TEXT NOT NULL,
          bot_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          event TEXT NOT NULL,
          data TEXT NOT NULL
        )`,
        "CREATE INDEX IF NOT EXISTS audit_by_time ON audit_log (at)",
        "CREATE INDEX IF NOT EXISTS audit_by_call ON audit_log (tool_call_id)",
        `CREATE TABLE IF NOT EXISTS outbox (
          id TEXT PRIMARY KEY,
          at TEXT NOT NULL,
          data TEXT NOT NULL
        )`,
      ],
      "write",
    )
    .then(() => undefined);
  await ready;
  return c;
}

// ── secrets never reach the log ──────────────────────────────────────────

const SECRET_KEY = /key|token|secret|password|passwd|authorization|cookie|credential/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[hidden]" : redact(v, depth + 1)]));
}

export function previewArgs(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  try {
    return JSON.stringify(redact(args), null, 2).slice(0, 800);
  } catch {
    return undefined;
  }
}

// ── audit log ────────────────────────────────────────────────────────────

export interface AuditInput {
  conversationId: string;
  botId: string;
  toolCallId: string;
  tool: string;
  label: string;
  detail?: string;
  argsPreview?: string;
  event: AuditEvent;
  by: AuditEntry["by"];
  note?: string;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  const bot = await store.getBot(input.botId);
  const entry: AuditEntry = { id: randomUUID(), at: new Date().toISOString(), botName: bot?.name ?? input.botId, ...input };
  await (await client()).execute({
    sql: "INSERT INTO audit_log (id, at, conversation_id, bot_id, tool_call_id, event, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    args: [entry.id, entry.at, entry.conversationId, entry.botId, entry.toolCallId, entry.event, JSON.stringify(entry)],
  });
  publish({ type: "approvals-changed" });
}

export async function listAudit(limit = 200): Promise<AuditEntry[]> {
  const rows = await (await client()).execute({ sql: "SELECT data FROM audit_log ORDER BY at DESC, rowid DESC LIMIT ?", args: [limit] });
  return rows.rows.map((r) => JSON.parse(String(r.data)) as AuditEntry);
}

async function requestRow(toolCallId: string): Promise<AuditEntry | undefined> {
  const rows = await (await client()).execute({
    sql: "SELECT data FROM audit_log WHERE tool_call_id = ? AND event = 'requested' LIMIT 1",
    args: [toolCallId],
  });
  return rows.rows[0] ? (JSON.parse(String(rows.rows[0].data)) as AuditEntry) : undefined;
}

/** Log the request, with a preview of exactly what the agent wants to do. */
export async function recordRequest(info: {
  conversationId: string;
  botId: string;
  toolCallId: string;
  toolName: string;
  label: string;
  detail?: string;
  args: unknown;
}): Promise<void> {
  if (await requestRow(info.toolCallId)) return; // the harness may repeat the event
  await recordAudit({
    conversationId: info.conversationId,
    botId: info.botId,
    toolCallId: info.toolCallId,
    tool: info.toolName,
    label: info.label,
    detail: info.detail,
    argsPreview: previewArgs(info.args),
    event: "requested",
    by: "system",
  });
}

/** Log a decision. Called BEFORE the decision is passed on, so a crash can't lose the record. */
export async function recordDecision(
  conversationId: string,
  botId: string,
  toolCallId: string,
  event: "approved" | "rejected" | "auto-approved" | "limit-reached",
  by: AuditEntry["by"],
  note?: string,
): Promise<void> {
  const req = await requestRow(toolCallId);
  await recordAudit({
    conversationId,
    botId,
    toolCallId,
    tool: req?.tool ?? "unknown",
    label: req?.label ?? "Action",
    detail: req?.detail,
    argsPreview: req?.argsPreview,
    event,
    by,
    note,
  });
}

// ── Controlled Access policy ─────────────────────────────────────────────

export const DEFAULT_AUTO_LIMIT = 5;

function matches(pattern: string, tool: string): boolean {
  const re = new RegExp(`^${pattern.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");
  return re.test(tool);
}

export type AutoVerdict = { kind: "auto"; reason: string } | { kind: "ask"; reason?: string };

/** Should this approval request be answered by policy instead of a person? Only Controlled Access ever says yes. */
export async function decideAuto(bot: Bot, conversationId: string, toolName: string): Promise<AutoVerdict> {
  if (bot.approval !== "controlled") return { kind: "ask" };
  const rules = bot.autoApprove?.tools ?? [];
  const rule = rules.find((r) => matches(r, toolName));
  if (!rule) return { kind: "ask", reason: `${toolName} is not on this agent's pre-approved list.` };
  const limit = bot.autoApprove?.maxPerConversation ?? DEFAULT_AUTO_LIMIT;
  const used = await (await client()).execute({
    sql: "SELECT COUNT(*) AS n FROM audit_log WHERE conversation_id = ? AND bot_id = ? AND event = 'auto-approved'",
    args: [conversationId, bot.id],
  });
  const n = Number(used.rows[0]?.n ?? 0);
  if (n >= limit) return { kind: "ask", reason: `Automatic limit reached (${n} of ${limit} in this chat).` };
  return { kind: "auto", reason: `Matches pre-approved rule "${rule}" (${n + 1} of ${limit} in this chat).` };
}

// ── what is waiting for a person right now ───────────────────────────────

export async function listPending(): Promise<PendingApproval[]> {
  const c = await client();
  const rows = await c.execute(`SELECT data FROM messages WHERE data LIKE '%"status":"awaiting-approval"%'`);
  const out: PendingApproval[] = [];
  for (const r of rows.rows) {
    const m = JSON.parse(String(r.data)) as ChatMessage;
    if (m.status !== "streaming" || !m.botId) continue; // a finished or stopped turn can't be approved any more
    const bot = await store.getBot(m.botId);
    for (const p of m.parts) {
      if (p.kind !== "tool" || p.status !== "awaiting-approval") continue;
      const req = await requestRow(p.toolCallId);
      out.push({
        conversationId: m.conversationId,
        botId: m.botId,
        botName: bot?.name ?? m.botId,
        toolCallId: p.toolCallId,
        label: p.label,
        detail: p.detail,
        argsPreview: req?.argsPreview,
        createdAt: m.createdAt,
      });
    }
  }
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── the simulated outbox ─────────────────────────────────────────────────

/** The one built-in external action. It only writes a row: nothing leaves this machine. */
export async function sendToOutbox(bot: Bot, msg: { channel: "email" | "slack"; to: string; subject?: string; body: string }): Promise<OutboxItem> {
  const item: OutboxItem = { id: randomUUID().slice(0, 8), at: new Date().toISOString(), botId: bot.id, botName: bot.name, simulated: true, ...msg };
  await (await client()).execute({ sql: "INSERT INTO outbox (id, at, data) VALUES (?, ?, ?)", args: [item.id, item.at, JSON.stringify(item)] });
  publish({ type: "approvals-changed" });
  return item;
}

export async function listOutbox(limit = 50): Promise<OutboxItem[]> {
  const rows = await (await client()).execute({ sql: "SELECT data FROM outbox ORDER BY at DESC, rowid DESC LIMIT ?", args: [limit] });
  return rows.rows.map((r) => JSON.parse(String(r.data)) as OutboxItem);
}
