import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  buildWorkflowGraph,
  layoutWorkflowGraph,
  WORKFLOW_GRAPH_METRICS,
  workflowStatusFromShell,
} from "./threadWorkflowGraph.ts";

const id = ThreadId.make;
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 26, 9, minute));

function shell(
  threadId: string,
  overrides: Record<string, unknown> = {},
  lineage: Record<string, unknown> = {},
) {
  return {
    id: id(threadId),
    title: threadId,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    status: "completed",
    pendingRuntimeRequest: null,
    createdAt: at(0),
    latestRunStartedAt: at(1),
    latestRunCompletedAt: at(4),
    delegatedFrom: undefined,
    forkedFrom: null,
    lineage: {
      rootThreadId: id("root"),
      parentThreadId: null,
      relationshipToParent: null,
      ...lineage,
    },
    ...overrides,
  } as never;
}

const child = (threadId: string, parent: string, kind: "fork" | "subagent", minute: number) =>
  shell(
    threadId,
    { createdAt: at(minute) },
    { parentThreadId: id(parent), relationshipToParent: kind },
  );

describe("workflowStatusFromShell", () => {
  it.each([
    [{ status: "idle" }, "idle"],
    [{ status: "completed" }, "completed"],
    [{ status: "failed" }, "failed"],
    [{ status: "cancelled" }, "stopped"],
    [{ status: "completed", activityRunStatus: "running" }, "running"],
    [{ status: "running", activityRunStatus: "waiting" }, "waiting"],
    [{ status: "queued" }, "waiting"],
    [{ status: "running", pendingRuntimeRequest: { kind: "approval" } }, "waiting"],
  ])("maps %j to %s", (input, expected) => {
    expect(workflowStatusFromShell(input as never)).toBe(expected);
  });
});

