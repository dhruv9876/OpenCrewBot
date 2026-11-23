import { handle } from "@/lib/server/http";
import { resumePlan } from "@/lib/server/engine";

export async function POST(_request: Request, ctx: RouteContext<"/api/plans/[id]/resume">) {
  const { id } = await ctx.params;
  return handle(async () => ({ plan: await resumePlan(id) }));
}
