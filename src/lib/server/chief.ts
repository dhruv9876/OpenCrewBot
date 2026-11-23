// The Chief of Staff: turns one instruction into a validated task plan (who does
// what, in which order, what can run at the same time), and merges the finished
// tasks into one deliverable.
//
// Live mode: the Chief's own model writes the plan as JSON and we validate it.
// Mock mode (no model key): a small, clearly labelled heuristic builds the plan so
// the engine can be exercised end to end. It is NOT intelligence, and the plan says so.
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import type { Bot, ChatMessage } from "@/lib/shared/types";
import type { Plan, PlanTask, TaskUsage } from "@/lib/shared/tasks";
import { isMock } from "./config";
import { InputError } from "./errors";
import { runTurn } from "./runtime";

export const MAX_TASKS = 8;

const draftShape = z.object({
  id: z.string().regex(/^t\d+$/, "task ids look like t1, t2, …"),
  title: z.string().min(1).max(100),
  instruction: z.string().min(1).max(2000),
  assignee: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
});
const planShape = z.object({ tasks: z.array(draftShape).min(1).max(MAX_TASKS) });
type Draft = z.infer<typeof draftShape>;

export function textOf(message: ChatMessage | null | undefined): string {
  if (!message) return "";
  return message.parts
    .filter((p) => p.kind === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();
}

// ── validation (applies to model plans and heuristic plans alike) ────────

/** Turn drafts into tasks, rejecting unknown agents, unknown dependencies and cycles. */
export function buildTasks(planId: string, drafts: Draft[], members: Bot[]): PlanTask[] {
  const byHandle = new Map<string, Bot>();
  for (const b of members) {
    byHandle.set(b.handle.toLowerCase(), b);
    byHandle.set(b.name.toLowerCase(), b);
    byHandle.set(b.id, b);
  }
  const ids = new Set<string>();
  for (const d of drafts) {
    if (ids.has(d.id)) throw new Error(`The plan uses the task id ${d.id} twice.`);
    ids.add(d.id);
  }
  const tasks: PlanTask[] = drafts.map((d) => {
    const bot = byHandle.get(d.assignee.replace(/^@/, "").toLowerCase());
    if (!bot) throw new Error(`The plan assigns ${d.id} to "${d.assignee}", who isn't in this room.`);
    for (const dep of d.dependsOn) {
      if (!ids.has(dep)) throw new Error(`${d.id} depends on ${dep}, which doesn't exist.`);
      if (dep === d.id) throw new Error(`${d.id} depends on itself.`);
    }
    return {
      id: d.id,
      title: d.title.trim(),
      instruction: d.instruction.trim(),
      assignee: bot.id,
      dependsOn: [...new Set(d.dependsOn)],
      status: "pending",
      attempts: 0,
      maxAttempts: 2,
      timeoutMs: isMock() ? 60_000 : 5 * 60_000,
      needsApproval: false,
      conversationId: `task:${planId}-${d.id}`,
    };
  });
  // Cycle check (depth-first, three colours).
  const state = new Map<string, 1 | 2>();
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visit = (id: string) => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) throw new Error("The plan has a circular dependency.");
    state.set(id, 1);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
    state.set(id, 2);
  };
  for (const t of tasks) visit(t.id);
  return tasks;
}

// ── planning ─────────────────────────────────────────────────────────────

const PLANNER_INSTRUCTIONS = `You are the Chief of Staff of a team of AI agents. You never do the work yourself in this step; you plan it.
Break the person's request into 2 to ${MAX_TASKS} concrete tasks. For each task choose the single best agent from the roster, using their role and tools.
Give tasks that don't need each other's results no dependencies, so they run at the same time. Use dependsOn only when a task truly needs another task's output.
End with a task that combines the work only if an agent other than you should do the assembly; the final consolidation is done by you afterwards.
Reply with ONLY a JSON object: {"tasks":[{"id":"t1","title":"…","instruction":"…","assignee":"<agent handle>","dependsOn":[]}]}. No prose, no code fences.`;

function roster(members: Bot[]): string {
  return members
    .map((b) => {
      const tools = Object.entries(b.tools)
        .filter(([, on]) => on)
        .map(([name]) => name)
        .join(", ");
      return `- @${b.handle} (${b.name}), ${b.title || "generalist"}: ${b.description || b.instructions.slice(0, 120)} [tools: ${tools || "none"}]`;
    })
    .join("\n");
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The planner did not return JSON.");
  return JSON.parse(text.slice(start, end + 1));
}

