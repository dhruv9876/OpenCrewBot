import { body, handle } from "@/lib/server/http";
import { listPlans, startPlan } from "@/lib/server/engine";

/** Execution history: every plan, newest first. */
export async function GET() {
  return handle(async () => ({ plans: await listPlans() }));
}

/** Give the Chief of Staff one instruction. It plans, delegates and runs the tasks. */
export async function POST(request: Request) {
  return handle(async () => {
    const { instruction, roomId } = await body<{ instruction: string; roomId: string }>(request);
    return { plan: await startPlan(String(instruction ?? ""), String(roomId ?? "")) };
  });
}
