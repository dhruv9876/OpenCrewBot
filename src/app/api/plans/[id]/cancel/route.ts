import { handle } from "@/lib/server/http";
import { cancelPlan } from "@/lib/server/engine";

export async function POST(_request: Request, ctx: RouteContext<"/api/plans/[id]/cancel">) {
  const { id } = await ctx.params;
  return handle(async () => ({ plan: await cancelPlan(id) }));
}
