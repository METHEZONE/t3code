import {
  isOrchestrationV2WorkActive,
  type EnvironmentId,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ThreadShell,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { ThreadStructure } from "./models.ts";
import { deriveThreadRelationshipGraph } from "./threadRelationships.ts";

export type WorkflowNodeStatus =
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped"
  | "idle";
export type WorkflowNodeRole = "root" | "fork" | "subagent" | "side-chat" | "external";
/** `delegated` links a thread to a task that runs on, or came from, a linked environment. */
export type WorkflowEdgeKind = "fork" | "subagent" | "delegated" | "merge_back";

export interface WorkflowGraphNode {
  /** The thread id, or `external:<environmentId>:<threadId>` for a thread this environment lacks. */
  readonly id: string;
  readonly threadId: ThreadId | null;
  /** A thread on a linked environment. Only a delegated child can be opened from here. */
  readonly external: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    /** Absent when only the environment id is known; the client then looks the label up. */
    readonly label: string | null;
    readonly openable: boolean;
  } | null;
  readonly title: string | null;
  readonly role: WorkflowNodeRole;
  readonly status: WorkflowNodeStatus;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly current: boolean;
}

export interface WorkflowGraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly kind: WorkflowEdgeKind;
  readonly status: WorkflowNodeStatus;
}

export interface WorkflowGraph {
  /** Oldest first, so a layout keeps siblings in the order they were created. */
  readonly nodes: ReadonlyArray<WorkflowGraphNode>;
  readonly edges: ReadonlyArray<WorkflowGraphEdge>;
}

type ShellStatusInput = Pick<OrchestrationV2ThreadShell, "status"> &
  Partial<Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "pendingRuntimeRequest">>;

export function workflowStatusFromShell(thread: ShellStatusInput): WorkflowNodeStatus {
  if (thread.activityRunStatus === "waiting" || thread.pendingRuntimeRequest != null) {
    return "waiting";
  }
  switch (thread.activityRunStatus ?? thread.status) {
    case "preparing":
    case "starting":
    case "running":
      return "running";
    case "queued":
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
    case "cancelled":
    case "rolled_back":
      return "stopped";
    default:
      return "idle";
  }
}

function workflowStatusFromSubagent(
  status: ThreadStructure["subagents"][number]["status"],
): WorkflowNodeStatus {
  switch (status) {
    case "pending":
    case "waiting":
      return "waiting";
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
    case "idle":
      return "idle";
  }
}

/** A merge-back waits to be read, is read once consumed, and can fail or be replaced. */
function workflowStatusFromTransfer(
  status: OrchestrationV2ContextTransfer["status"],
): WorkflowNodeStatus {
  switch (status) {
    case "pending":
    case "resolved_native":
    case "resolved_portable":
      return "waiting";
    case "consumed":
      return "completed";
    case "failed":
      return "failed";
    case "superseded":
      return "stopped";
  }
}

const transferMillis = (transfer: OrchestrationV2ContextTransfer) =>
  DateTime.toEpochMillis(transfer.updatedAt);

const iso = (value: DateTime.DateTime | null | undefined): string | null =>
  value == null ? null : DateTime.formatIso(value);

const externalId = (environmentId: EnvironmentId, threadId: ThreadId) =>
  `external:${environmentId}:${threadId}`;

/** Edges that make a node a child; `merge_back` points back up and never places a node. */
const isPlacingEdge = (edge: Pick<WorkflowGraphEdge, "kind">) => edge.kind !== "merge_back";

/**
 * The lineage around `threadId`: its ancestors, forks, subagents and side chats, tasks delegated
 * to or from a linked environment, and the merge-backs between them. Threads the client does not
 * hold, such as idle subagents a shell omits, still appear when the projection names them.
 */
