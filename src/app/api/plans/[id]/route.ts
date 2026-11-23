import { handle } from "@/lib/server/http";
import { getPlan } from "@/lib/server/engine";

export async function GET(_request: Request, ctx: RouteContext<"/api/plans/[id]">) {
  const { id } = await ctx.params;
  return handle(async () => ({ plan: await getPlan(id) }));
}
