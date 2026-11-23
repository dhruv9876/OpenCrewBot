// The task engine: runs a plan's tasks respecting dependencies, in parallel where it can,
// with retries, per-task timeouts, cancellation, recovery after a restart and a saved history.
//
// Each task runs as an ordinary bot turn in its own conversation (`task:<plan>-<task>`), so it
// uses the same tools, memory, permissions and approval cards as any chat, and can be stopped
// on its own without touching the others.
import { randomUUID } from "node:crypto";
import type { Bot, ChatMessage } from "@/lib/shared/types";
import type { Plan, PlanSummary, PlanTask } from "@/lib/shared/tasks";
import * as store from "./db";
import { publish, subscribe } from "./bus";
import { InputError } from "./errors";
import { makePlan, consolidate, textOf } from "./chief";
import { runTurn, stopConversation } from "./runtime";

const MAX_PARALLEL = 4;
const TICK_MS = 500;

class TimeoutError extends Error {}
class CancelledError extends Error {}

interface Engine {
  /** Plans being executed by this process: the source of truth while they run. */
  plans: Map<string, Plan>;
  cancelled: Set<string>;
  running: Set<string>;
  saving: Map<string, Promise<void>>;
}
const g = globalThis as unknown as { __opencrewbotEngine?: Engine };
const E: Engine = (g.__opencrewbotEngine ??= { plans: new Map(), cancelled: new Set(), running: new Set(), saving: new Map() });

const now = () => new Date().toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function log(plan: Plan, message: string) {
  plan.events.push({ at: now(), message });
  if (plan.events.length > 300) plan.events.splice(0, plan.events.length - 300);
}

/** Persist the plan's latest state. Writes are queued so an older snapshot never lands last. */
function save(plan: Plan): Promise<void> {
  const previous = E.saving.get(plan.id) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(() => store.savePlan(plan));
  E.saving.set(plan.id, next);
  publish({ type: "plans-changed", planId: plan.id });
  return next;
}

function summarize(plan: Plan): PlanSummary {
  const count = (s: string) => plan.tasks.filter((t) => t.status === s).length;
  return {
    id: plan.id,
    instruction: plan.instruction,
    roomId: plan.roomId,
    status: plan.status,
    plannerSource: plan.plannerSource,
    createdAt: plan.createdAt,
    completedAt: plan.completedAt,
    tasks: { total: plan.tasks.length, done: count("done"), failed: count("failed") + count("timed-out"), running: count("running") + count("awaiting-approval") },
  };
}

export async function getPlan(id: string): Promise<Plan> {
  const plan = E.plans.get(id) ?? (await store.getPlan(id));
  if (!plan) throw new InputError("That plan doesn't exist.");
  return plan;
}

export async function listPlans(): Promise<PlanSummary[]> {
  const stored = await store.listPlans();
  return stored.map((p) => summarize(E.plans.get(p.id) ?? p));
}

// ── starting a plan ───────────────────────────────────────────────────────

export async function startPlan(instruction: string, roomId: string): Promise<Plan> {
  const text = instruction.trim();
  if (!text) throw new InputError("Give the Chief of Staff something to do.");
  if (text.length > 8000) throw new InputError("Instructions are limited to 8,000 characters.");
  const room = await store.getRoom(roomId);
  if (!room) throw new InputError("That room doesn't exist.");
  const bots = new Map((await store.listBots()).map((b) => [b.id, b]));
  const members = room.memberIds.map((id) => bots.get(id)).filter((b): b is Bot => Boolean(b));
  if (!members.length) throw new InputError("Add at least one agent to the room first.");
  const chief = members.find((b) => b.id === room.leadId) ?? members[0];

  const plan: Plan = {
    id: randomUUID().slice(0, 8),
    instruction: text,
    roomId,
    chiefId: chief.id,
    plannerSource: "llm",
    status: "planning",
    tasks: [],
    createdAt: now(),
    events: [],
    usage: { input: 0, output: 0, costUsd: null },
  };
  log(plan, `${chief.name} (Chief of Staff) is planning the work.`);
  E.plans.set(plan.id, plan);
  await save(plan);

  void (async () => {
    try {
      const { tasks, source } = await makePlan(plan.id, text, chief, members);
      plan.tasks = tasks;
      plan.plannerSource = source;
      log(plan, `Plan ready: ${tasks.length} tasks${source === "mock-heuristic" ? " (mock-mode heuristic planner, not a model)" : ""}.`);
      await save(plan);
      if (E.cancelled.has(plan.id)) return void (await finish(plan, "cancelled"));
      await executePlan(plan.id);
    } catch (error) {
      plan.error = errorText(error);
      log(plan, `Planning failed: ${plan.error}`);
      await finish(plan, "failed");
    }
  })();
  return plan;
}

