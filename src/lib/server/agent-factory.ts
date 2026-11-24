// The agent factory: turns a plain-language description ("a researcher who tracks
// competitors and answers in tables") into a complete agent, with no source edits.
//
// Live mode: a model designs the agent as JSON and we validate it.
// Mock mode (no model key): a small keyword heuristic designs it. That is NOT
// intelligence, and the draft says so.
//
// Permissions are decided in code, not by the model: a generated agent starts at
// "ask" (every sensitive action needs approval) unless the person explicitly asks
// for full access in their own words.
import { Agent } from "@mastra/core/agent";
import { z } from "zod";
import type { Bot, BotInput } from "@/lib/shared/types";
import type { AgentDraft } from "@/lib/shared/factory";
import { isMock } from "./config";
import { InputError } from "./errors";
import { DEFAULT_MODEL } from "./models";
import { writeMemory } from "./memory-files";
import { createBot, updateRoom } from "./service";
import * as store from "./db";

const PALETTE = ["#2f7df6", "#e5484d", "#30a46c", "#f5a524", "#8e4ec6", "#12a594", "#d6409f", "#6e56cf"];

const draftShape = z.object({
  name: z.string().min(1).max(40),
  title: z.string().min(1).max(60),
  description: z.string().min(1).max(300),
  /** The persona and working style, written as instructions to the agent. */
  persona: z.string().min(20).max(3000),
  emoji: z.string().min(1).max(8).default("🤖"),
  tools: z
    .object({
      webSearch: z.boolean().default(false),
      memory: z.boolean().default(true),
      codeMode: z.boolean().default(false),
      browser: z.boolean().default(false),
      askUser: z.boolean().default(true),
    })
    .default({ webSearch: false, memory: true, codeMode: false, browser: false, askUser: true }),
  skills: z.array(z.string().min(1).max(60)).max(6).default([]),
  outputFormat: z.string().min(1).max(300).default("Markdown, with a short summary first."),
});
type DraftShape = z.infer<typeof draftShape>;

const DESIGNER_INSTRUCTIONS = `You design AI agents for a business team. Given a plain-language request, design ONE agent.
Pick a short human name, a job title, a one-line description, a persona written as direct instructions to the agent ("You are…, you always…"), an emoji, the tools it needs, up to 6 skills (for example Market Research, Competitor Analysis, Financial Modelling, Presentation Creation, Email Drafting, Code Review, Data Analysis, Lead Generation), and the output format its answers should follow.
Tools are booleans: webSearch, memory, codeMode (writes code to analyse data), browser, askUser. Give only the tools the job needs.
Reply with ONLY a JSON object: {"name","title","description","persona","emoji","tools":{"webSearch":false,"memory":true,"codeMode":false,"browser":false,"askUser":true},"skills":[],"outputFormat"}. No prose, no code fences.`;

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The designer did not return JSON.");
  return JSON.parse(text.slice(start, end + 1));
}

