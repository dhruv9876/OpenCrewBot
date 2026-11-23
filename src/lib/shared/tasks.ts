// Types for the Chief of Staff's plans and the task engine. Plain JSON, shared by server and browser.

export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting-approval"
  | "done"
  | "failed"
  | "timed-out"
  | "cancelled"
  | "interrupted";

export type PlanStatus = "planning" | "running" | "done" | "partial" | "failed" | "cancelled" | "interrupted";

export interface TaskUsage {
  input: number;
  output: number;
  costUsd: number | null;
}

export interface PlanTask {
  /** Short id inside the plan: t1, t2, … */
  id: string;
  title: string;
  /** What the assigned bot is asked to do. */
  instruction: string;
  /** Bot id of the agent that does it. */
  assignee: string;
  /** Task ids that must finish first; their outputs are handed to this task. */
  dependsOn: string[];
  status: TaskStatus;
  attempts: number;
  maxAttempts: number;
  /** Active running time allowed per attempt; time spent waiting for approval doesn't count. */
  timeoutMs: number;
  /** True once this task had to wait for a person (approval or a question). */
  needsApproval: boolean;
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  /** The conversation holding this task's full transcript (tool calls, approvals). */
  conversationId: string;
  usage?: TaskUsage;
}

export interface PlanEvent {
  at: string;
  message: string;
}

export interface Plan {
  id: string;
  instruction: string;
  roomId: string;
  /** The bot acting as Chief of Staff (the room's lead). */
  chiefId: string;
  /** Who produced the task list: a real model, or the labelled mock-mode heuristic. */
  plannerSource: "llm" | "mock-heuristic";
  status: PlanStatus;
  tasks: PlanTask[];
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  /** The consolidated final result. */
  deliverable?: string;
  /** How the deliverable was assembled: by the Chief's model, or compiled without a model (mock mode). */
  deliverableSource?: "llm" | "mock-compiled";
  error?: string;
  events: PlanEvent[];
  usage: TaskUsage;
}

export interface PlanSummary {
  id: string;
  instruction: string;
  roomId: string;
  status: PlanStatus;
  plannerSource: Plan["plannerSource"];
  createdAt: string;
  completedAt?: string;
  tasks: { total: number; done: number; failed: number; running: number };
}