// ── running tasks ─────────────────────────────────────────────────────────

function taskPrompt(plan: Plan, task: PlanTask, byId: Map<string, PlanTask>, nameOf: (id: string) => string): string {
  const inputs = task.dependsOn
    .map((d) => byId.get(d))
    .filter((t): t is PlanTask => Boolean(t?.output))
    .map((t) => `### ${t.title} (by ${nameOf(t.assignee)})\n${t.output!.slice(0, 4000)}`);
  return [
    `[Task ${task.id}, part of a plan led by the Chief of Staff]`,
    `Overall goal: ${plan.instruction}`,
    `Your task: ${task.title}`,
    task.instruction,
    inputs.length ? `Results from earlier tasks you can build on:\n\n${inputs.join("\n\n")}` : "",
    `Return the finished work for this task only, in Markdown. Be specific, cite the sources or data you used, and say plainly what you could not verify.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function attempt(plan: Plan, task: PlanTask, bot: Bot, content: string): Promise<ChatMessage> {
  // Test hook: make the first attempt of the listed tasks fail, to demonstrate retry and recovery.
  const inject = (process.env.OPENCREWBOT_TEST_FAIL_ONCE ?? "").split(",").map((s) => s.trim());
  if (inject.includes(task.id) && task.attempts === 1) throw new Error("Injected failure (OPENCREWBOT_TEST_FAIL_ONCE test hook).");

  let active = 0;
  let timedOut = false;
  const unsubscribe = subscribe((event) => {
    if (event.type !== "message" || event.message.conversationId !== task.conversationId) return;
    const waiting = event.message.parts.some((p) => (p.kind === "tool" && p.status === "awaiting-approval") || (p.kind === "question" && p.answer === undefined));
    if (waiting && task.status === "running") {
      task.status = "awaiting-approval";
      task.needsApproval = true;
      log(plan, `${task.id} is waiting for a person to approve or answer.`);
      void save(plan);
    } else if (!waiting && task.status === "awaiting-approval") {
      task.status = "running";
      void save(plan);
    }
  });
  // Only active running time counts toward the timeout, not time spent waiting for approval.
  const timer = setInterval(() => {
    if (task.status !== "running") return;
    active += TICK_MS;
    if (active >= task.timeoutMs && !timedOut) {
      timedOut = true;
      void stopConversation(task.conversationId);
    }
  }, TICK_MS);

  try {
    const reply = await runTurn({ bot, conversationId: task.conversationId, content, route: { by: "handoff" } });
    if (timedOut) throw new TimeoutError(`Timed out after ${Math.round(task.timeoutMs / 1000)}s of work.`);
    if (E.cancelled.has(plan.id)) throw new CancelledError("Cancelled.");
    if (!reply) throw new Error("The task was stopped before it started.");
    if (reply.status === "error") throw new Error(reply.error ?? "The agent failed.");
    if (reply.status === "stopped") throw new Error(reply.error ?? "The agent was stopped.");
    return reply;
  } finally {
    clearInterval(timer);
    unsubscribe();
  }
}

async function runTask(plan: Plan, task: PlanTask, bots: Map<string, Bot>): Promise<void> {
  const nameOf = (id: string) => bots.get(id)?.name ?? "A former member";
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const bot = bots.get(task.assignee);
  if (!bot) {
    task.status = "failed";
    task.error = "The assigned agent no longer exists.";
    task.completedAt = now();
    log(plan, `${task.id} failed: ${task.error}`);
    return void (await save(plan));
  }
  while (task.attempts < task.maxAttempts) {
    if (E.cancelled.has(plan.id)) {
      task.status = "cancelled";
      break;
    }
    task.attempts++;
    task.status = "running";
    task.startedAt ??= now();
    task.error = undefined;
    log(plan, `${task.id} "${task.title}" started by ${bot.name} (attempt ${task.attempts}/${task.maxAttempts}).`);
    await save(plan);
    try {
      const reply = await attempt(plan, task, bot, taskPrompt(plan, task, byId, nameOf));
      task.output = textOf(reply);
      task.status = "done";
      task.completedAt = now();
      if (reply.usage) {
        task.usage = { ...reply.usage };
        plan.usage.input += reply.usage.input;
        plan.usage.output += reply.usage.output;
        if (reply.usage.costUsd !== null) plan.usage.costUsd = (plan.usage.costUsd ?? 0) + reply.usage.costUsd;
      }
      log(plan, `${task.id} finished.`);
      return void (await save(plan));
    } catch (error) {
      if (error instanceof CancelledError || E.cancelled.has(plan.id)) {
        task.status = "cancelled";
        task.error = "Cancelled.";
        break;
      }
      task.error = errorText(error);
      if (task.attempts >= task.maxAttempts) {
        task.status = error instanceof TimeoutError ? "timed-out" : "failed";
        task.completedAt = now();
        log(plan, `${task.id} ${task.status}: ${task.error}`);
        return void (await save(plan));
      }
      log(plan, `${task.id} attempt ${task.attempts} failed (${task.error}); retrying.`);
      await save(plan);
      await sleep(400 * task.attempts);
    }
  }
  task.completedAt ??= now();
  await save(plan);
}

async function finish(plan: Plan, status: Plan["status"]) {
  plan.status = status;
  plan.completedAt = now();
  E.cancelled.delete(plan.id);
  log(plan, `Plan ${status}.`);
  await save(plan);
}

const UNFINISHED = new Set(["failed", "timed-out", "cancelled", "interrupted"]);

export async function executePlan(planId: string): Promise<void> {
  if (E.running.has(planId)) return;
  const plan = await getPlan(planId);
  E.plans.set(planId, plan);
  E.running.add(planId);
  try {
    plan.status = "running";
    plan.startedAt ??= now();
    log(plan, "Execution started.");
    await save(plan);
    const bots = new Map((await store.listBots()).map((b) => [b.id, b]));
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    const inflight = new Map<string, Promise<void>>();

    for (;;) {
      if (E.cancelled.has(plan.id)) break;
      // A task whose dependency didn't finish can never run.
      for (const t of plan.tasks) {
        if (t.status === "pending" && t.dependsOn.some((d) => UNFINISHED.has(byId.get(d)!.status))) {
          t.status = "cancelled";
          t.error = "Skipped: a task it depends on did not finish.";
          t.completedAt = now();
          log(plan, `${t.id} skipped because an upstream task did not finish.`);
        }
      }
      const ready = plan.tasks.filter((t) => t.status === "pending" && t.dependsOn.every((d) => byId.get(d)!.status === "done"));
      for (const t of ready) {
        if (inflight.size >= MAX_PARALLEL) break;
        t.status = "running"; // claim it before the next loop pass
        inflight.set(t.id, runTask(plan, t, bots).finally(() => inflight.delete(t.id)));
      }
      if (!inflight.size) break;
      await Promise.race(inflight.values());
    }
    await Promise.allSettled(inflight.values());

    if (E.cancelled.has(plan.id)) {
      for (const t of plan.tasks) if (t.status === "pending") (t.status = "cancelled"), (t.error = "Cancelled."), (t.completedAt = now());
      return void (await finish(plan, "cancelled"));
    }

    const doneCount = plan.tasks.filter((t) => t.status === "done").length;
    if (!doneCount) {
      plan.error = "No task finished.";
      return void (await finish(plan, "failed"));
    }
    const chief = bots.get(plan.chiefId) ?? [...bots.values()][0];
    log(plan, `${chief.name} is consolidating ${doneCount} result(s) into the final deliverable.`);
    await save(plan);
    try {
      const result = await consolidate(plan, chief, (id) => bots.get(id)?.name ?? "A former member");
      plan.deliverable = result.text;
      plan.deliverableSource = result.source;
      if (result.usage) {
        plan.usage.input += result.usage.input;
        plan.usage.output += result.usage.output;
        if (result.usage.costUsd !== null) plan.usage.costUsd = (plan.usage.costUsd ?? 0) + result.usage.costUsd;
      }
      await postDeliverable(plan, chief);
      await finish(plan, doneCount === plan.tasks.length ? "done" : "partial");
    } catch (error) {
      plan.error = `Consolidation failed: ${errorText(error)}`;
      await finish(plan, "partial");
    }
  } catch (error) {
    plan.error = errorText(error);
    await finish(plan, "failed");
  } finally {
    E.running.delete(planId);
  }
}

/** Put the final report in the room so it's part of the conversation too. */
async function postDeliverable(plan: Plan, chief: Bot) {
  if (!plan.deliverable) return;
  const message: ChatMessage = {
    id: randomUUID(),
    conversationId: `room:${plan.roomId}`,
    role: "bot",
    botId: chief.id,
    createdAt: now(),
    status: "done",
    parts: [{ kind: "text", text: plan.deliverable }],
    model: plan.deliverableSource === "mock-compiled" ? "mock" : chief.model,
  };
  await store.saveMessage(message);
  publish({ type: "message", message });
}

// ── cancel, resume, recovery ─────────────────────────────────────────────

export async function cancelPlan(planId: string): Promise<Plan> {
  const plan = await getPlan(planId);
  if (["done", "partial", "failed", "cancelled"].includes(plan.status)) throw new InputError("That plan has already finished.");
  E.cancelled.add(planId);
  log(plan, "Cancellation requested.");
  for (const t of plan.tasks) {
    if (t.status === "running" || t.status === "awaiting-approval") await stopConversation(t.conversationId);
  }
  if (!E.running.has(planId)) {
    // Not executing in this process (e.g. planning, or interrupted): close it out directly.
    for (const t of plan.tasks) if (!["done", "failed", "timed-out"].includes(t.status)) (t.status = "cancelled"), (t.completedAt ??= now());
    await finish(plan, "cancelled");
  } else await save(plan);
  return plan;
}

/** Continue a plan that was interrupted, partly failed or cancelled: finished work is kept. */
export async function resumePlan(planId: string): Promise<Plan> {
  const plan = await getPlan(planId);
  if (E.running.has(planId) || plan.status === "planning") throw new InputError("That plan is still running.");
  if (plan.status === "done") throw new InputError("That plan already finished.");
  if (!plan.tasks.length) throw new InputError("That plan never got a task list; start a new one.");
  let reset = 0;
  for (const t of plan.tasks) {
    if (t.status === "done") continue;
    t.status = "pending";
    t.attempts = 0;
    t.error = undefined;
    t.completedAt = undefined;
    reset++;
  }
  plan.error = undefined;
  plan.completedAt = undefined;
  plan.deliverable = undefined;
  E.cancelled.delete(planId);
  E.plans.set(planId, plan);
  log(plan, `Resuming: ${reset} unfinished task(s) will run again; finished results are kept.`);
  await save(plan);
  void executePlan(planId);
  return plan;
}

/** On startup: anything that was mid-flight can't continue by itself. Mark it so a person can resume it. */
export async function recoverPlans(): Promise<void> {
  for (const plan of await store.listPlans()) {
    if (plan.status !== "running" && plan.status !== "planning") continue;
    for (const t of plan.tasks) if (t.status === "running" || t.status === "awaiting-approval") (t.status = "interrupted"), (t.error = "Interrupted by a server restart.");
    plan.status = "interrupted";
    plan.completedAt = now();
    log(plan, "The server restarted while this plan was running. Use Resume to continue; finished tasks are kept.");
    await store.savePlan(plan);
  }
}