describe("buildWorkflowGraph", () => {
  it("shows a lone thread as a single root node", () => {
    const graph = buildWorkflowGraph({
      threadId: id("root"),
      threads: [shell("root")],
      projection: null,
    });
    expect(graph.edges).toEqual([]);
    expect(graph.nodes).toEqual([
      expect.objectContaining({
        id: "root",
        role: "root",
        current: true,
        status: "completed",
        model: "gpt-5",
        startedAt: "2026-11-26T09:01:00.000Z",
        completedAt: "2026-11-26T09:04:00.000Z",
      }),
    ]);
  });

  it("walks ancestors and descendants of the open thread, and ignores unrelated families", () => {
    const graph = buildWorkflowGraph({
      threadId: id("fork-a"),
      threads: [
        shell("root"),
        child("fork-a", "root", "fork", 1),
        child("sub-1", "fork-a", "subagent", 2),
        child("sub-2", "sub-1", "subagent", 3),
        child("fork-b", "root", "fork", 4),
        shell("other", {}, { rootThreadId: id("other") }),
      ],
      projection: null,
    });
    expect(graph.nodes.map((node) => [node.id, node.role])).toEqual([
      ["root", "root"],
      ["fork-a", "fork"],
      ["sub-1", "subagent"],
      ["sub-2", "subagent"],
      ["fork-b", "fork"],
    ]);
    expect(graph.edges.map((edge) => [edge.kind, edge.source, edge.target])).toEqual([
      ["fork", "root", "fork-a"],
      ["subagent", "fork-a", "sub-1"],
      ["subagent", "sub-1", "sub-2"],
      ["fork", "root", "fork-b"],
    ]);
    expect(graph.nodes.filter((node) => node.current).map((node) => node.id)).toEqual(["fork-a"]);
  });

  it("marks a side chat and carries live status onto its edge", () => {
    const graph = buildWorkflowGraph({
      threadId: id("root"),
      threads: [
        shell("root"),
        shell(
          "chat",
          { status: "completed", activityRunStatus: "running", createdAt: at(1) },
          { parentThreadId: id("root"), relationshipToParent: "fork", sideChat: true },
        ),
      ],
      projection: null,
    });
    expect(graph.nodes.find((node) => node.id === "chat")).toMatchObject({
      role: "side-chat",
      status: "running",
      completedAt: null,
    });
    expect(graph.edges[0]).toMatchObject({ target: "chat", status: "running" });
  });

  it("adds merge-back arcs from the projection and keeps them out of the tree", () => {
    const projection = {
      thread: shell("root"),
      subagents: [],
      contextTransfers: [
        { type: "merge_back", sourceThreadId: id("fork-a"), targetThreadId: id("root") },
        { type: "fork", sourceThreadId: id("root"), targetThreadId: id("fork-a") },
      ],
    } as never;
    const graph = buildWorkflowGraph({
      threadId: id("root"),
      threads: [shell("root"), child("fork-a", "root", "fork", 1)],
      projection,
    });
    expect(graph.edges.map((edge) => edge.kind)).toEqual(["fork", "merge_back"]);
    expect(graph.nodes.find((node) => node.id === "fork-a")?.role).toBe("fork");
  });

  it("adds tasks delegated to, and from, a linked environment as external nodes", () => {
    const remote = EnvironmentId.make("env-remote");
    const projection = {
      thread: shell("root", {
        delegatedFrom: { environmentId: remote, threadId: id("up"), title: "Planner" },
      }),
      subagents: [
        {
          childThreadId: null,
          status: "running",
          title: "Remote task",
          providerInstanceId: "codex",
          startedAt: at(2),
          completedAt: null,
          updatedAt: at(2),
          remoteChild: {
            environmentId: remote,
            threadId: id("down"),
            label: "Studio",
            title: "Build it",
          },
        },
      ],
      contextTransfers: [],
    } as never;
    const graph = buildWorkflowGraph({
      threadId: id("root"),
      threads: [
        shell("root", {
          delegatedFrom: { environmentId: remote, threadId: id("up"), title: "Planner" },
        }),
      ],
      projection,
    });
    expect(graph.nodes.map((node) => [node.id, node.role, node.title, node.status])).toEqual([
      // Delegated here from `up`, so it is that thread's subagent.
      ["root", "subagent", "root", "completed"],
      [`external:${remote}:up`, "external", "Planner", "idle"],
      [`external:${remote}:down`, "external", "Build it", "running"],
    ]);
    expect(graph.edges.map((edge) => [edge.kind, edge.source, edge.target])).toEqual([
      ["delegated", `external:${remote}:up`, "root"],
      ["delegated", "root", `external:${remote}:down`],
    ]);
    expect(graph.nodes[1]?.external?.openable).toBe(false);
    expect(graph.nodes[2]?.external).toMatchObject({ label: "Studio", openable: true });
  });

  it("names a child the shells omit when the projection reports it", () => {
    const projection = {
      thread: shell("root"),
      subagents: [
        {
          childThreadId: id("idle-child"),
          status: "idle",
          title: "Reviewer",
          providerInstanceId: "claude",
          model: "opus",
          startedAt: null,
          completedAt: null,
          updatedAt: at(5),
        },
      ],
      contextTransfers: [],
    } as never;
    const graph = buildWorkflowGraph({
      threadId: id("root"),
      threads: [shell("root")],
      projection,
    });
    expect(graph.nodes.find((node) => node.id === "idle-child")).toMatchObject({
      title: "Reviewer",
      role: "subagent",
      status: "idle",
      model: "opus",
    });
  });

  it("falls back to the projection's thread when the shells lack the open thread", () => {
    const graph = buildWorkflowGraph({
      threadId: id("root"),
      threads: [],
      projection: { thread: shell("root"), subagents: [], contextTransfers: [] } as never,
    });
    expect(graph.nodes).toEqual([expect.objectContaining({ id: "root", title: "root" })]);
  });
});