async function planWithModel(planId: string, instruction: string, chief: Bot, members: Bot[]): Promise<PlanTask[]> {
  const agent = new Agent({
    id: `planner-${chief.id}`,
    name: `${chief.name} (planner)`,
    instructions: PLANNER_INSTRUCTIONS,
    model: `nebius/${chief.model}`,
  });
  const base = `Request from the person:\n${instruction}\n\nRoster:\n${roster(members)}`;
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? base : `${base}\n\nYour previous plan was rejected: ${lastError}\nReturn a corrected JSON plan.`;
    try {
      const result = (await agent.generate(prompt)) as { text?: string };
      const parsed = planShape.parse(extractJson(result.text ?? ""));
      return buildTasks(planId, parsed.tasks, members);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`The Chief of Staff could not produce a valid plan: ${lastError}`);
}

/** Mock mode only. Splits the work into three parallel research facets and one drafting task per
 * non-research agent. It exists to exercise the engine without a model; it is labelled as such. */
function planWithHeuristic(planId: string, instruction: string, chief: Bot, members: Bot[]): PlanTask[] {
  const others = members.filter((b) => b.id !== chief.id);
  let researchers = others.filter((b) => b.tools.webSearch);
  if (!researchers.length) researchers = others.length ? [others[0]] : [chief];
  const writers = others.filter((b) => !researchers.includes(b));
  const facets = ["key facts and evidence", "audience, customers and competitors", "risks, gaps and open questions"];
  const drafts: Draft[] = facets.map((facet, i) => ({
    id: `t${i + 1}`,
    title: `Research: ${facet}`,
    instruction: `Research ${facet} for this request: ${instruction}`,
    assignee: researchers[i % researchers.length].handle,
    dependsOn: [],
  }));
  writers.forEach((w, i) =>
    drafts.push({
      id: `t${facets.length + i + 1}`,
      title: `Draft with ${w.name}`,
      instruction: `Using the research results, write the first full draft that answers: ${instruction}`,
      assignee: w.handle,
      dependsOn: facets.map((_, n) => `t${n + 1}`),
    }),
  );
  return buildTasks(planId, drafts, members);
}

export async function makePlan(
  planId: string,
  instruction: string,
  chief: Bot,
  members: Bot[],
): Promise<{ tasks: PlanTask[]; source: Plan["plannerSource"] }> {
  if (!members.length) throw new InputError("This room has no agents to plan with.");
  if (isMock()) return { tasks: planWithHeuristic(planId, instruction, chief, members), source: "mock-heuristic" };
  return { tasks: await planWithModel(planId, instruction, chief, members), source: "llm" };
}

// ── consolidation ─────────────────────────────────────────────────────────

export async function consolidate(
  plan: Plan,
  chief: Bot,
  nameOf: (botId: string) => string,
): Promise<{ text: string; source: NonNullable<Plan["deliverableSource"]>; usage?: TaskUsage }> {
  const done = plan.tasks.filter((t) => t.status === "done" && t.output);
  const missing = plan.tasks.filter((t) => t.status !== "done");
  const note = missing.length
    ? `\n\n> **Incomplete:** ${missing.map((t) => `${t.id} "${t.title}" (${t.status})`).join(", ")} did not finish, so this report leaves those parts out.`
    : "";

  if (isMock()) {
    const sections = done.map((t) => `## ${t.title}\n*by ${nameOf(t.assignee)}*\n\n${t.output}`).join("\n\n");
    return {
      source: "mock-compiled",
      text: `# ${plan.instruction}\n\n> *Mock mode: no model key is set, so this report was compiled by joining the task outputs, not written by a model.*\n\n${sections}${note}`,
    };
  }

  const material = done.map((t) => `### ${t.title} (by ${nameOf(t.assignee)})\n${t.output!.slice(0, 6000)}`).join("\n\n");
  const reply = await runTurn({
    bot: chief,
    conversationId: `task:${plan.id}-final`,
    content: [
      `[Consolidation by the Chief of Staff]`,
      `The person asked: ${plan.instruction}`,
      `Your team finished these tasks:`,
      material || "(no task produced output)",
      missing.length ? `These tasks did NOT finish, so say clearly what is missing: ${missing.map((t) => t.title).join("; ")}.` : "",
      `Merge this into ONE final deliverable in Markdown: lead with the answer, keep the evidence and sources, resolve contradictions between tasks openly, and list next steps. Don't invent facts that aren't in the task results.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    route: { by: "handoff" },
  });
  if (!reply || reply.status !== "done") throw new Error(reply?.error ?? "The Chief of Staff could not write the final report.");
  return { text: textOf(reply) + note, source: "llm", usage: reply.usage };
}
