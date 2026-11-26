import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { SideThreadOpenIntent } from "@t3tools/client-runtime/side-thread";
import {
  formatSubagentDisplayTitle,
  resolveSubagentMetadata,
} from "@t3tools/client-runtime/state/subagent-display";
import type { RuntimeSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  buildWorkflowGraph,
  layoutWorkflowGraph,
  WORKFLOW_GRAPH_METRICS,
  type WorkflowEdgeKind,
  type WorkflowGraphNode,
  type WorkflowGraphOrientation,
  type WorkflowNodeStatus,
} from "@t3tools/client-runtime/state/thread-workflow-graph";
import type { ScopedThreadRef, ServerProvider, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ArrowDownIcon,
  ArrowRightIcon,
  BotIcon,
  CornerLeftUpIcon,
  GitForkIcon,
  MessagesSquareIcon,
} from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import type { ButtonHTMLAttributes } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useSideThreadTrigger } from "~/hooks/useSideThreadTrigger";
import type { MessageResolver } from "~/i18n/messages";
import { openSideThread, resolveThreadOpenRoute } from "~/lib/sideChatPane";
import { cn } from "~/lib/utils";
import {
  deriveProviderInstanceEntries,
  hasInstanceBadge,
  type ProviderInstanceEntry,
} from "~/providerInstances";
import { useQuietThreadProjection, useThreadFamilyShells } from "~/state/entities";
import { useEnvironment, useEnvironmentProviders } from "~/state/environments";
import { useLinkedThreadOpener } from "~/state/linkedThreadView";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { buildThreadRouteParams } from "~/threadRoutes";

import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { AgentElapsed } from "./AgentElapsed";
import { ThreadRelationshipIcon, threadRelationshipStatusLabel } from "./ThreadRelationshipIcon";

const OrientationSchema = Schema.Literals(["TB", "LR"]);
const ORIENTATION_KEY = "t3code:thread-graph-orientation:v1";

// Workflow statuses are the runtime subagent statuses, with "stopped" being "interrupted".
const RUNTIME_STATUS: Record<WorkflowNodeStatus, RuntimeSubagentStatus> = {
  running: "running",
  waiting: "waiting",
  completed: "completed",
  failed: "failed",
  stopped: "interrupted",
  idle: "idle",
};

const NODE_TONE: Record<WorkflowNodeStatus, string> = {
  running: "border-info/45",
  waiting: "border-warning/45",
  failed: "border-destructive/45",
  completed: "border-border",
  stopped: "border-border",
  idle: "border-border",
};

const EDGE_TONE: Record<WorkflowNodeStatus, { stroke: string; fill: string }> = {
  running: { stroke: "stroke-info/70", fill: "fill-info/70" },
  waiting: { stroke: "stroke-warning/70", fill: "fill-warning/70" },
  failed: { stroke: "stroke-destructive/60", fill: "fill-destructive/60" },
  completed: { stroke: "stroke-muted-foreground/45", fill: "fill-muted-foreground/45" },
  stopped: { stroke: "stroke-muted-foreground/45", fill: "fill-muted-foreground/45" },
  idle: { stroke: "stroke-muted-foreground/45", fill: "fill-muted-foreground/45" },
};

const EDGE_DASH: Partial<Record<WorkflowEdgeKind, string>> = {
  delegated: "2 4",
  merge_back: "6 4",
};

function nodeTitle(node: WorkflowGraphNode, resolve: MessageResolver): string {
  const title = node.title ?? resolve(msg("Untitled thread"));
  return node.role === "subagent" ? formatSubagentDisplayTitle(title) : title;
}

function roleLabel(node: WorkflowGraphNode, label: string | null, resolve: MessageResolver) {
  switch (node.role) {
    case "root":
      return resolve(msg("Thread", { $context: "thread graph node role" }));
    case "fork":
      return resolve(msg("Fork", { $context: "thread graph node role" }));
    case "subagent":
      return resolve(msg("Subagent", { $context: "thread graph node role" }));
    case "side-chat":
      return resolve(msg("Side chat", { $context: "thread graph node role" }));
    case "external":
      return resolve(msg("on {label}", { label: label ?? "…" }));
  }
}

const ROLE_ICON = {
  root: MessagesSquareIcon,
  fork: GitForkIcon,
  subagent: BotIcon,
  "side-chat": MessagesSquareIcon,
  external: CornerLeftUpIcon,
} as const;

type NodeInteraction = ButtonHTMLAttributes<HTMLButtonElement>;