describe("buildWorkflowGraph regressions", () => {
  const subagentOf = (
    childThreadId: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    childThreadId: id(childThreadId),
    status,
    title: childThreadId,
    providerInstanceId: "codex",
    startedAt: at(6),
    completedAt: null,
    updatedAt: at(7),
    ...extra,
  });

  it("keeps a subagent running while its own shell is still idle", () => {
    const idleShell = shell(
      "kid",
      {
        createdAt: at(2),
        status: "idle",
        latestRunId: null,
        latestRunStartedAt: null,
        latestRunCompletedAt: null,
      },
      { parentThreadId: id("root"), relationshipToParent: "subagent" },
    );
    const graph = buildWorkflowGraph({
      threadId: id("root"),
      threads: [shell("root"), idleShell],
      projection: {
        thread: shell("root"),
        subagents: [subagentOf("kid", "running")],
        contextTransfers: [],
      } as never,
    });
    expect(graph.nodes.find((node) => node.id === "kid")).toMatchObject({
      status: "running",
      startedAt: "2026-11-26T09:06:00.000Z",
      completedAt: null,
    });
    expect(graph.edges[0]).toMatchObject({ target: "kid", status: "running" });
  });

  it("lets a settled shell and a live shell outrank the subagent row", () => {
    const build = (shellOverrides: Record<string, unknown>) =>
      buildWorkflowGraph({
        threadId: id("root"),
        threads: [
          shell("root"),
          shell(
            "kid",
            { createdAt: at(2), latestRunId: "run-1", ...shellOverrides },
            { parentThreadId: id("root"), relationshipToParent: "subagent" },
          ),
        ],
        projection: {
          thread: shell("root"),
          subagents: [subagentOf("kid", "completed")],
          contextTransfers: [],
        } as never,
      }).nodes.find((node) => node.id === "kid")?.status;
    expect(build({ status: "failed" })).toBe("failed");
    expect(build({ status: "completed", activityRunStatus: "running" })).toBe("running");
  });

  it("shows only the current run's clock while waiting on an approval", () => {
    const graph = buildWorkflowGraph({
      threadId: id("root"),
      threads: [
        shell("root", {
          status: "completed",
          activityRunStatus: "waiting",
          pendingRuntimeRequest: { kind: "approval" },
          latestRunStartedAt: at(1),
          latestRunCompletedAt: at(4),
          activityRunStartedAt: at(8),
        }),
      ],
      projection: null,
    });
    expect(graph.nodes[0]).toMatchObject({
      status: "waiting",
      startedAt: "2026-11-26T09:08:00.000Z",
      completedAt: null,
    });
    const stale = buildWorkflowGraph({
      threadId: id("root"),
      threads: [
        shell("root", {
          status: "completed",
          activityRunStatus: "waiting",
          activityRunStartedAt: null,
        }),
      ],
      projection: null,
    });
    expect(stale.nodes[0]).toMatchObject({ status: "waiting", startedAt: null, completedAt: null });
  });

  describe("merge-back", () => {
    const transfer = (status: string, updatedAt = 5) => ({
      id: `transfer-${status}`,
      type: "merge_back",
      sourceThreadId: id("fork"),
      targetThreadId: id("root"),
      status,
      updatedAt: at(updatedAt),
    });
    const family = [shell("root"), child("fork", "root", "fork", 1)];
    const projectionOf = (threadId: string, transfers: unknown[]) =>
      ({ thread: shell(threadId), subagents: [], contextTransfers: transfers }) as never;

    it.each([
      ["pending", "waiting"],
      ["resolved_native", "waiting"],
      ["consumed", "completed"],
      ["failed", "failed"],
      ["superseded", "stopped"],
    ])("reports a %s transfer as %s, not as the fork's own status", (status, expected) => {
      const graph = buildWorkflowGraph({
        threadId: id("root"),
        threads: family,
        projection: projectionOf("root", [transfer(status)]),
      });
      expect(graph.edges.find((edge) => edge.kind === "merge_back")?.status).toBe(expected);
    });

    it("draws the same merge-back from the parent, the fork and a sibling", () => {
      const transfers = [transfer("failed")];
      const sibling = child("sibling", "root", "fork", 2);
      const threads = [...family, sibling];
      const mergeBacks = (threadId: string, projection: unknown, related: unknown[] = []) =>
        buildWorkflowGraph({
          threadId: id(threadId),
          threads,
          projection: projection as never,
          relatedProjections: related as never,
        }).edges.filter((edge) => edge.kind === "merge_back");
      const fromParent = mergeBacks("root", projectionOf("root", transfers));
      const fromFork = mergeBacks("fork", projectionOf("fork", transfers));
      // The fork's own projection holds nothing, so only the parent's side names the transfer.
      const fromSibling = mergeBacks("sibling", projectionOf("sibling", []), [
        projectionOf("root", transfers),
      ]);
      expect(fromParent).toHaveLength(1);
      expect(fromFork).toEqual(fromParent);
      expect(fromSibling).toEqual(fromParent);
    });

    it("lets the newest transfer for a pair decide", () => {
      const graph = buildWorkflowGraph({
        threadId: id("root"),
        threads: family,
        projection: projectionOf("root", [transfer("failed", 5), transfer("consumed", 9)]),
      });
      const edges = graph.edges.filter((edge) => edge.kind === "merge_back");
      expect(edges.map((edge) => edge.status)).toEqual(["completed"]);
    });
  });

  it("keeps a parent the stores lack in the graph without a title", () => {
    const graph = buildWorkflowGraph({
      threadId: id("fork"),
      threads: [child("fork", "gone", "fork", 1)],
      projection: null,
    });
    expect(graph.nodes.find((node) => node.id === "gone")).toMatchObject({
      title: null,
      role: "root",
    });
  });
});