export function buildWorkflowGraph(input: {
  readonly threadId: ThreadId;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: ThreadStructure | null;
  /**
   * Projections of other threads in the lineage, such as the parent. A merge-back is stored with
   * both of its threads, but a bounded projection may hold it on one side only, so the graph reads
   * every projection it is given and the same merge-back shows from either end.
   */
  readonly relatedProjections?: ReadonlyArray<ThreadStructure | null>;
}): WorkflowGraph {
  const { threadId, projection } = input;
  const relationships = deriveThreadRelationshipGraph({ threads: input.threads, projection });
  const lineageEdges = relationships.edges.filter((edge) => edge.kind !== "transfer");

  const reachable = new Set<ThreadId>([threadId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const edge of lineageEdges) {
      const hasSource = reachable.has(edge.sourceThreadId);
      if (hasSource === reachable.has(edge.targetThreadId)) continue;
      reachable.add(hasSource ? edge.targetThreadId : edge.sourceThreadId);
      grew = true;
    }
  }

  const subagentByChild = new Map(
    (projection?.subagents ?? []).flatMap((subagent) =>
      subagent.childThreadId === null ? [] : [[subagent.childThreadId, subagent] as const],
    ),
  );
  const shellOf = (id: ThreadId) => relationships.nodes.get(id)?.thread ?? null;
  /**
   * Follows the Related threads list: a live shell wins, and a subagent still working in the
   * parent's projection stays running while its own shell has not caught up (idle, or settled from
   * an earlier run).
   */
  const resolveState = (
    id: ThreadId,
  ): { readonly status: WorkflowNodeStatus; readonly fromSubagent: boolean } => {
    const shell = shellOf(id);
    const subagent = subagentByChild.get(id);
    if (shell && subagent) {
      const live = shell.activityRunStatus != null || shell.pendingRuntimeRequest != null;
      const settled = shell.latestRunId != null && !isOrchestrationV2WorkActive(subagent.status);
      if (live || settled) return { status: workflowStatusFromShell(shell), fromSubagent: false };
      return { status: workflowStatusFromSubagent(subagent.status), fromSubagent: true };
    }
    if (shell) return { status: workflowStatusFromShell(shell), fromSubagent: false };
    return subagent
      ? { status: workflowStatusFromSubagent(subagent.status), fromSubagent: true }
      : { status: "idle", fromSubagent: false };
  };
  const statusOf = (id: ThreadId): WorkflowNodeStatus => resolveState(id).status;

  const edges = new Map<string, WorkflowGraphEdge>();
  const incomingKind = new Map<string, WorkflowEdgeKind>();
  const addEdge = (edge: Omit<WorkflowGraphEdge, "id">) => {
    const id = `${edge.kind}:${edge.source}>${edge.target}`;
    if (edges.has(id)) return;
    edges.set(id, { id, ...edge });
    if (isPlacingEdge(edge) && !incomingKind.has(edge.target)) {
      incomingKind.set(edge.target, edge.kind);
    }
  };
  for (const edge of lineageEdges) {
    if (!reachable.has(edge.sourceThreadId) || !reachable.has(edge.targetThreadId)) continue;
    addEdge({
      source: edge.sourceThreadId,
      target: edge.targetThreadId,
      kind: edge.kind === "subagent" ? "subagent" : "fork",
      status: statusOf(edge.targetThreadId),
    });
  }
  // One edge per source and target; the newest transfer says where the merge-back stands.
  const mergeBacks = new Map<string, OrchestrationV2ContextTransfer>();
  for (const source of [projection, ...(input.relatedProjections ?? [])]) {
    for (const transfer of source?.contextTransfers ?? []) {
      if (
        transfer.type !== "merge_back" ||
        transfer.sourceThreadId === transfer.targetThreadId ||
        !reachable.has(transfer.sourceThreadId) ||
        !reachable.has(transfer.targetThreadId)
      ) {
        continue;
      }
      const key = `${transfer.sourceThreadId}>${transfer.targetThreadId}`;
      const known = mergeBacks.get(key);
      if (known === undefined || transferMillis(transfer) >= transferMillis(known)) {
        mergeBacks.set(key, transfer);
      }
    }
  }
  for (const transfer of mergeBacks.values()) {
    addEdge({
      source: transfer.sourceThreadId,
      target: transfer.targetThreadId,
      kind: "merge_back",
      status: workflowStatusFromTransfer(transfer.status),
    });
  }

  const externals: WorkflowGraphNode[] = [];
  const addExternal = (
    external: NonNullable<WorkflowGraphNode["external"]>,
    node: Pick<
      WorkflowGraphNode,
      "title" | "status" | "providerInstanceId" | "startedAt" | "completedAt"
    >,
    direction: "from" | "to",
  ) => {
    const id = externalId(external.environmentId, external.threadId);
    if (!externals.some((existing) => existing.id === id)) {
      externals.push({
        ...node,
        id,
        threadId: null,
        external,
        role: "external",
        model: null,
        current: false,
      });
    }
    addEdge({
      source: direction === "from" ? id : threadId,
      target: direction === "from" ? threadId : id,
      kind: "delegated",
      status: node.status,
    });
  };
  const delegatedFrom = (shellOf(threadId) ?? projection?.thread)?.delegatedFrom;
  if (delegatedFrom !== undefined) {
    addExternal(
      {
        environmentId: delegatedFrom.environmentId,
        threadId: delegatedFrom.threadId,
        label: null,
        openable: false,
      },
      {
        title: delegatedFrom.title,
        status: "idle",
        providerInstanceId: null,
        startedAt: null,
        completedAt: null,
      },
      "from",
    );
  }
  for (const subagent of projection?.subagents ?? []) {
    const remote = subagent.remoteChild;
    if (remote === undefined) continue;
    addExternal(
      {
        environmentId: remote.environmentId,
        threadId: remote.threadId,
        label: remote.label,
        openable: true,
      },
      {
        title: remote.title ?? subagent.title,
        status: workflowStatusFromSubagent(subagent.status),
        providerInstanceId: subagent.providerInstanceId,
        startedAt: iso(subagent.startedAt),
        completedAt: iso(subagent.completedAt),
      },
      "to",
    );
  }

  const locals = [...reachable].map((id) => {
    const shell = shellOf(id);
    // The open thread may be absent from the shells but is always in its projection.
    const thread = shell ?? (id === threadId ? projection?.thread : undefined);
    const subagent = subagentByChild.get(id);
    const { status, fromSubagent } = resolveState(id);
    const kind = incomingKind.get(id);
    // A run that is going or waiting shows its own clock, never the previous run's start and end.
    const active = status === "running" || status === "waiting";
    const startedAt =
      shell && !fromSubagent
        ? active
          ? (iso(shell.activityRunStartedAt) ??
            (shell.latestRunCompletedAt == null ? iso(shell.latestRunStartedAt) : null))
          : iso(shell.latestRunStartedAt)
        : iso(subagent?.startedAt);
    const completedAt =
      shell && !fromSubagent
        ? active
          ? null
          : iso(shell.latestRunCompletedAt)
        : active
          ? null
          : iso(subagent?.completedAt);
    const node: WorkflowGraphNode = {
      id,
      threadId: id,
      external: null,
      title: thread?.title.trim() || subagent?.title || null,
      role:
        thread?.lineage.sideChat === true
          ? "side-chat"
          : kind === undefined
            ? "root"
            : kind === "fork"
              ? "fork"
              : "subagent",
      status,
      providerInstanceId: thread?.providerInstanceId ?? subagent?.providerInstanceId ?? null,
      model:
        thread?.modelSelection.model ?? subagent?.modelSelection?.model ?? subagent?.model ?? null,
      startedAt,
      completedAt,
      current: id === threadId,
    };
    const createdAt = thread
      ? DateTime.toEpochMillis(thread.createdAt)
      : subagent
        ? DateTime.toEpochMillis(subagent.startedAt ?? subagent.updatedAt)
        : Number.POSITIVE_INFINITY;
    return { node, createdAt };
  });
  locals.sort(
    (left, right) => left.createdAt - right.createdAt || (left.node.id < right.node.id ? -1 : 1),
  );

  return { nodes: [...locals.map(({ node }) => node), ...externals], edges: [...edges.values()] };
}