function GraphNodeCard(props: {
  readonly node: WorkflowGraphNode;
  readonly x: number;
  readonly y: number;
  readonly environmentLabel?: string | null;
  readonly provider: ServerProvider | undefined;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly anyInstanceBadge: boolean;
  /** What a click does; null where the card only shows state. */
  readonly interaction: NodeInteraction | null;
  readonly hint: string | null;
}) {
  const m = useMessages();
  const { node, provider } = props;
  const title = nodeTitle(node, m);
  const role = roleLabel(node, node.external?.label ?? props.environmentLabel ?? null, m);
  const status = RUNTIME_STATUS[node.status];
  const statusLabel = threadRelationshipStatusLabel(status, m);
  const timing = { status, startedAt: node.startedAt, completedAt: node.completedAt };
  const showElapsed = node.startedAt !== null && (node.status === "running" || node.completedAt);
  const model = node.model
    ? resolveSubagentMetadata({ model: node.model, provider }, m).modelLabel
    : null;
  const { nodeWidth, nodeHeight } = WORKFLOW_GRAPH_METRICS;
  const Icon = ROLE_ICON[node.role];
  const interactive = props.interaction !== null;
  const card = (
    <button
      type="button"
      aria-current={node.current ? "true" : undefined}
      aria-label={`${role}: ${title}, ${statusLabel}`}
      aria-disabled={interactive ? undefined : true}
      {...props.interaction}
      style={{ left: props.x, top: props.y, width: nodeWidth, height: nodeHeight }}
      className={cn(
        "absolute flex flex-col justify-between rounded-lg border bg-card px-2.5 py-2 text-left text-card-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        NODE_TONE[node.status],
        interactive ? "cursor-pointer hover:bg-accent/50" : "cursor-default",
        node.current && "bg-accent/40 ring-1 ring-inset ring-foreground/20",
      )}
    >
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium leading-4 text-foreground">
          {title}
        </span>
        <span
          className={cn(
            "shrink-0 text-2xs tabular-nums",
            node.status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {showElapsed ? <AgentElapsed agent={timing} compact /> : statusLabel}
        </span>
      </span>
      <span className="flex min-w-0 items-center gap-2">
        <ThreadRelationshipIcon
          driver={provider?.driver}
          provider={provider}
          providerEntries={props.providerEntries}
          anyInstanceBadge={props.anyInstanceBadge}
          fallbackIcon={Icon}
          status={status}
        />
        <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">{role}</span>
        {model ? (
          <Badge variant="outline" size="sm" className="max-w-[55%] min-w-0 justify-start">
            <span className="truncate">{model}</span>
          </Badge>
        ) : null}
      </span>
    </button>
  );
  return (
    <SharedTooltipTrigger
      render={card}
      side="top"
      label={
        <>
          <span className="block font-medium">{title}</span>
          <span className="block text-muted-foreground">
            {[role, provider?.displayName, model, statusLabel].filter(Boolean).join(" · ")}
          </span>
          {props.hint ? <span className="block text-muted-foreground">{props.hint}</span> : null}
        </>
      }
    />
  );
}

/** A thread on a linked environment. Only a task delegated to one can be read from here. */
function ExternalGraphNode(props: {
  readonly panelRef: ScopedThreadRef;
  readonly node: WorkflowGraphNode;
  readonly x: number;
  readonly y: number;
  readonly providers: ReadonlyArray<ServerProvider> | undefined;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly anyInstanceBadge: boolean;
}) {
  const gt = useGT();
  const m = useMessages();
  const external = props.node.external!;
  const environment = useEnvironment(external.environmentId);
  const label = external.label ?? environment?.label ?? gt("another environment");
  const title = nodeTitle(props.node, m);
  const opener = useLinkedThreadOpener(
    props.panelRef,
    { environmentId: external.environmentId, threadId: external.threadId, label },
    title,
  );
  // A parent that delegated here opens only where this client is connected to it.
  const canOpen = opener !== null && (external.openable || opener.mode === "direct");
  return (
    <GraphNodeCard
      node={props.node}
      x={props.x}
      y={props.y}
      environmentLabel={label}
      provider={props.providers?.find(
        (entry) => entry.instanceId === props.node.providerInstanceId,
      )}
      providerEntries={props.providerEntries}
      anyInstanceBadge={props.anyInstanceBadge}
      interaction={canOpen ? { onClick: () => opener.open("primary") } : null}
      hint={
        canOpen
          ? opener.mode === "linked"
            ? gt("Read the thread on {label}", { label })
            : gt("Open on {label}", { label })
          : gt("Delegated from {label}. Connect to it to open the parent thread.", { label })
      }
    />
  );
}

const ARROW_ROTATION = { down: 0, left: 90, up: 180, right: 270 } as const;

function ArrowHead(props: {
  readonly x: number;
  readonly y: number;
  readonly heading: keyof typeof ARROW_ROTATION;
  readonly className: string;
}) {
  return (
    <polygon
      points="0,0 -4,-7 4,-7"
      transform={`translate(${props.x} ${props.y}) rotate(${ARROW_ROTATION[props.heading]})`}
      className={props.className}
    />
  );
}

function LegendLine(props: { readonly dash: string }) {
  return (
    <svg aria-hidden width="24" height="6" className="shrink-0">
      <line
        x1="1"
        y1="3"
        x2="23"
        y2="3"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={props.dash}
        className="stroke-muted-foreground/60"
      />
    </svg>
  );
}

/**
 * The graph can be wider than a narrow panel, so the open thread is centred in view when the
 * canvas mounts, which it does again for another thread or direction, instead of being left past
 * the edge.
 */
function centerOnCurrentNode(canvas: HTMLElement | null) {
  const viewport = canvas?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
  const card = canvas?.querySelector<HTMLElement>('[aria-current="true"]');
  if (!viewport || !card) return;
  const view = viewport.getBoundingClientRect();
  const at = card.getBoundingClientRect();
  viewport.scrollLeft += at.left + at.width / 2 - (view.left + view.width / 2);
  if (at.top < view.top || at.bottom > view.bottom) {
    viewport.scrollTop += at.top + at.height / 2 - (view.top + view.height / 2);
  }
}

export function ThreadGraphPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const { threadRef } = props;
  const navigate = useNavigate();
  const trigger = useSideThreadTrigger();
  const [orientation, setOrientation] = useLocalStorage(
    ORIENTATION_KEY,
    "TB" satisfies WorkflowGraphOrientation as WorkflowGraphOrientation,
    OrientationSchema,
  );
  const shells = useThreadFamilyShells(threadRef);
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const providers = useEnvironmentProviders().get(threadRef.environmentId);
  const providerEntries = deriveProviderInstanceEntries(providers ?? []);
  const anyInstanceBadge = hasInstanceBadge(providerEntries);

  // A merge-back can be kept on the parent's side only, so the parent's projection is read too and
  // the same merge-back shows whichever end is open.
  const currentThread =
    projection?.thread ?? shells.find((shell) => shell.id === threadRef.threadId) ?? null;
  const parentThreadId =
    currentThread?.forkedFrom?.type === "run"
      ? currentThread.forkedFrom.threadId
      : (currentThread?.lineage.parentThreadId ?? null);
  const parentProjection =
    useQuietThreadProjection(
      parentThreadId === null ? null : scopeThreadRef(threadRef.environmentId, parentThreadId),
    )?.projection ?? null;

  const graph = buildWorkflowGraph({
    threadId: threadRef.threadId,
    threads: shells,
    projection,
    relatedProjections: [parentProjection],
  });
  // A parent the local store lacks may be archived or gone; only its title lookup says which, as in
  // the Related threads list. Until a title is known there is nothing safe to open.
  const unlistedThreadIds = graph.nodes.flatMap((node) =>
    node.threadId !== null &&
    !node.current &&
    node.title === null &&
    !shells.some((shell) => shell.id === node.threadId)
      ? [node.threadId]
      : [],
  );
  const threadTitles = useEnvironmentQuery(
    unlistedThreadIds.length === 0
      ? null
      : orchestrationEnvironment.threadTitles({
          environmentId: threadRef.environmentId,
          input: { threadIds: unlistedThreadIds },
        }),
  );
  const resolvedTitles = threadTitles.data ?? {};
  const resolvedTitle = (node: WorkflowGraphNode) =>
    node.threadId === null ? null : resolvedTitles[node.threadId]?.trim() || null;
  const layout = layoutWorkflowGraph(graph, orientation);
  const positions = new Map(layout.nodes.map((node) => [node.id, node]));
  const parentOf = new Map(
    graph.edges.flatMap((edge) =>
      edge.kind === "merge_back" ? [] : ([[edge.target, edge] as const] as const),
    ),
  );
  const ancestors = new Set<string>();
  for (let id = parentOf.get(threadRef.threadId)?.source; id && !ancestors.has(id);) {
    ancestors.add(id);
    id = parentOf.get(id)?.source;
  }
  const shellById = new Map(shells.map((shell) => [shell.id, shell] as const));
  const running = graph.nodes.filter((node) => node.status === "running").length;
  const edgeKinds = new Set(graph.edges.map((edge) => edge.kind));

  const openThread = (threadId: ThreadId) => {
    const routeRef = resolveThreadOpenRoute(
      scopeThreadRef(threadRef.environmentId, threadId),
      shellById.get(threadId) ?? null,
    );
    if (routeRef.threadId === threadRef.threadId) return;
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(routeRef) });
  };
  const openSideThreadNode = (threadId: ThreadId, intent: SideThreadOpenIntent) =>
    openSideThread({
      threadRef: scopeThreadRef(threadRef.environmentId, threadId),
      panelRef: threadRef,
      intent,
      navigate: (target) =>
        void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(target) }),
    });

  const localNodeProps = (node: WorkflowGraphNode) => {
    const threadId = node.threadId!;
    const lookedUp = unlistedThreadIds.includes(threadId);
    // A thread no store holds and no lookup names is not safe to open.
    const unavailable = lookedUp && resolvedTitle(node) === null;
    const provider = providers?.find((entry) => entry.instanceId === node.providerInstanceId);
    const isAncestor = ancestors.has(node.id);
    const sideLike = !isAncestor && (node.role === "subagent" || node.role === "side-chat");
    const hint = isAncestor
      ? node.role === "subagent"
        ? gt("Open parent agent in this chat")
        : gt("Open parent thread in this chat")
      : node.role === "side-chat"
        ? gt("Open side chat")
        : node.role === "subagent"
          ? gt("Open subagent")
          : gt("Open fork in this chat");
    return {
      provider,
      hint: node.current || unavailable ? null : hint,
      node: lookedUp ? { ...node, title: resolvedTitle(node) } : node,
      interaction:
        node.current || unavailable
          ? null
          : sideLike
            ? trigger((intent) => openSideThreadNode(threadId, intent))
            : { onClick: () => openThread(threadId) },
    };
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3">
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {gt("{count, plural, one {{count} thread} other {{count} threads}}", {
            count: graph.nodes.length,
          })}
          {running > 0 ? ` · ${gt("{count} running", { count: running })}` : ""}
        </span>
        <ToggleGroup
          value={[orientation]}
          onValueChange={(next) => {
            const value = next[0];
            if (value === "TB" || value === "LR") setOrientation(value);
          }}
          aria-label={gt("Graph direction")}
        >
          <SharedTooltipTrigger
            render={
              <Toggle value="TB" size="xs" aria-label={gt("Vertical layout")}>
                <ArrowDownIcon aria-hidden />
              </Toggle>
            }
            label={gt("Vertical layout")}
          />
          <SharedTooltipTrigger
            render={
              <Toggle value="LR" size="xs" aria-label={gt("Horizontal layout")}>
                <ArrowRightIcon aria-hidden />
              </Toggle>
            }
            label={gt("Horizontal layout")}
          />
        </ToggleGroup>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div
          key={`${threadRef.threadId}:${orientation}`}
          ref={centerOnCurrentNode}
          className="relative mx-auto"
          style={{ width: layout.width, height: layout.height }}
          data-graph-orientation={orientation}
        >
          <svg
            aria-hidden
            width={layout.width}
            height={layout.height}
            className="pointer-events-none absolute inset-0"
          >
            {layout.edges.map(({ edge, path, end, heading }) => {
              const tone = EDGE_TONE[edge.status];
              const dash = EDGE_DASH[edge.kind];
              return (
                <g key={edge.id} data-graph-edge={edge.kind}>
                  <path
                    d={path}
                    fill="none"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                    {...(dash === undefined ? {} : { strokeDasharray: dash })}
                    className={tone.stroke}
                  />
                  <ArrowHead x={end.x} y={end.y} heading={heading} className={tone.fill} />
                </g>
              );
            })}
          </svg>
          {graph.nodes.map((node) => {
            const position = positions.get(node.id);
            if (position === undefined) return null;
            if (node.external !== null) {
              return (
                <ExternalGraphNode
                  key={node.id}
                  panelRef={threadRef}
                  node={node}
                  x={position.x}
                  y={position.y}
                  providers={providers}
                  providerEntries={providerEntries}
                  anyInstanceBadge={anyInstanceBadge}
                />
              );
            }
            const { provider, hint, interaction, node: shown } = localNodeProps(node);
            return (
              <GraphNodeCard
                key={node.id}
                node={shown}
                x={position.x}
                y={position.y}
                provider={provider}
                providerEntries={providerEntries}
                anyInstanceBadge={anyInstanceBadge}
                interaction={interaction}
                hint={hint}
              />
            );
          })}
        </div>
        {graph.nodes.length === 1 ? (
          <p className="px-6 pb-6 text-center text-xs text-muted-foreground text-balance">
            <T>Forks, subagents and delegated tasks appear here as this thread branches.</T>
          </p>
        ) : null}
        {edgeKinds.has("delegated") || edgeKinds.has("merge_back") ? (
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1 px-6 pb-4 text-2xs text-muted-foreground">
            {edgeKinds.has("delegated") ? (
              <span className="flex items-center gap-1.5">
                <LegendLine dash={EDGE_DASH.delegated!} />
                <T>Delegated task</T>
              </span>
            ) : null}
            {edgeKinds.has("merge_back") ? (
              <span className="flex items-center gap-1.5">
                <LegendLine dash={EDGE_DASH.merge_back!} />
                <T>Merge back</T>
              </span>
            ) : null}
          </div>
        ) : null}
      </ScrollArea>
    </div>
  );
}