describe("layoutWorkflowGraph", () => {
  const { nodeWidth, nodeHeight, layerGap, siblingGap, padding } = WORKFLOW_GRAPH_METRICS;
  const tree = buildWorkflowGraph({
    threadId: id("root"),
    threads: [
      shell("root"),
      child("a", "root", "fork", 1),
      child("b", "root", "subagent", 2),
      child("a1", "a", "subagent", 3),
    ],
    projection: null,
  });
  const byId = (layout: ReturnType<typeof layoutWorkflowGraph>) =>
    new Map(layout.nodes.map((node) => [node.id, node]));

  it("flows downward and centres a parent over its children when vertical", () => {
    const layout = layoutWorkflowGraph(tree, "TB");
    const nodes = byId(layout);
    expect(nodes.get("root")?.y).toBe(padding);
    expect(nodes.get("a")?.y).toBe(padding + nodeHeight + layerGap);
    expect(nodes.get("a1")?.y).toBe(padding + 2 * (nodeHeight + layerGap));
    // Leaves a1 and b take slots 0 and 1; a centres over a1, root over a and b.
    expect(nodes.get("a1")?.x).toBe(padding);
    expect(nodes.get("b")?.x).toBe(padding + nodeWidth + siblingGap);
    expect(nodes.get("a")?.x).toBe(nodes.get("a1")?.x);
    expect(nodes.get("root")?.x).toBe(((nodes.get("a")?.x ?? 0) + (nodes.get("b")?.x ?? 0)) / 2);
    expect(layout.width).toBe(padding * 2 + nodeWidth * 2 + siblingGap);
    expect(layout.height).toBe(padding * 2 + nodeHeight * 3 + layerGap * 2);
  });

  it("transposes the same tree when horizontal", () => {
    const layout = layoutWorkflowGraph(tree, "LR");
    const nodes = byId(layout);
    expect(nodes.get("root")?.x).toBe(padding);
    expect(nodes.get("a1")?.x).toBe(padding + 2 * (nodeWidth + layerGap));
    expect(nodes.get("b")?.y).toBe(padding + nodeHeight + siblingGap);
    expect(layout.width).toBe(padding * 2 + nodeWidth * 3 + layerGap * 2);
    expect(layout.height).toBe(padding * 2 + nodeHeight * 2 + siblingGap);
  });

  it.each(["TB", "LR"] as const)("never overlaps two nodes when %s", (orientation) => {
    const wide = buildWorkflowGraph({
      threadId: id("root"),
      threads: [
        shell("root"),
        ...Array.from({ length: 5 }, (_, index) =>
          child(`c${index}`, "root", "subagent", index + 1),
        ),
        child("deep", "c2", "fork", 9),
        child("deeper", "deep", "subagent", 10),
      ],
      projection: null,
    });
    const { nodes, width, height } = layoutWorkflowGraph(wide, orientation);
    for (const [index, left] of nodes.entries()) {
      expect(left.x + nodeWidth).toBeLessThanOrEqual(width);
      expect(left.y + nodeHeight).toBeLessThanOrEqual(height);
      for (const right of nodes.slice(index + 1)) {
        const apart =
          left.x + nodeWidth <= right.x ||
          right.x + nodeWidth <= left.x ||
          left.y + nodeHeight <= right.y ||
          right.y + nodeHeight <= left.y;
        expect(apart).toBe(true);
      }
    }
  });

  it("runs a merge-back beside the fork edge it retraces, heading back up the tree", () => {
    const graph = buildWorkflowGraph({
      threadId: id("root"),
      threads: [shell("root"), child("a", "root", "fork", 1)],
      projection: {
        thread: shell("root"),
        subagents: [],
        contextTransfers: [
          { type: "merge_back", sourceThreadId: id("a"), targetThreadId: id("root") },
        ],
      } as never,
    });
    const { returnOffset } = WORKFLOW_GRAPH_METRICS;
    for (const orientation of ["TB", "LR"] as const) {
      const layout = layoutWorkflowGraph(graph, orientation);
      const [forward, back] = layout.edges;
      expect(layout.edges.map(({ edge }) => edge.kind)).toEqual(["fork", "merge_back"]);
      for (const { path } of layout.edges) expect(path).toMatch(/^M [\d. ]+ C /);
      expect(forward?.heading).toBe(orientation === "TB" ? "down" : "right");
      expect(back?.heading).toBe(orientation === "TB" ? "up" : "left");
      // The return edge ends on the parent's facing side, shifted across so the two are distinct.
      const root = layout.nodes.find((node) => node.id === "root")!;
      if (orientation === "TB") {
        expect(back?.end).toEqual({
          x: root.x + WORKFLOW_GRAPH_METRICS.nodeWidth / 2 + returnOffset,
          y: root.y + WORKFLOW_GRAPH_METRICS.nodeHeight,
        });
      } else {
        expect(back?.end).toEqual({
          x: root.x + WORKFLOW_GRAPH_METRICS.nodeWidth,
          y: root.y + WORKFLOW_GRAPH_METRICS.nodeHeight / 2 + returnOffset,
        });
      }
      expect(back?.path).not.toBe(forward?.path);
    }
  });

  it("survives a cycle without dropping or looping on a node", () => {
    const layout = layoutWorkflowGraph(
      {
        nodes: ["x", "y"].map((nodeId) => ({ ...tree.nodes[0]!, id: nodeId })),
        edges: [
          { id: "1", source: "x", target: "y", kind: "fork", status: "idle" },
          { id: "2", source: "y", target: "x", kind: "fork", status: "idle" },
        ],
      },
      "TB",
    );
    expect(layout.nodes.map((node) => node.id).sort()).toEqual(["x", "y"]);
  });
  it("lays out a 5,000-deep lineage without exhausting the stack", () => {
    const depth = 5_000;
    const threads = [
      shell("t0"),
      ...Array.from({ length: depth }, (_, index) =>
        child(`t${index + 1}`, `t${index}`, "fork", index + 1),
      ),
    ];
    const graph = buildWorkflowGraph({ threadId: id("t0"), threads, projection: null });
    expect(graph.nodes).toHaveLength(depth + 1);
    for (const orientation of ["TB", "LR"] as const) {
      const layout = layoutWorkflowGraph(graph, orientation);
      expect(layout.nodes).toHaveLength(depth + 1);
      expect(layout.edges).toHaveLength(depth);
      const last = layout.nodes.find((node) => node.id === `t${depth}`)!;
      expect(orientation === "TB" ? last.y : last.x).toBe(
        padding + depth * ((orientation === "TB" ? nodeHeight : nodeWidth) + layerGap),
      );
    }
  });

  it("points a reversed edge at its real target", () => {
    const [root, a] = tree.nodes;
    const reversed = layoutWorkflowGraph(
      {
        nodes: [root!, a!],
        edges: [
          { id: "down", source: root!.id, target: a!.id, kind: "fork", status: "idle" },
          { id: "up", source: a!.id, target: root!.id, kind: "fork", status: "idle" },
        ],
      },
      "TB",
    );
    const [down, up] = reversed.edges;
    const place = (nodeId: string) => reversed.nodes.find((node) => node.id === nodeId)!;
    expect(down?.heading).toBe("down");
    expect(down?.end.y).toBe(place(a!.id).y);
    expect(up?.heading).toBe("up");
    // The reversed edge arrives on the root's lower side.
    expect(up?.end.y).toBe(place(root!.id).y + nodeHeight);
  });
});