function colorFor(text: string): string {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

/** Full access only when the person says so in their own words. Never chosen by a model. */
export function approvalFor(description: string): Bot["approval"] {
  return /\b(full access|fully autonomous|no approval needed|without (asking|approval))\b/i.test(description) ? "full" : "ask";
}

/** Fold persona, skills and output format into the instructions the runtime already feeds the model. */
function composeInstructions(d: DraftShape): string {
  const parts = [d.persona.trim()];
  if (d.skills.length) parts.push(`Skills you lean on: ${d.skills.join(", ")}.`);
  parts.push(`Output format: ${d.outputFormat}`);
  parts.push("Before any external or sensitive action (sending, posting, changing something outside this chat), ask for approval and say exactly what you will do. Say plainly when you could not verify something.");
  return parts.join("\n\n").slice(0, 8000);
}

function toInput(d: DraftShape, description: string): BotInput {
  return {
    name: d.name.trim(),
    title: d.title.trim(),
    description: d.description.trim(),
    instructions: composeInstructions(d),
    emoji: d.emoji,
    color: colorFor(d.name),
    model: DEFAULT_MODEL,
    tools: d.tools,
    approval: approvalFor(description),
    pinned: false,
    skills: d.skills,
    outputFormat: d.outputFormat,
    origin: "factory",
    createdFrom: description,
  };
}

// ── mock-mode heuristic ───────────────────────────────────────────────────

const RULES: { re: RegExp; role: string; emoji: string; tools: Partial<DraftShape["tools"]>; skills: string[]; persona: string }[] = [
  { re: /\b(leads?\b|prospect|outreach)/i, role: "Lead Generator", emoji: "🎯", tools: { webSearch: true }, skills: ["Lead Generation", "Email Drafting"], persona: "You find and qualify potential customers, and draft short, honest outreach." },
  { re: /\b(research|competitor|market|intelligence|landscape)/i, role: "Market Researcher", emoji: "🔭", tools: { webSearch: true }, skills: ["Market Research", "Competitor Analysis"], persona: "You research markets and competitors, read the best sources, and report findings with the URLs you used." },
  { re: /\b(data|spreadsheet|csv|excel|sales|revenue|metric|financ)/i, role: "Data Analyst", emoji: "📊", tools: { codeMode: true }, skills: ["Data Analysis", "Financial Modelling"], persona: "You analyse data with real calculations, show your numbers, and turn them into recommendations." },
  { re: /\b(writ|copy|content|campaign|social|blog|marketing|email|presentation|deck)/i, role: "Content Writer", emoji: "✍️", tools: { webSearch: true }, skills: ["Email Drafting", "Presentation Creation"], persona: "You write clear, on-brand content and drafts, and you adapt tone to the audience." },
  { re: /\b(code|developer|github|repo|bug|engineer|review)/i, role: "Code Reviewer", emoji: "🛠️", tools: { codeMode: true }, skills: ["Code Review"], persona: "You inspect code and repositories, find real issues, and propose prioritised, concrete fixes." },
];

function designWithHeuristic(description: string): DraftShape {
  const hits = RULES.filter((r) => r.re.test(description));
  const primary = hits[0];
  const named = description.match(/\b(?:called|named)\s+["']?([A-Za-z][\w-]{1,30})/i)?.[1];
  const tools = { webSearch: false, memory: true, codeMode: false, browser: false, askUser: true };
  for (const h of hits) Object.assign(tools, h.tools);
  const wantsTable = /\btables?\b/i.test(description);
  const wantsReport = /\breports?\b/i.test(description);
  return {
    name: named ?? primary?.role ?? "Assistant",
    title: primary?.role ?? "Generalist",
    description: description.trim().slice(0, 300),
    persona: `${primary?.persona ?? "You are a helpful generalist."} Your brief from the person who created you: ${description.trim()}`.slice(0, 3000),
    emoji: primary?.emoji ?? "🤖",
    tools,
    skills: [...new Set(hits.flatMap((h) => h.skills))].slice(0, 6),
    outputFormat: wantsTable ? "A comparison table, then a short summary." : wantsReport ? "A structured report with headings." : "Markdown, with a short summary first.",
  };
}

// ── public API ────────────────────────────────────────────────────────────

/** Design an agent from a description without creating it, so the person can review and edit. */
export async function designAgent(description: string): Promise<AgentDraft> {
  const text = description.trim();
  if (text.length < 10) throw new InputError("Describe the agent in a sentence or two, for example: a researcher who tracks competitors and answers in tables.");
  if (text.length > 2000) throw new InputError("Keep the description under 2,000 characters.");

  if (isMock()) return { input: toInput(designWithHeuristic(text), text), source: "mock-heuristic", createdFrom: text };

  const agent = new Agent({ id: "agent-designer", name: "Agent designer", instructions: DESIGNER_INSTRUCTIONS, model: `nebius/${DEFAULT_MODEL}` });
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt === 0 ? `Request:\n${text}` : `Request:\n${text}\n\nYour previous answer was rejected: ${lastError}\nReturn corrected JSON.`;
    try {
      const result = (await agent.generate(prompt)) as { text?: string };
      return { input: toInput(draftShape.parse(extractJson(result.text ?? "")), text), source: "llm", createdFrom: text };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`Could not design that agent: ${lastError}`);
}

/** Create the agent. It is usable immediately (appears in the roster, @mentions, rooms, plans) with no code change. */
export async function createAgent(draft: AgentDraft, opts: { roomId?: string } = {}): Promise<Bot> {
  const input = draft.input;
  if (!input?.name?.trim() || !input.instructions?.trim()) throw new InputError("The agent draft is missing a name or instructions.");
  if (opts.roomId && !(await store.getRoom(opts.roomId))) throw new InputError("That room doesn't exist.");

  const bot = await createBot({ ...input, origin: "factory", createdFrom: draft.createdFrom });

  // Provenance: what was remembered, when, and why.
  const when = new Date().toISOString();
  writeMemory(
    bot.id,
    `# ${bot.name}'s memory\n\n## Origin\n- ${when} — Created by the agent factory (${draft.source === "llm" ? "designed by a model" : "mock-mode keyword heuristic"}). Why: the person asked for "${draft.createdFrom.replace(/\s+/g, " ").slice(0, 300)}".\n\n## Notes\n`,
  );

  if (opts.roomId) {
    const room = await store.getRoom(opts.roomId);
    if (room && !room.memberIds.includes(bot.id)) await updateRoom(room.id, { memberIds: [...room.memberIds, bot.id] });
  }
  return bot;
}

export async function createAgentFromDescription(description: string, opts: { roomId?: string } = {}): Promise<{ bot: Bot; draft: AgentDraft }> {
  const draft = await designAgent(description);
  return { bot: await createAgent(draft, opts), draft };
}