export type WorkflowGraphOrientation = "TB" | "LR";
export type WorkflowEdgeHeading = "up" | "down" | "left" | "right";

export interface WorkflowGraphMetrics {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  /** Space between a node and its children, along the flow direction. */
  readonly layerGap: number;
  /** Space between siblings, across the flow direction. */
  readonly siblingGap: number;
  readonly padding: number;
  /** How far a merge-back edge runs beside the edge it returns along. */
  readonly returnOffset: number;
}

export const WORKFLOW_GRAPH_METRICS: WorkflowGraphMetrics = {
  nodeWidth: 216,
  nodeHeight: 68,
  layerGap: 44,
  siblingGap: 16,
  padding: 24,
  returnOffset: 14,
};

export interface WorkflowGraphLayout {
  readonly width: number;
  readonly height: number;
  readonly nodes: ReadonlyArray<{ readonly id: string; readonly x: number; readonly y: number }>;
  /** `end` is where the edge meets its target, for an arrowhead. */
  readonly edges: ReadonlyArray<{
    readonly edge: WorkflowGraphEdge;
    readonly path: string;
    readonly end: { readonly x: number; readonly y: number };
    readonly heading: WorkflowEdgeHeading;
  }>;
}

/**
 * Lays the graph out as a tree: a node's depth is its layer, leaves take consecutive slots across
 * the flow, and a parent centres over its children, so no two nodes share a layer position.
 * ponytail: a node with several parents is placed under the first; its other edges just curve in.
 * Lineage gives one parent per thread, so this only matters if that stops holding.
 */
