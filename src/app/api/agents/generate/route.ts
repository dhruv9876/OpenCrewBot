import { body, handle } from "@/lib/server/http";
import { createAgent, designAgent } from "@/lib/server/agent-factory";
import type { AgentDraft } from "@/lib/shared/factory";

/**
 * Agent factory.
 *  { description }                    -> designs an agent and returns the draft (nothing is created)
 *  { description, create: true }      -> designs and creates it
 *  { draft, create: true }            -> creates an (edited) draft as is
 * Add roomId to put the new agent in a room.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const b = await body<{ description?: string; draft?: AgentDraft; create?: boolean; roomId?: string }>(request);
    const draft = b.draft ?? (await designAgent(String(b.description ?? "")));
    if (!b.create) return { draft };
    return { draft, bot: await createAgent(draft, { roomId: b.roomId }) };
  });
}
