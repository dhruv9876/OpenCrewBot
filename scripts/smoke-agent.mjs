// End-to-end check of the agent factory against a running server.
//   node scripts/smoke-agent.mjs [baseUrl]
const base = process.argv[2] ?? "http://127.0.0.1:3000";
const api = async (path, init) => {
  const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json" } });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error}`);
  return json;
};
const ok = (c, m) => (console.log(`${c ? "PASS" : "FAIL"}  ${m}`), c);
const post = (b) => api("/api/agents/generate", { method: "POST", body: JSON.stringify(b) });

const boot = await api("/api/bootstrap");
const room = boot.rooms[0];
console.log(`mock mode: ${boot.status.mock}\n`);

const desc = "An agent called Nova who researches competitors of education companies and answers in comparison tables";
const preview = await post({ description: desc });

const made = await post({ description: desc, create: true, roomId: room.id });
const after = await api("/api/bootstrap");
const bot = after.bots.find((b) => b.id === made.bot.id);
const inRoom = after.rooms.find((r) => r.id === room.id).memberIds.includes(made.bot.id);

const full = await post({ description: "A support agent with full access that answers customer emails", create: true });
const strict = await post({ description: "A support agent that answers customer emails", create: true });

const results = [
  ok(preview.draft && !preview.bot, "preview returns a draft and creates nothing"),
  ok(Boolean(bot), "created agent appears in the roster without any code change"),
  ok(bot?.origin === "factory" && bot?.createdFrom === desc, "agent records how it was created"),
  ok(bot?.name === "Nova", "name taken from the request"),
  ok(Array.isArray(bot?.skills) && bot.skills.length > 0, "agent has skills"),
  ok(/table/i.test(bot?.outputFormat ?? ""), "output format follows the request"),
  ok(inRoom, "agent was added to the room"),
  ok(strict.bot.approval === "ask", "default permission is Ask First"),
  ok(full.bot.approval === "full", "full access only when explicitly requested"),
];
console.log(`\nsource: ${made.draft.source}`);
process.exit(results.every(Boolean) ? 0 : 1);