export function layoutWorkflowGraph(
  graph: WorkflowGraph,
  orientation: WorkflowGraphOrientation,
  metrics: WorkflowGraphMetrics = WORKFLOW_GRAPH_METRICS,
): WorkflowGraphLayout {
  const order = new Map(graph.nodes.map((node, index) => [node.id, index] as const));
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();
  for (const edge of graph.edges) {
    if (!isPlacingEdge(edge) || !order.has(edge.source) || !order.has(edge.target)) continue;
    if (hasParent.has(edge.target) || edge.source === edge.target) continue;
    hasParent.add(edge.target);
    const kids = children.get(edge.source);
    if (kids === undefined) children.set(edge.source, [edge.target]);
    else kids.push(edge.target);
  }

  const placed = new Map<string, { layer: number; slot: number }>();
  let nextSlot = 0;
  // Walks with an explicit stack, so a lineage thousands of threads deep cannot overflow the call
  // stack. A parent's slot is known once its children are, so it settles when its frame pops.
  interface Frame {
    readonly id: string;
    readonly layer: number;
    readonly kids: string[];
    next: number;
    first: number;
    last: number;
  }
  const open = (id: string, layer: number): Frame => {
    // A guard for a cycle that lineage should never produce.
    placed.set(id, { layer, slot: Number.NaN });
    const kids = [...(children.get(id) ?? [])].sort(
      (left, right) => order.get(left)! - order.get(right)!,
    );
    return { id, layer, kids, next: 0, first: Number.NaN, last: Number.NaN };
  };
  const place = (rootId: string) => {
    const stack = [open(rootId, 0)];
    for (let frame = stack.at(-1); frame !== undefined; frame = stack.at(-1)) {
      const kid = frame.kids[frame.next++];
      if (kid !== undefined) {
        if (!placed.has(kid)) stack.push(open(kid, frame.layer + 1));
        continue;
      }
      const slot = Number.isNaN(frame.first) ? nextSlot++ : (frame.first + frame.last) / 2;
      placed.set(frame.id, { layer: frame.layer, slot });
      stack.pop();
      const parent = stack.at(-1);
      if (parent !== undefined) {
        if (Number.isNaN(parent.first)) parent.first = slot;
        parent.last = slot;
      }
    }
  };
  for (const node of graph.nodes) {
    if (!hasParent.has(node.id) && !placed.has(node.id)) place(node.id);
  }
  // Nodes left over by a cycle still get a slot, so none is dropped.
  for (const node of graph.nodes) {
    if (!placed.has(node.id)) place(node.id);
  }

  const { nodeWidth, nodeHeight, layerGap, siblingGap, padding, returnOffset } = metrics;
  const vertical = orientation === "TB";
  const layerStride = (vertical ? nodeHeight : nodeWidth) + layerGap;
  const slotStride = (vertical ? nodeWidth : nodeHeight) + siblingGap;
  const originLayer = padding;
  const originSlot = padding;

  const positions = new Map<string, { x: number; y: number }>();
  let maxLayer = 0;
  let maxSlot = 0;
  for (const [id, { layer, slot }] of placed) {
    const along = originLayer + layer * layerStride;
    const across = originSlot + slot * slotStride;
    positions.set(id, vertical ? { x: across, y: along } : { x: along, y: across });
    maxLayer = Math.max(maxLayer, layer);
    maxSlot = Math.max(maxSlot, slot);
  }
  const width = vertical
    ? originSlot + maxSlot * slotStride + nodeWidth + padding
    : originLayer + maxLayer * layerStride + nodeWidth + padding;
  const height = vertical
    ? originLayer + maxLayer * layerStride + nodeHeight + padding
    : originSlot + maxSlot * slotStride + nodeHeight + padding;

  const edges = graph.edges.flatMap((edge) => {
    const from = positions.get(edge.source);
    const to = positions.get(edge.target);
    if (from === undefined || to === undefined) return [];
    // An edge that runs against the flow, such as a merge-back up to its parent or a link that
    // closes a cycle, leaves the node's near side and meets the target's far side. It runs beside
    // the edge it retraces, offset so the two never lie on top of each other.
    const fromLayer = placed.get(edge.source)?.layer ?? 0;
    const toLayer = placed.get(edge.target)?.layer ?? 0;
    const back = toLayer < fromLayer;
    const shift = back || edge.kind === "merge_back" ? returnOffset : 0;
    const flowEnd = vertical
      ? { x: nodeWidth / 2 + shift, y: back ? nodeHeight : 0 }
      : { x: back ? nodeWidth : 0, y: nodeHeight / 2 + shift };
    const flowStart = vertical
      ? { x: nodeWidth / 2 + shift, y: back ? 0 : nodeHeight }
      : { x: back ? 0 : nodeWidth, y: nodeHeight / 2 + shift };
    const start: Point = [from.x + flowStart.x, from.y + flowStart.y];
    const end: Point = [to.x + flowEnd.x, to.y + flowEnd.y];
    const controlA: Point = vertical
      ? [start[0], (start[1] + end[1]) / 2]
      : [(start[0] + end[0]) / 2, start[1]];
    const controlB: Point = vertical
      ? [end[0], (start[1] + end[1]) / 2]
      : [(start[0] + end[0]) / 2, end[1]];
    // The way the edge arrives, so an arrowhead can point along it.
    const heading: WorkflowEdgeHeading = vertical
      ? back
        ? "up"
        : "down"
      : back
        ? "left"
        : "right";
    return [
      {
        edge,
        path: curve(start, controlA, controlB, end),
        end: { x: end[0], y: end[1] },
        heading,
      },
    ];
  });

  return {
    width,
    height,
    nodes: [...positions].map(([id, { x, y }]) => ({ id, x, y })),
    edges,
  };
}

type Point = readonly [number, number];

function curve(start: Point, controlA: Point, controlB: Point, end: Point): string {
  const point = ([x, y]: Point) => `${Math.round(x * 10) / 10} ${Math.round(y * 10) / 10}`;
  return `M ${point(start)} C ${point(controlA)}, ${point(controlB)}, ${point(end)}`;
}
