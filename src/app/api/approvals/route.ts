import { handle } from "@/lib/server/http";
import { listAudit, listOutbox, listPending } from "@/lib/server/approvals";

/** Approval centre data: what waits for a person, the audit log, and the simulated outbox. */
export async function GET() {
  return handle(async () => ({ pending: await listPending(), audit: await listAudit(), outbox: await listOutbox() }));
}
