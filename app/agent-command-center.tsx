"use client";

/**
 * Agent Command Center
 * The dashboard consumes the mission event stream, so each agent's state on
 * screen is the state the server actually reports: started, retried, revised,
 * completed, with real token and cost totals. A run can be cancelled, and the
 * cancellation reaches the gateway calls.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  Boxes,
  BrainCircuit,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Code2,
  Coins,
  Crown,
  Database,
  FileCheck2,
  Gauge,
  Inbox,
  LockKeyhole,
  Mail,
  Menu,
  Minus,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  SearchCheck,
  ShieldCheck,
  Settings2,
  Sparkles,
  Square,
  X,
  Zap,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type AgentId = "inbox" | "builder" | "verifier" | "chief";
type Provider = "openai" | "gemini" | "claude" | "perplexity";
type ConnectionId = "gmail" | "outlook" | "model_gateway" | "approval_policy";
type ModelPreference = "auto" | Provider;
type ApprovalMode = "prepare" | "guarded" | "autonomous";
type RunStatus = "idle" | "working" | "complete" | "blocked" | "failed";

type Usage = { inputTokens: number; outputTokens: number; estimated: boolean };

type AgentResult = {
  id: AgentId;
  status: RunStatus;
  output: string;
  checks: string[];
  provider: Provider | null;
  model: string | null;
  usage: Usage | null;
  costUsd: number | null;
  latencyMs: number | null;
  revisions: number;
};

type ApprovalItem = {
  id: string;
  title: string;
  detail: string;
  risk: "low" | "medium" | "high";
  state: "pending" | "approved" | "rejected";
};

type RoutingEntry = {
  agent: AgentId;
  provider: Provider;
  model: string | null;
  costTier: "free" | "low" | "standard" | "premium";
  requested: ModelPreference;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  reason: string;
  alternatives: Provider[];
  projectedCostUsd: number | null;
};

type RunTotals = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  modelCalls: number;
  revisions: number;
};

type WorkflowSummary = {
  taskClass: string;
  complexity: number;
  rationale: string;
  activeAgents: AgentId[];
  skippedAgents: AgentId[];
  estimatedTotalTokens: number;
  strategy: "free-first" | "balanced" | "quality-first";
  signals?: string[];
  irreversible?: boolean;
};

type MissionResponse = {
  runId: string;
  connected: boolean;
  summary: string;
  finalDeliverable: string;
  agents: AgentResult[];
  approvals: ApprovalItem[];
  createdAt: string;
  routing?: RoutingEntry[];
  workflow?: WorkflowSummary;
  totals?: RunTotals;
  durable?: boolean;
};

type WorkspaceStatus = {
  owner: string;
  live: boolean;
  gateway: { configured: boolean; timeoutMs: number | null; maxAttempts: number | null };
  providers: Array<{
    provider: Provider;
    configured: boolean;
    available: boolean;
    costTier: string;
    hasPricing: boolean;
    model: string | null;
  }>;
  storage: { durable: boolean };
  limits: { perMinute: number; perDay: number };
  identity: { signedIn: boolean; email: string | null; fullName: string | null };
};

type LiveAgent = {
  status: RunStatus;
  provider: Provider | null;
  model: string | null;
  note: string;
  revisions: number;
};

const providerLabels: Record<ModelPreference, string> = {
  auto: "Auto · Smart route",
  openai: "OpenAI",
  gemini: "Gemini",
  claude: "Claude",
  perplexity: "Perplexity",
};

const providerCatalog: Array<{ id: Provider; detail: string }> = [
  { id: "openai", detail: "Reasoning, coding, and high-stakes work" },
  { id: "gemini", detail: "Fast, economical, and long-context work" },
  { id: "claude", detail: "Coding, writing, and careful review" },
  { id: "perplexity", detail: "Fresh research and source-aware answers" },
];

const connectionCatalog: Array<{
  id: ConnectionId;
  name: string;
  detail: string;
  icon: typeof Mail;
  required?: boolean;
}> = [
  { id: "gmail", name: "Gmail", detail: "Inbox reading, search, and draft replies", icon: Mail },
  { id: "outlook", name: "Outlook", detail: "Mail folders, threads, and draft replies", icon: Inbox },
  {
    id: "model_gateway",
    name: "Model gateway",
    detail: "Auto-routes OpenAI, Gemini, Claude, and Perplexity",
    icon: Boxes,
  },
  {
    id: "approval_policy",
    name: "Approval policy",
    detail: "External writes require an explicit decision",
    icon: ShieldCheck,
    required: true,
  },
];

const agentDefinitions: Array<{
  id: AgentId;
  name: string;
  role: string;
  description: string;
  icon: typeof Mail;
  accent: string;
}> = [
  {
    id: "inbox",
    name: "Inbox Agent",
    role: "Email & action intake",
    description:
      "Reads connected inboxes, identifies commitments, drafts replies, and creates work items.",
    icon: Mail,
    accent: "text-sky-300 bg-sky-400/10 border-sky-300/20",
  },
  {
    id: "builder",
    name: "Builder Agent",
    role: "Research & implementation",
    description:
      "Solves the assigned problem, writes code or documents, and revises when the Verifier sends corrections.",
    icon: Code2,
    accent: "text-violet-300 bg-violet-400/10 border-violet-300/20",
  },
  {
    id: "verifier",
    name: "Verifier Agent",
    role: "Testing & quality control",
    description:
      "Challenges the solution, returns a PASS or REVISE verdict, and sends exact corrections back to Builder.",
    icon: ShieldCheck,
    accent: "text-emerald-300 bg-emerald-400/10 border-emerald-300/20",
  },
  {
    id: "chief",
    name: "Chief Agent",
    role: "Planning & supervision",
    description:
      "Owns the outcome, delegates work, enforces approvals, and confirms every task is complete.",
    icon: Crown,
    accent: "text-amber-300 bg-amber-400/10 border-amber-300/20",
  },
];

const initialModels: Record<AgentId, ModelPreference> = {
  inbox: "auto",
  builder: "auto",
  verifier: "auto",
  chief: "auto",
};

const idleAgent: LiveAgent = {
  status: "idle",
  provider: null,
  model: null,
  note: "",
  revisions: 0,
};

const starterMission =
  "Review the request, break it into tasks, produce the best solution, test it carefully, and prepare the final result for my approval.";

const navItems = [
  { label: "Overview", icon: Gauge, target: "overview" },
  { label: "Agents", icon: Bot, target: "agents" },
  { label: "Approvals", icon: FileCheck2, target: "approvals" },
  { label: "Connections", icon: Boxes, target: "connections" },
];

const connectionHelp: Record<string, { title: string; body: string }> = {
  Gmail: {
    title: "Gmail is connected to ChatGPT",
    body: "The hosted site still needs an approved Gmail bridge before Inbox Agent can read messages or prepare thread-specific work here. Until then it never claims to have read a message.",
  },
  Outlook: {
    title: "Outlook is optional and not connected yet",
    body: "Connect the Outlook Email plugin first. After that, an OAuth or MCP bridge is needed for this independently hosted site to read Outlook folders and threads.",
  },
  "Model gateway": {
    title: "Live model access needs a gateway",
    body: "Configure an OpenAI-compatible gateway with provider model IDs and server-side secrets. The browser never stores API keys; until then, missions use the safe routing preview.",
  },
  "Approval policy": {
    title: "Internal work is not blocked by approval",
    body: "Planning, drafting, research, and testing run immediately. Approval is reserved for external writes such as sending email, publishing, charging, or changing production.",
  },
};

function statusCopy(status: RunStatus) {
  if (status === "working") return "Working";
  if (status === "complete") return "Complete";
  if (status === "blocked") return "Needs input";
  if (status === "failed") return "Stopped";
  return "Standby";
}

function riskClasses(risk: ApprovalItem["risk"]) {
  if (risk === "high") return "border-rose-400/30 bg-rose-400/10 text-rose-200";
  if (risk === "medium") return "border-amber-400/30 bg-amber-400/10 text-amber-200";
  return "border-sky-400/30 bg-sky-400/10 text-sky-200";
}

function formatCost(value: number | null | undefined) {
  if (value === null || value === undefined) return "not priced";
  if (value === 0) return "$0.0000";
  return `$${value < 0.0001 ? value.toExponential(2) : value.toFixed(4)}`;
}

export function AgentCommandCenter() {
  const [mission, setMission] = useState(starterMission);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("prepare");
  const [models, setModels] = useState<Record<AgentId, ModelPreference>>(initialModels);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<MissionResponse | null>(null);
  const [history, setHistory] = useState<MissionResponse[]>([]);
  const [mobileNav, setMobileNav] = useState(false);
  const [includeInbox, setIncludeInbox] = useState(true);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const [liveAgents, setLiveAgents] = useState<Record<AgentId, LiveAgent>>({
    inbox: idleAgent,
    builder: idleAgent,
    verifier: idleAgent,
    chief: idleAgent,
  });
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [enabledProviders, setEnabledProviders] = useState<Provider[]>([
    "openai",
    "gemini",
    "claude",
    "perplexity",
  ]);
  const [enabledConnections, setEnabledConnections] = useState<ConnectionId[]>([
    "gmail",
    "model_gateway",
    "approval_policy",
  ]);
  const [connectionManagerOpen, setConnectionManagerOpen] = useState(false);
  const [selectedConnection, setSelectedConnection] = useState<string | null>(null);
  const [settingsHydrated, setSettingsHydrated] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  /* ---------------------------------------------------------------------- */
  /* Workspace state                                                         */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    fetch("/api/status")
      .then((response) => (response.ok ? (response.json() as Promise<WorkspaceStatus>) : null))
      .then((payload) => {
        if (!cancelled && payload) setStatus(payload);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      const response = await fetch("/api/runs?limit=8");
      if (!response.ok) throw new Error("history unavailable");
      const payload = (await response.json()) as {
        durable: boolean;
        runs: Array<{
          runId: string;
          createdAt: string;
          summary: string;
          connected: boolean;
          costUsd: number | null;
        }>;
      };
      if (payload.durable && payload.runs.length > 0) {
        setHistory(
          payload.runs.map((row) => ({
            runId: row.runId,
            createdAt: row.createdAt,
            summary: row.summary,
            connected: row.connected,
            finalDeliverable: "",
            agents: [],
            approvals: [],
            durable: true,
          })),
        );
        return;
      }
    } catch {
      // Fall through to browser-local history.
    }

    const saved = window.localStorage.getItem("acc.runs");
    if (!saved) return;
    try {
      setHistory(JSON.parse(saved) as MissionResponse[]);
    } catch {
      window.localStorage.removeItem("acc.runs");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadHistory(), 0);
    return () => window.clearTimeout(timer);
  }, [loadHistory]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const saved = window.localStorage.getItem("acc.settings");
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as {
            enabledProviders?: unknown;
            enabledConnections?: unknown;
          };
          const providerValues = Array.isArray(parsed.enabledProviders)
            ? parsed.enabledProviders
            : [];
          const connectionValues = Array.isArray(parsed.enabledConnections)
            ? parsed.enabledConnections
            : [];
          const validProviders = providerValues.filter(
            (value): value is Provider =>
              typeof value === "string" &&
              ["openai", "gemini", "claude", "perplexity"].includes(value),
          );
          const validConnections = connectionValues.filter(
            (value): value is ConnectionId =>
              typeof value === "string" &&
              ["gmail", "outlook", "model_gateway", "approval_policy"].includes(value),
          );
          if (validProviders.length > 0) setEnabledProviders(validProviders);
          if (validConnections.length > 0) {
            setEnabledConnections(
              validConnections.includes("approval_policy")
                ? validConnections
                : [...validConnections, "approval_policy"],
            );
            setIncludeInbox(
              validConnections.includes("gmail") || validConnections.includes("outlook"),
            );
          }
        } catch {
          window.localStorage.removeItem("acc.settings");
        }
      }
      setSettingsHydrated(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!settingsHydrated) return;
    window.localStorage.setItem(
      "acc.settings",
      JSON.stringify({ enabledProviders, enabledConnections }),
    );
  }, [enabledConnections, enabledProviders, settingsHydrated]);

  const pendingApprovals =
    result?.approvals.filter((item) => item.state === "pending").length ?? 0;

  const liveCost = useMemo(() => {
    if (result?.totals) return result.totals.costUsd;
    return null;
  }, [result]);

  /* ---------------------------------------------------------------------- */
  /* Connection toggles                                                      */
  /* ---------------------------------------------------------------------- */

  function toggleProvider(provider: Provider) {
    if (enabledProviders.includes(provider)) {
      if (enabledProviders.length === 1) {
        setError("Keep at least one model provider enabled for Auto Router.");
        return;
      }
      setEnabledProviders((current) => current.filter((candidate) => candidate !== provider));
      setModels((current) => {
        const next = { ...current };
        (Object.keys(next) as AgentId[]).forEach((agent) => {
          if (next[agent] === provider) next[agent] = "auto";
        });
        return next;
      });
      return;
    }
    setError("");
    setEnabledProviders((current) => [...current, provider]);
  }

  function toggleConnection(connection: ConnectionId) {
    const definition = connectionCatalog.find((candidate) => candidate.id === connection);
    if (definition?.required) return;

    const wasEnabled = enabledConnections.includes(connection);
    const next = wasEnabled
      ? enabledConnections.filter((candidate) => candidate !== connection)
      : [...enabledConnections, connection];
    setEnabledConnections(next);
    if (connection === "gmail" || connection === "outlook") {
      setIncludeInbox(next.includes("gmail") || next.includes("outlook"));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Mission streaming                                                       */
  /* ---------------------------------------------------------------------- */

  function applyEvent(event: Record<string, unknown>) {
    const type = event.type as string;

    if (type === "run.started") {
      const workflow = (event.plan as { activeAgents?: AgentId[] }) ?? {};
      const active = workflow.activeAgents ?? [];
      setLiveAgents({
        inbox: { ...idleAgent, status: active.includes("inbox") ? "working" : "idle" },
        builder: { ...idleAgent, status: active.includes("builder") ? "working" : "idle" },
        verifier: { ...idleAgent, status: active.includes("verifier") ? "working" : "idle" },
        chief: { ...idleAgent, status: active.includes("chief") ? "working" : "idle" },
      });
      setProgressLabel(
        (event.connected as boolean)
          ? "Auto Router assigned the live models"
          : "Routing preview: no gateway configured",
      );
      setProgress(5);
      return;
    }

    if (type === "agent.started") {
      const agent = event.agent as AgentId;
      setLiveAgents((current) => ({
        ...current,
        [agent]: {
          status: "working",
          provider: event.provider as Provider,
          model: (event.model as string) ?? null,
          note: event.reason as string,
          revisions: event.revision as number,
        },
      }));
      const step = event.step as number;
      const total = Math.max(event.totalSteps as number, step);
      setProgress(Math.min(96, Math.round((step / (total + 1)) * 100)));
      setProgressLabel(
        `${agentDefinitions.find((item) => item.id === agent)?.name} is working (step ${step} of ${total})`,
      );
      return;
    }

    if (type === "agent.retry") {
      const agent = event.agent as AgentId;
      const attempt = event.attempt as { provider: string; error?: string };
      setLiveAgents((current) => ({
        ...current,
        [agent]: {
          ...current[agent],
          note: `Retrying after ${attempt.error ?? `${attempt.provider} failed`}`,
        },
      }));
      return;
    }

    if (type === "agent.completed") {
      const agent = event.agent as AgentId;
      setLiveAgents((current) => ({
        ...current,
        [agent]: {
          status: "complete",
          provider: event.provider as Provider,
          model: (event.model as string) ?? null,
          note:
            (event.fallbackFrom as string | null)
              ? `Fallback route used ${event.provider as string}`
              : current[agent].note,
          revisions: event.revision as number,
        },
      }));
      return;
    }

    if (type === "agent.skipped") {
      const agent = event.agent as AgentId;
      setLiveAgents((current) => ({
        ...current,
        [agent]: { ...idleAgent, note: event.reason as string },
      }));
      return;
    }

    if (type === "revision.requested") {
      setNotice(
        `Verifier returned corrections. Builder is revising (round ${event.round as number}).`,
      );
      setLiveAgents((current) => ({
        ...current,
        builder: { ...current.builder, status: "working", note: "Applying verifier corrections" },
      }));
      return;
    }

    if (type === "run.completed") {
      const next: MissionResponse = {
        runId: event.runId as string,
        createdAt: event.createdAt as string,
        connected: event.connected as boolean,
        summary: event.summary as string,
        finalDeliverable: event.finalDeliverable as string,
        agents: event.agents as AgentResult[],
        approvals: event.approvals as ApprovalItem[],
        routing: event.routing as RoutingEntry[],
        workflow: event.workflow as WorkflowSummary,
        totals: event.totals as RunTotals,
      };
      setResult(next);
      setProgress(100);
      setProgressLabel("Mission prepared");
      setHistory((current) => {
        const merged = [next, ...current.filter((run) => run.runId !== next.runId)].slice(0, 8);
        try {
          window.localStorage.setItem("acc.runs", JSON.stringify(merged));
        } catch {
          // Storage can be unavailable; history is best-effort in the browser.
        }
        return merged;
      });
      return;
    }

    if (type === "persisted") {
      setResult((current) =>
        current ? { ...current, durable: event.stored as boolean } : current,
      );
      if (!(event.stored as boolean) && event.reason) {
        setNotice(`History is browser-local this deployment: ${event.reason as string}`);
      }
      return;
    }

    if (type === "run.failed") {
      setError(event.error as string);
      setProgress(0);
      setLiveAgents((current) => {
        const next = { ...current };
        (Object.keys(next) as AgentId[]).forEach((agent) => {
          if (next[agent].status === "working") {
            next[agent] = { ...next[agent], status: "failed" };
          }
        });
        return next;
      });
    }
  }

  async function runMission() {
    if (!mission.trim()) {
      setError("Add a mission before asking the team to start.");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError("");
    setNotice("");
    setResult(null);
    setProgress(2);
    setProgressLabel("Auto Router is classifying the request");

    try {
      const response = await fetch("/api/mission?stream=1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        signal: controller.signal,
        body: JSON.stringify({
          prompt: mission.trim(),
          mode: approvalMode,
          models,
          includeInbox:
            includeInbox &&
            (enabledConnections.includes("gmail") || enabledConnections.includes("outlook")),
          enabledProviders,
          modelGatewayEnabled: enabledConnections.includes("model_gateway"),
        }),
      });

      if (!response.ok || !response.body) {
        const problem = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(problem.error ?? "The mission could not be started.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.split("\n").find((entry) => entry.startsWith("data: "));
          if (!line) continue;
          const payload = line.slice(6);
          if (payload === "[DONE]") continue;
          try {
            applyEvent(JSON.parse(payload) as Record<string, unknown>);
          } catch {
            // A malformed frame should not kill the rest of the stream.
          }
        }
      }
    } catch (caught) {
      if (controller.signal.aborted) {
        setNotice("Mission cancelled. No further model calls were made.");
        setProgress(0);
      } else {
        setError(
          caught instanceof Error ? caught.message : "The mission could not be started.",
        );
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function cancelMission() {
    abortRef.current?.abort();
  }

  async function updateApproval(id: string, state: "approved" | "rejected") {
    const run = result;
    if (!run) return;
    const item = run.approvals.find((approval) => approval.id === id);

    setResult((current) =>
      current
        ? {
            ...current,
            approvals: current.approvals.map((approval) =>
              approval.id === id ? { ...approval, state } : approval,
            ),
          }
        : current,
    );

    try {
      const response = await fetch(`/api/runs/${run.runId}/approvals/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state }),
      });
      const payload = (await response.json()) as { recorded?: boolean; reason?: string };
      setNotice(
        payload.recorded
          ? `Decision recorded for “${item?.title ?? "this action"}”. No external action was executed.`
          : `Decision kept in this browser only${payload.reason ? `: ${payload.reason}` : "."}`,
      );
    } catch {
      setNotice("Decision kept in this browser only; it could not be saved to the server.");
    }
  }

  function resetMission() {
    setMission("");
    setResult(null);
    setError("");
    setNotice("");
    setProgress(0);
    setLiveAgents({
      inbox: idleAgent,
      builder: idleAgent,
      verifier: idleAgent,
      chief: idleAgent,
    });
  }

  function jumpTo(target: string) {
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth" });
    setMobileNav(false);
  }

  const gatewayLive = status?.live ?? false;
  const ownerLabel = status?.owner?.trim() || "the owner";

  return (
    <main className="min-h-screen bg-[#06111b] text-slate-100 selection:bg-cyan-300 selection:text-slate-950">
      <div className="pointer-events-none fixed inset-0 overflow-hidden" aria-hidden="true">
        <div className="absolute -left-48 top-0 h-[540px] w-[540px] rounded-full bg-cyan-500/8 blur-[120px]" />
        <div className="absolute right-[-180px] top-[18%] h-[500px] w-[500px] rounded-full bg-violet-500/7 blur-[140px]" />
      </div>

      <header className="sticky top-0 z-40 border-b border-white/8 bg-[#07131e]/92 backdrop-blur-xl">
        <div className="mx-auto flex h-[72px] max-w-[1680px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="text-slate-300 lg:hidden"
              onClick={() => setMobileNav((value) => !value)}
              aria-label="Open navigation"
            >
              {mobileNav ? <X /> : <Menu />}
            </Button>
            <div className="grid size-10 place-items-center rounded-xl border border-cyan-300/20 bg-cyan-300/10 text-cyan-200 shadow-[0_0_30px_rgba(34,211,238,0.08)]">
              <BrainCircuit className="size-5" />
            </div>
            <div>
              <p className="text-base font-semibold tracking-[-0.02em] sm:text-lg">
                Agent Command Center
              </p>
              <p className="hidden text-xs text-slate-500 sm:block">
                Owned and supervised by {ownerLabel}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3">
            <Badge
              variant="outline"
              className={`hidden px-3 py-1 md:flex ${
                gatewayLive
                  ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-200"
                  : "border-cyan-400/20 bg-cyan-400/8 text-cyan-200"
              }`}
            >
              <span
                className={`size-1.5 rounded-full ${gatewayLive ? "bg-emerald-300" : "bg-cyan-300"}`}
              />
              {gatewayLive ? "Live models" : "Routing preview"}
            </Badge>
            <Badge
              variant="outline"
              className="hidden border-white/10 bg-white/[0.04] px-3 py-1 text-slate-300 sm:flex"
            >
              <Database className="size-3" />
              {status?.storage.durable ? "History saved" : "Local history"}
            </Badge>
            <div className="grid size-9 place-items-center rounded-full border border-white/10 bg-white/[0.06] text-xs font-semibold text-slate-200">
              AD
            </div>
          </div>
        </div>
      </header>

      {mobileNav && (
        <nav className="fixed inset-x-3 top-[82px] z-50 rounded-2xl border border-white/10 bg-[#0b1b29] p-2 shadow-2xl lg:hidden">
          {navItems.map((item) => (
            <button
              key={item.label}
              onClick={() => jumpTo(item.target)}
              className="flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm text-slate-300 hover:bg-white/[0.06] hover:text-white"
            >
              <item.icon className="size-4" />
              {item.label}
            </button>
          ))}
        </nav>
      )}

      <div className="relative mx-auto grid max-w-[1680px] grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)]">
        <aside className="sticky top-[72px] hidden h-[calc(100vh-72px)] border-r border-white/8 px-4 py-6 lg:flex lg:flex-col">
          <nav className="space-y-1">
            {navItems.map((item, index) => (
              <button
                key={item.label}
                onClick={() => jumpTo(item.target)}
                className={`flex min-h-10 w-full items-center justify-between rounded-xl px-3 text-left text-sm transition ${
                  index === 0
                    ? "bg-cyan-300/10 text-cyan-100"
                    : "text-slate-400 hover:bg-white/[0.04] hover:text-slate-200"
                }`}
              >
                <span className="flex items-center gap-3">
                  <item.icon className="size-4" />
                  {item.label}
                </span>
                {item.label === "Approvals" && pendingApprovals > 0 ? (
                  <span className="grid size-5 place-items-center rounded-full bg-amber-300 text-[11px] font-bold text-slate-950">
                    {pendingApprovals}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>

          <div className="mt-auto space-y-3">
            {status ? (
              <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                  <Coins className="size-4 text-cyan-300" />
                  Configured routes
                </div>
                <p className="mt-2 text-xs leading-5 text-slate-500">
                  {status.providers.filter((provider) => provider.available).length} of{" "}
                  {status.providers.length} providers live ·{" "}
                  {status.limits.perMinute}/min limit
                </p>
              </div>
            ) : null}
            <div className="rounded-2xl border border-white/8 bg-white/[0.025] p-4">
              <div className="flex items-center gap-2 text-sm font-medium text-slate-200">
                <ShieldCheck className="size-4 text-emerald-300" />
                Safety lock active
              </div>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                External actions stay paused until {ownerLabel} approves them.
              </p>
            </div>
          </div>
        </aside>

        <section className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div id="overview" className="scroll-mt-28">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
              <div>
                <div className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-cyan-300/80">
                  <Activity className="size-3.5" />
                  Live workspace
                </div>
                <h1 className="max-w-3xl text-3xl font-semibold tracking-[-0.035em] text-white sm:text-4xl">
                  Give the team an outcome. Chief handles the rest.
                </h1>
                <p className="mt-3 max-w-2xl text-base leading-7 text-slate-400">
                  Email intake, research, implementation, testing, and final review stay
                  visible in one place.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {["Auto Router", "Free-first", "Fallback ready", "Revision loop"].map((tag) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="border-white/10 bg-white/[0.025] px-3 py-1 text-slate-400"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>

            <Card className="mt-7 gap-0 overflow-hidden border-white/10 bg-[#0a1a28]/90 py-0 shadow-[0_28px_90px_rgba(0,0,0,0.22)]">
              <CardHeader className="gap-1 border-b border-white/8 px-5 py-4 sm:px-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <CardTitle className="text-base text-white">New mission</CardTitle>
                    <CardDescription className="mt-1 text-slate-500">
                      Auto Router picks the cheapest capable model and activates only the
                      agents this request needs.
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2 rounded-lg border border-white/8 bg-black/10 px-3 py-2">
                    <Inbox className="size-4 text-sky-300" />
                    <label htmlFor="include-inbox" className="text-sm text-slate-300">
                      Include email context
                    </label>
                    <Switch
                      id="include-inbox"
                      checked={includeInbox}
                      onCheckedChange={setIncludeInbox}
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-5 sm:p-6">
                <Textarea
                  value={mission}
                  onChange={(event) => setMission(event.target.value)}
                  placeholder="Describe the outcome you need..."
                  className="min-h-28 resize-y border-white/10 bg-[#06131f] px-4 py-3 text-base leading-7 text-slate-100 shadow-inner placeholder:text-slate-600 focus-visible:border-cyan-300/50 focus-visible:ring-cyan-300/15"
                  maxLength={4000}
                />

                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-cyan-300/10 bg-cyan-300/[0.035] px-4 py-3 text-xs text-slate-500">
                  <span className="flex items-center gap-2 text-cyan-200">
                    <Zap className="size-3.5" />
                    Automatic by default
                  </span>
                  <span>Classifies the request</span>
                  <span>Estimates token budget</span>
                  <span>Retries the next configured model</span>
                  <span>Sends verifier corrections back to Builder</span>
                </div>

                {error ? (
                  <div className="mt-3 flex items-center gap-2 text-sm text-rose-300" role="alert">
                    <CircleAlert className="size-4" />
                    {error}
                  </div>
                ) : null}
                {notice ? (
                  <div className="mt-3 flex items-center gap-2 text-sm text-cyan-200" role="status">
                    <Sparkles className="size-4" />
                    {notice}
                  </div>
                ) : null}

                <div className="mt-4 flex flex-col justify-between gap-4 xl:flex-row xl:items-center">
                  <div className="flex flex-wrap items-center gap-3">
                    <Select
                      value={approvalMode}
                      onValueChange={(value) => setApprovalMode(value as ApprovalMode)}
                    >
                      <SelectTrigger className="w-[220px] border-white/10 bg-white/[0.03] text-slate-200">
                        <ShieldCheck className="size-4 text-emerald-300" />
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="border-white/10 bg-[#102333] text-slate-100">
                        <SelectItem value="prepare">Prepare for my approval</SelectItem>
                        <SelectItem value="guarded">Run safe steps automatically</SelectItem>
                        <SelectItem value="autonomous">Autonomous within policy</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="text-xs text-slate-500">
                      {mission.length.toLocaleString()} / 4,000
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {running ? (
                      <Button
                        variant="outline"
                        onClick={cancelMission}
                        className="border-rose-400/30 bg-transparent text-rose-200 hover:bg-rose-400/10"
                      >
                        <Square />
                        Cancel
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        onClick={resetMission}
                        className="text-slate-400 hover:bg-white/[0.05] hover:text-slate-200"
                      >
                        <RotateCcw />
                        Clear
                      </Button>
                    )}
                    <Button
                      onClick={runMission}
                      disabled={running}
                      className="h-10 bg-cyan-300 px-5 font-semibold text-slate-950 shadow-[0_12px_32px_rgba(34,211,238,0.15)] hover:bg-cyan-200"
                    >
                      {running ? <Activity className="animate-pulse" /> : <Play />}
                      {running ? "Team is working" : "Start mission"}
                    </Button>
                  </div>
                </div>
              </CardContent>
              {(running || result) && (
                <div className="border-t border-white/8 bg-black/10 px-5 py-3 sm:px-6">
                  <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                    <span>{progressLabel || (running ? "Working" : "Mission prepared")}</span>
                    <span>{progress}%</span>
                  </div>
                  <Progress
                    value={progress}
                    className="h-1.5 bg-white/5 [&_[data-slot=progress-indicator]]:bg-cyan-300"
                  />
                </div>
              )}
            </Card>
          </div>

          <section id="agents" className="mt-8 scroll-mt-28">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-white">
                  Your agent team
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Auto can choose a different provider for every role.
                </p>
              </div>
              <Badge
                variant="outline"
                className="border-white/10 bg-white/[0.025] text-slate-400"
              >
                <Zap className="text-cyan-300" />
                Cost-aware routing
              </Badge>
            </div>

            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-4">
              {agentDefinitions.map((agent) => {
                const Icon = agent.icon;
                const live = liveAgents[agent.id];
                const selectedModel =
                  models[agent.id] === "auto" ||
                  enabledProviders.includes(models[agent.id] as Provider)
                    ? models[agent.id]
                    : "auto";
                return (
                  <Card
                    key={agent.id}
                    className="gap-4 border-white/8 bg-white/[0.025] py-5 shadow-none transition hover:border-white/15 hover:bg-white/[0.04]"
                  >
                    <CardHeader className="gap-4 px-5">
                      <div className="flex items-start justify-between gap-3">
                        <div
                          className={`grid size-10 place-items-center rounded-xl border ${agent.accent}`}
                        >
                          <Icon className="size-5" />
                        </div>
                        <span className="flex items-center gap-2 text-xs text-slate-500">
                          <span
                            className={`size-1.5 rounded-full ${
                              live.status === "working"
                                ? "animate-pulse bg-cyan-300"
                                : live.status === "complete"
                                  ? "bg-emerald-300"
                                  : live.status === "failed"
                                    ? "bg-rose-400"
                                    : "bg-slate-600"
                            }`}
                          />
                          {statusCopy(live.status)}
                        </span>
                      </div>
                      <div>
                        <CardTitle className="text-base text-white">{agent.name}</CardTitle>
                        <CardDescription className="mt-1 text-xs font-medium uppercase tracking-[0.08em] text-slate-500">
                          {agent.role}
                        </CardDescription>
                      </div>
                    </CardHeader>
                    <CardContent className="px-5">
                      <p className="min-h-[60px] text-sm leading-6 text-slate-400">
                        {agent.description}
                      </p>
                      {live.provider || live.note ? (
                        <p className="mt-2 line-clamp-2 text-[11px] leading-5 text-cyan-200/70">
                          {live.provider ? `${providerLabels[live.provider]} · ` : ""}
                          {live.revisions > 0 ? `revision ${live.revisions} · ` : ""}
                          {live.note}
                        </p>
                      ) : null}
                      <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/7 pt-4">
                        <span className="text-xs text-slate-600">Routing preference</span>
                        <Select
                          value={selectedModel}
                          onValueChange={(value) =>
                            setModels((current) => ({
                              ...current,
                              [agent.id]: value as ModelPreference,
                            }))
                          }
                        >
                          <SelectTrigger
                            size="sm"
                            className="w-[156px] border-white/8 bg-black/10 text-xs text-slate-300"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="border-white/10 bg-[#102333] text-slate-100">
                            {(["auto", ...enabledProviders] as ModelPreference[]).map(
                              (provider) => (
                                <SelectItem key={provider} value={provider}>
                                  {providerLabels[provider]}
                                </SelectItem>
                              ),
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </section>

          <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(340px,0.8fr)]">
            <section className="min-w-0">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold tracking-tight text-white">
                    Mission output
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    The latest reviewed package from Chief.
                  </p>
                </div>
                {result ? (
                  <Badge
                    variant="outline"
                    className={
                      result.connected
                        ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
                        : "border-cyan-400/20 bg-cyan-400/10 text-cyan-200"
                    }
                  >
                    {result.connected ? "Live models" : "Routing preview"}
                  </Badge>
                ) : null}
              </div>

              <Card className="min-h-[350px] gap-0 border-white/8 bg-white/[0.025] py-0 shadow-none">
                {result ? (
                  <>
                    <CardHeader className="border-b border-white/8 px-5 py-5 sm:px-6">
                      <div className="flex items-start gap-4">
                        <div className="grid size-10 shrink-0 place-items-center rounded-xl border border-amber-300/20 bg-amber-300/10 text-amber-200">
                          <Crown className="size-5" />
                        </div>
                        <div className="min-w-0">
                          <CardTitle className="text-base leading-6 text-white">
                            {result.summary}
                          </CardTitle>
                          <CardDescription className="mt-1 text-slate-500">
                            Run {result.runId.slice(0, 8)} ·{" "}
                            {new Date(result.createdAt).toLocaleString()}
                            {result.durable === false ? " · saved in this browser only" : ""}
                          </CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-5 p-5 sm:p-6">
                      {result.workflow ? (
                        <div className="grid gap-3 rounded-xl border border-cyan-300/15 bg-cyan-300/[0.04] p-4 sm:grid-cols-4">
                          <div>
                            <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-600">
                              Request
                            </p>
                            <p className="mt-1 text-sm capitalize text-slate-200">
                              {result.workflow.taskClass.replaceAll("_", " ")}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-600">
                              Strategy
                            </p>
                            <p className="mt-1 text-sm capitalize text-slate-200">
                              {result.workflow.strategy.replaceAll("-", " ")}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-600">
                              Agents called
                            </p>
                            <p className="mt-1 text-sm text-slate-200">
                              {result.workflow.activeAgents.length} of 4
                              {result.totals && result.totals.revisions > 0
                                ? ` · ${result.totals.revisions} revision`
                                : ""}
                            </p>
                          </div>
                          <div>
                            <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-slate-600">
                              {result.totals && result.totals.modelCalls > 0
                                ? "Tokens used"
                                : "Token budget"}
                            </p>
                            <p className="mt-1 text-sm text-slate-200">
                              {result.totals && result.totals.modelCalls > 0
                                ? `${(
                                    result.totals.inputTokens + result.totals.outputTokens
                                  ).toLocaleString()} · ${formatCost(liveCost)}`
                                : `≈ ${result.workflow.estimatedTotalTokens.toLocaleString()}`}
                            </p>
                          </div>
                          <p className="text-xs leading-5 text-slate-500 sm:col-span-4">
                            {result.workflow.rationale}
                          </p>
                        </div>
                      ) : null}

                      <div className="rounded-xl border border-white/8 bg-black/10 p-4">
                        <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-200">
                          <Sparkles className="size-4 text-cyan-300" />
                          Prepared deliverable
                        </div>
                        <p className="whitespace-pre-wrap text-sm leading-7 text-slate-400">
                          {result.finalDeliverable}
                        </p>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        {result.agents.map((agentResult) => {
                          const definition = agentDefinitions.find(
                            (agent) => agent.id === agentResult.id,
                          );
                          const route = result.routing?.find(
                            (item) => item.agent === agentResult.id,
                          );
                          return (
                            <div
                              key={agentResult.id}
                              className="rounded-xl border border-white/7 bg-white/[0.02] p-4"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <p className="text-sm font-medium text-slate-200">
                                  {definition?.name}
                                </p>
                                {agentResult.status === "complete" ? (
                                  <CheckCircle2 className="size-4 text-emerald-300" />
                                ) : (
                                  <Clock3 className="size-4 text-slate-600" />
                                )}
                              </div>
                              {route ? (
                                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                                  <Badge
                                    variant="outline"
                                    className="border-cyan-300/15 bg-cyan-300/[0.05] text-[10px] text-cyan-200"
                                  >
                                    {providerLabels[route.provider]}
                                  </Badge>
                                  <span className="text-[10px] uppercase tracking-wide text-slate-600">
                                    {route.costTier} tier ·{" "}
                                    {agentResult.usage
                                      ? `${(
                                          agentResult.usage.inputTokens +
                                          agentResult.usage.outputTokens
                                        ).toLocaleString()} tokens`
                                      : `${route.maxOutputTokens.toLocaleString()} max output`}
                                    {agentResult.costUsd !== null
                                      ? ` · ${formatCost(agentResult.costUsd)}`
                                      : ""}
                                  </span>
                                </div>
                              ) : null}
                              <p className="mt-2 line-clamp-3 text-xs leading-5 text-slate-500">
                                {agentResult.output}
                              </p>
                              {route ? (
                                <p className="mt-2 text-[11px] leading-5 text-slate-600">
                                  {route.reason}
                                </p>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </>
                ) : (
                  <div className="grid min-h-[350px] place-items-center p-8 text-center">
                    <div>
                      <div className="mx-auto grid size-12 place-items-center rounded-2xl border border-white/8 bg-white/[0.03] text-slate-500">
                        <BrainCircuit className="size-6" />
                      </div>
                      <p className="mt-4 font-medium text-slate-300">No mission has run yet</p>
                      <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-slate-600">
                        Start a mission to see Chief&apos;s plan, Builder&apos;s work,
                        Verifier&apos;s checks, and the final approval package.
                      </p>
                    </div>
                  </div>
                )}
              </Card>
            </section>

            <section id="approvals" className="scroll-mt-28">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-semibold tracking-tight text-white">
                    Approval queue
                  </h2>
                  <p className="mt-1 text-sm text-slate-500">
                    Internal work runs immediately; this queue only gates external actions.
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="border-amber-400/20 bg-amber-400/8 text-amber-200"
                >
                  {pendingApprovals} pending
                </Badge>
              </div>

              <Card className="min-h-[350px] gap-3 border-white/8 bg-white/[0.025] p-4 shadow-none">
                {result?.approvals.length ? (
                  result.approvals.map((item) => (
                    <div
                      key={item.id}
                      className="rounded-xl border border-white/8 bg-black/10 p-4"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-slate-200">{item.title}</p>
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${riskClasses(item.risk)}`}
                            >
                              {item.risk}
                            </span>
                          </div>
                          <p className="mt-2 text-xs leading-5 text-slate-500">{item.detail}</p>
                        </div>
                        {item.state !== "pending" ? (
                          <Badge
                            variant="outline"
                            className={
                              item.state === "approved"
                                ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-200"
                                : "border-rose-400/20 bg-rose-400/10 text-rose-200"
                            }
                          >
                            {item.state}
                          </Badge>
                        ) : null}
                      </div>
                      {item.state === "pending" ? (
                        <div className="mt-4 flex items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => void updateApproval(item.id, "approved")}
                            className="bg-emerald-300 text-slate-950 hover:bg-emerald-200"
                          >
                            <Check /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => void updateApproval(item.id, "rejected")}
                            className="border-white/10 bg-transparent text-slate-300 hover:bg-white/[0.05] hover:text-white"
                          >
                            <X /> Reject
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ))
                ) : (
                  <div className="grid flex-1 place-items-center px-5 py-12 text-center">
                    <div>
                      <FileCheck2 className="mx-auto size-8 text-slate-700" />
                      <p className="mt-3 text-sm font-medium text-slate-400">Queue is clear</p>
                      <p className="mt-1 text-xs leading-5 text-slate-600">
                        Prepared emails, deployments, purchases, and other external changes
                        appear here before release.
                      </p>
                    </div>
                  </div>
                )}
              </Card>
            </section>
          </div>

          <section id="connections" className="mt-8 scroll-mt-28">
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-white">Connections</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Add or remove providers and accounts without changing the four agent roles.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConnectionManagerOpen((current) => !current)}
                className="w-fit border-cyan-300/20 bg-cyan-300/[0.04] text-cyan-100 hover:bg-cyan-300/[0.1]"
              >
                <Settings2 />
                {connectionManagerOpen ? "Close manager" : "Manage connections"}
              </Button>
            </div>

            {connectionManagerOpen ? (
              <div className="mb-4 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.035] p-4 sm:p-5">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-cyan-100">Connection manager</p>
                    <p className="mt-1 text-xs leading-5 text-slate-500">
                      Removed providers leave Auto Router&apos;s candidate pool. Add them again
                      whenever you want them available.
                    </p>
                  </div>
                  <Badge
                    variant="outline"
                    className="mt-2 w-fit border-white/10 bg-white/[0.03] text-slate-400 sm:mt-0"
                  >
                    {enabledProviders.length} providers · {enabledConnections.length} connections
                  </Badge>
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div className="rounded-xl border border-white/8 bg-black/10 p-4">
                    <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
                      Model providers
                    </p>
                    <div className="mt-3 space-y-2">
                      {providerCatalog.map((provider) => {
                        const enabled = enabledProviders.includes(provider.id);
                        const configured = status?.providers.find(
                          (entry) => entry.provider === provider.id,
                        );
                        return (
                          <div
                            key={provider.id}
                            className="flex items-center justify-between gap-3 rounded-lg border border-white/7 bg-white/[0.02] px-3 py-2.5"
                          >
                            <div className="min-w-0">
                              <p className="text-sm text-slate-200">
                                {providerLabels[provider.id]}
                                {configured && !configured.configured ? (
                                  <span className="ml-2 text-[10px] uppercase tracking-wide text-amber-300/80">
                                    not configured
                                  </span>
                                ) : null}
                              </p>
                              <p className="mt-0.5 text-[11px] text-slate-600">
                                {provider.detail}
                              </p>
                            </div>
                            <Button
                              type="button"
                              size="sm"
                              variant={enabled ? "outline" : "default"}
                              onClick={() => toggleProvider(provider.id)}
                              className={
                                enabled
                                  ? "shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/[0.05]"
                                  : "shrink-0 bg-cyan-300 text-slate-950 hover:bg-cyan-200"
                              }
                            >
                              {enabled ? <Minus /> : <Plus />}
                              {enabled ? "Remove" : "Add"}
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-xl border border-white/8 bg-black/10 p-4">
                    <p className="text-xs font-medium uppercase tracking-[0.12em] text-slate-500">
                      Accounts and controls
                    </p>
                    <div className="mt-3 space-y-2">
                      {connectionCatalog.map((connection) => {
                        const enabled =
                          connection.required || enabledConnections.includes(connection.id);
                        return (
                          <div
                            key={connection.id}
                            className="flex items-center justify-between gap-3 rounded-lg border border-white/7 bg-white/[0.02] px-3 py-2.5"
                          >
                            <div className="min-w-0">
                              <p className="text-sm text-slate-200">{connection.name}</p>
                              <p className="mt-0.5 text-[11px] text-slate-600">
                                {connection.detail}
                              </p>
                            </div>
                            {connection.required ? (
                              <Badge
                                variant="outline"
                                className="shrink-0 border-amber-300/20 bg-amber-300/[0.05] text-[10px] text-amber-200"
                              >
                                <LockKeyhole /> Required
                              </Badge>
                            ) : (
                              <Button
                                type="button"
                                size="sm"
                                variant={enabled ? "outline" : "default"}
                                onClick={() => toggleConnection(connection.id)}
                                className={
                                  enabled
                                    ? "shrink-0 border-white/10 bg-transparent text-slate-300 hover:bg-white/[0.05]"
                                    : "shrink-0 bg-cyan-300 text-slate-950 hover:bg-cyan-200"
                                }
                              >
                                {enabled ? <Minus /> : <Plus />}
                                {enabled ? "Remove" : "Add"}
                              </Button>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}

            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
              {connectionCatalog.map((connection) => {
                const enabled =
                  connection.required || enabledConnections.includes(connection.id);
                const connectionStatus =
                  connection.id === "approval_policy"
                    ? "Required"
                    : !enabled
                      ? "Not added"
                      : connection.id === "gmail"
                        ? "Connected in ChatGPT"
                        : connection.id === "outlook"
                          ? "Added · bridge needed"
                          : gatewayLive
                            ? "Live routing"
                            : "Routing preview";
                return (
                  <button
                    type="button"
                    key={connection.name}
                    aria-expanded={selectedConnection === connection.name}
                    onClick={() =>
                      setSelectedConnection((current) =>
                        current === connection.name ? null : connection.name,
                      )
                    }
                    className={`group flex w-full items-start gap-4 rounded-2xl border p-5 text-left transition hover:border-cyan-300/25 hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300/50 ${
                      selectedConnection === connection.name
                        ? "border-cyan-300/25 bg-cyan-300/[0.045]"
                        : "border-white/8 bg-white/[0.025]"
                    }`}
                  >
                    <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-slate-300">
                      <connection.icon className="size-5" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-200">{connection.name}</p>
                      <p className="mt-1 text-xs leading-5 text-slate-500">
                        {connection.detail}
                      </p>
                      <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-cyan-300">
                        {selectedConnection === connection.name
                          ? "Hide details"
                          : connectionStatus}
                        <ChevronRight
                          className={`size-3 transition-transform ${
                            selectedConnection === connection.name
                              ? "rotate-90"
                              : "group-hover:translate-x-0.5"
                          }`}
                        />
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {selectedConnection && connectionHelp[selectedConnection] ? (
              <div
                className="mt-4 rounded-2xl border border-cyan-300/15 bg-cyan-300/[0.04] p-5"
                role="status"
              >
                <p className="text-sm font-medium text-cyan-100">
                  {connectionHelp[selectedConnection].title}
                </p>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-400">
                  {connectionHelp[selectedConnection].body}
                </p>
              </div>
            ) : null}
          </section>

          {history.length > 0 ? (
            <section className="mt-8 pb-10">
              <div className="mb-4 flex items-center gap-2">
                <Clock3 className="size-4 text-slate-500" />
                <h2 className="text-sm font-medium text-slate-300">Recent missions</h2>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void loadHistory()}
                  className="ml-auto h-7 text-xs text-slate-500 hover:bg-white/[0.05] hover:text-slate-300"
                >
                  <RefreshCw className="size-3" />
                  Refresh
                </Button>
              </div>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {history.slice(0, 6).map((run) => (
                  <button
                    key={run.runId}
                    onClick={() => {
                      if (run.agents.length > 0) {
                        setResult(run);
                        return;
                      }
                      void fetch(`/api/runs/${run.runId}`)
                        .then((response) =>
                          response.ok ? (response.json() as Promise<MissionResponse>) : null,
                        )
                        .then((payload) => {
                          if (payload) setResult({ ...payload, durable: true });
                        })
                        .catch(() => undefined);
                    }}
                    className="rounded-xl border border-white/7 bg-white/[0.02] p-4 text-left transition hover:border-white/15 hover:bg-white/[0.04]"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <p className="line-clamp-2 text-sm font-medium leading-6 text-slate-300">
                        {run.summary}
                      </p>
                      <SearchCheck className="size-4 shrink-0 text-emerald-300" />
                    </div>
                    <p className="mt-2 text-xs text-slate-600">
                      {new Date(run.createdAt).toLocaleString()}
                    </p>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <div className="h-10" />
          )}
        </section>
      </div>
    </main>
  );
}
