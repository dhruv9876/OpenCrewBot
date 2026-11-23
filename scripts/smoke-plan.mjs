// End-to-end check of the Chief of Staff and task engine against a running server.
//   node scripts/smoke-plan.mjs [baseUrl] ["instruction"]
// Prints the plan, each task's timing and attempts, and checks the engine's guarantees.
const base = process.argv[2] ?? "http://127.0.0.1:3000";
const instruction = process.argv[3] ?? "Prepare a short briefing on the competitive landscape for an online student career-guidance company.";

const api = async (path, init) => {
  const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json" } });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error}`);
  return json;
};

const boot = await api("/api/bootstrap");
const room = boot.rooms.find((r) => r.name === "Studio") ?? boot.rooms[0];
console.log(`mock mode: ${boot.status.mock} | room: ${room.name}\n`);

const { plan: created } = await api("/api/plans", { method: "POST", body: JSON.stringify({ instruction, roomId: room.id }) });
let plan = created;
const t0 = Date.now();
while (!["done", "partial", "failed", "cancelled", "interrupted"].includes(plan.status)) {
  await new Promise((r) => setTimeout(r, 700));
  plan = (await api(`/api/plans/${created.id}`)).plan;
  if (Date.now() - t0 > 180_000) throw new Error("timed out waiting for the plan");
}

const name = Object.fromEntries(boot.bots.map((b) => [b.id, b.name]));
console.log(`PLAN ${plan.id}  status=${plan.status}  planner=${plan.plannerSource}  deliverable=${plan.deliverableSource}`);
for (const t of plan.tasks) {
  const secs = t.startedAt && t.completedAt ? ((new Date(t.completedAt) - new Date(t.startedAt)) / 1000).toFixed(1) : "-";
  console.log(`  ${t.id} [${t.status}] ${name[t.assignee]} deps=[${t.dependsOn}] attempts=${t.attempts} ${secs}s  ${t.title}`);
}
console.log("\nEVENTS");
for (const e of plan.events) console.log(`  ${e.at.slice(11, 19)} ${e.message}`);

// Guarantees
const ok = (cond, msg) => (console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`), cond);
const parallel = plan.tasks.some((a) => plan.tasks.some((b) => a.id < b.id && a.startedAt && b.startedAt && a.completedAt && b.completedAt && a.startedAt < b.completedAt && b.startedAt < a.completedAt));
const depsOk = plan.tasks.every((t) => t.dependsOn.every((d) => plan.tasks.find((x) => x.id === d).completedAt <= t.startedAt));
console.log("");
const results = [
  ok(plan.tasks.length >= 2, "plan has multiple tasks"),
  ok(parallel, "at least two tasks ran at the same time"),
  ok(depsOk, "every task started only after its dependencies finished"),
  ok(plan.status === "done", "plan finished"),
  ok(Boolean(plan.deliverable), "a consolidated deliverable exists"),
  ok(plan.tasks.some((t) => t.attempts > 1) || !process.env.EXPECT_RETRY, "retry happened when a failure was injected"),
];
const history = (await api("/api/plans")).plans;
results.push(ok(history.some((p) => p.id === plan.id), "plan appears in execution history"));
process.exit(results.every(Boolean) ? 0 : 1);
