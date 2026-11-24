"use client";

// Approval centre: everything waiting for a person, the audit log, and the simulated outbox.
// Open it at /approvals. Approve and reject here or in chat; both go through the same endpoint.
import { useCallback, useEffect, useState } from "react";
import type { AuditEntry, OutboxItem, PendingApproval } from "@/lib/shared/approvals";

interface Data {
  pending: PendingApproval[];
  audit: AuditEntry[];
  outbox: OutboxItem[];
}

const EVENT_STYLE: Record<AuditEntry["event"], string> = {
  requested: "text-warn",
  approved: "text-ok",
  "auto-approved": "text-ok",
  rejected: "text-danger",
  "limit-reached": "text-warn",
  executed: "text-ok",
  "not-executed": "text-danger",
};

export default function ApprovalCentre() {
  const [data, setData] = useState<Data>({ pending: [], audit: [], outbox: [] });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      const json = (await res.json()) as Data & { error?: string };
      if (!res.ok) throw new Error(json.error || "Couldn't load approvals.");
      setData(json);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load approvals.");
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, 1500);
    return () => clearInterval(timer);
  }, [load]);

  const decide = async (p: PendingApproval, approve: boolean) => {
    setBusy(p.toolCallId);
    try {
      const res = await fetch(`/api/conversations/${encodeURIComponent(p.conversationId)}/approval`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botId: p.botId, toolCallId: p.toolCallId, approve }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Couldn't send that.");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't send that.");
    } finally {
      setBusy("");
    }
  };

  return (
    <main className="mx-auto max-w-4xl space-y-8 bg-app px-5 py-8 text-ink">
      <header className="flex items-baseline justify-between">
        <h1 className="text-xl font-semibold">Approval centre</h1>
        <a href="/" className="text-[13px] text-mute underline">
          Back to the app
        </a>
      </header>
      {error && <p className="rounded-xl bg-danger-soft px-4 py-2.5 text-[13px] text-danger">{error}</p>}

      <section>
        <h2 className="mb-3 text-[13px] font-medium tracking-wide text-mute uppercase">Waiting for you ({data.pending.length})</h2>
        {data.pending.length === 0 && <p className="text-[13.5px] text-mute">Nothing is waiting. Agents ask here before external or sensitive actions.</p>}
        <div className="space-y-3">
          {data.pending.map((p) => (
            <div key={p.toolCallId} className="rounded-2xl border border-warn/30 bg-warn-soft p-4">
              <p className="text-[14.5px] font-medium">
                {p.botName} wants to: {p.label}
              </p>
              {p.detail && <p className="mt-0.5 text-[13px] text-mute">{p.detail}</p>}
              {p.argsPreview && <pre className="mt-2 max-h-40 overflow-auto rounded-lg bg-code p-2.5 text-[12px] whitespace-pre-wrap">{p.argsPreview}</pre>}
              <div className="mt-3 flex gap-2">
                <button disabled={busy === p.toolCallId} onClick={() => decide(p, false)} className="rounded-lg bg-raised-2 px-3.5 py-1.5 text-[13px] hover:bg-hover disabled:opacity-50">
                  Reject
                </button>
                <button disabled={busy === p.toolCallId} onClick={() => decide(p, true)} className="rounded-lg bg-accent px-3.5 py-1.5 text-[13px] text-accent-ink hover:bg-accent-hover disabled:opacity-50">
                  Approve
                </button>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-1 text-[13px] font-medium tracking-wide text-mute uppercase">Simulated outbox ({data.outbox.length})</h2>
        <p className="mb-3 text-[12.5px] text-faint">SIMULATED: these are stored locally and were not delivered anywhere. A rejected action never appears here.</p>
        {data.outbox.length === 0 && <p className="text-[13.5px] text-mute">No messages have been sent.</p>}
        <div className="space-y-2">
          {data.outbox.map((o) => (
            <div key={o.id} className="rounded-xl bg-raised px-4 py-2.5 text-[13px]">
              <span className="text-mute">
                {o.at.slice(11, 19)} · {o.botName} · {o.channel} to {o.to}
              </span>
              <p>{o.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-[13px] font-medium tracking-wide text-mute uppercase">Audit log ({data.audit.length})</h2>
        <div className="overflow-x-auto rounded-2xl bg-raised">
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-faint">
              <tr>
                <th className="px-3 py-2">Time</th>
                <th className="px-3 py-2">Agent</th>
                <th className="px-3 py-2">Action</th>
                <th className="px-3 py-2">Event</th>
                <th className="px-3 py-2">By</th>
                <th className="px-3 py-2">Note</th>
              </tr>
            </thead>
            <tbody>
              {data.audit.map((a) => (
                <tr key={a.id} className="border-t border-line align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-mute">{a.at.slice(11, 19)}</td>
                  <td className="px-3 py-2">{a.botName}</td>
                  <td className="px-3 py-2">{a.label}</td>
                  <td className={`px-3 py-2 font-medium ${EVENT_STYLE[a.event]}`}>{a.event}</td>
                  <td className="px-3 py-2 text-mute">{a.by}</td>
                  <td className="px-3 py-2 text-mute">{a.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
