// End-to-end check of Module G (Ask First / Controlled / Full, audit log, rejection) on a running server.
//   node scripts/smoke-approvals.mjs [baseUrl]
// Works in mock mode: the mock model sends a message when told "send an email to <x> saying <y>".
const base = process.argv[2] ?? "http://127.0.0.1:3000";
const api = async (path, init) => {
  const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json" } });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error}`);
  return json;
};
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });
const patch = (path, body) => api(path, { method: "PATCH", body: JSON.stringify(body) });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => (console.log(`${c ? "PASS" : "FAIL"}  ${m}`), c);

async function until(fn, what, ms = 20000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await sleep(300);
  }
}

const boot = await api("/api/bootstrap");
console.log(`mock mode: ${boot.status.mock}\n`);

// A fresh agent that can send (simulated) messages. The factory starts it at Ask First.
const made = await post("/api/agents/generate", { description: "An assistant called Courier who sends short follow-up emails for the sales team", create: true });
const bot = made.bot;
await patch(`/api/bots/${bot.id}`, { tools: { ...bot.tools, outbox: true } });
const conv = `dm:${bot.id}`;
const tag = Date.now().toString(36);
const say = (text) => post(`/api/conversations/${encodeURIComponent(conv)}/messages`, { text });
const state = () => api("/api/approvals");
const mine = (s) => s.audit.filter((a) => a.botId === bot.id);
const outboxOf = (s, word) => s.outbox.filter((o) => o.botId === bot.id && o.body.includes(word));
const pendingFor = (s) => s.pending.filter((p) => p.botId === bot.id);
const decide = (p, approve) => post(`/api/conversations/${encodeURIComponent(p.conversationId)}/approval`, { botId: p.botId, toolCallId: p.toolCallId, approve });

const results = [];

// 1. Ask First + REJECT
await say(`send an email to boss@example.com saying reject-${tag}`);
const p1 = await until(async () => pendingFor(await state())[0], "approval request");
results.push(ok(p1.argsPreview?.includes(`reject-${tag}`), "approval request shows a preview of what will be sent"));
results.push(ok(outboxOf(await state(), `reject-${tag}`).length === 0, "nothing sent while the request is waiting"));
await decide(p1, false);
await sleep(2500);
let s = await state();
results.push(ok(outboxOf(s, `reject-${tag}`).length === 0, "REJECTED action did NOT execute (outbox is empty)"));
let ev = mine(s).filter((a) => a.toolCallId === p1.toolCallId).map((a) => a.event);
results.push(ok(ev.includes("requested") && ev.includes("rejected") && ev.includes("not-executed") && !ev.includes("executed"), `audit log shows requested, rejected, not-executed (${ev.reverse().join(" > ")})`));

// 2. Ask First + APPROVE
await say(`send an email to boss@example.com saying approve-${tag}`);
const p2 = await until(async () => pendingFor(await state())[0], "second approval request");
await decide(p2, true);
await until(async () => outboxOf(await state(), `approve-${tag}`).length === 1, "approved action to run");
s = await state();
ev = mine(s).filter((a) => a.toolCallId === p2.toolCallId).map((a) => a.event);
results.push(ok(ev.includes("approved") && ev.includes("executed"), "APPROVED action executed, and the audit log says so"));

// 3. Controlled Access: pre-approved tool runs by itself, but only up to the limit
await patch(`/api/bots/${bot.id}`, { approval: "controlled", autoApprove: { tools: ["outbox_send"], maxPerConversation: 1 } });
await say(`send an email to boss@example.com saying auto-${tag}`);
await until(async () => outboxOf(await state(), `auto-${tag}`).length === 1, "pre-approved action to run on its own");
s = await state();
results.push(ok(pendingFor(s).length === 0 && mine(s).some((a) => a.event === "auto-approved" && a.by === "policy"), "Controlled: pre-approved action ran with no human, logged as auto-approved"));
await say(`send an email to boss@example.com saying over-limit-${tag}`);
const p3 = await until(async () => pendingFor(await state())[0], "request after the limit");
results.push(ok(outboxOf(await state(), `over-limit-${tag}`).length === 0, "Controlled: past the limit it asks a person instead of acting"));
await decide(p3, false);
await sleep(2000);
results.push(ok(outboxOf(await state(), `over-limit-${tag}`).length === 0, "Controlled: rejecting past the limit also never executes"));

// 4. Full Access: runs without asking, still audit-logged
await patch(`/api/bots/${bot.id}`, { approval: "full" });
await say(`send an email to boss@example.com saying full-${tag}`);
await until(async () => outboxOf(await state(), `full-${tag}`).length === 1, "full-access action to run");
s = await state();
results.push(ok(pendingFor(s).length === 0 && mine(s).some((a) => a.event === "executed" && a.by === "policy"), "Full Access: ran without asking and is still in the audit log"));

console.log("\nOutbox is SIMULATED: nothing was delivered outside this machine.");
process.exit(results.every(Boolean) ? 0 : 1);
