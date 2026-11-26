import "~/index.css";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ shells: [] as unknown[] }));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadProjection: (() => null) as never,
  useThreadFamilyShells: (() => state.shells) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => []) as never,
  usePrimaryEnvironment: (() => null) as never,
  useEnvironment: (() => null) as never,
  useEnvironmentProviders: (() => new Map()) as never,
}));
vi.mock(import("../../state/peerLinks"), () => ({
  peerLinkEnvironment: { readThread: {} } as never,
  useLinkedEnvironments: (() => new Map()) as never,
}));

import { render } from "../../../test/render";
import { ThreadGraphPanel } from "./ThreadGraphPanel";

const environmentId = EnvironmentId.make("environment");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 26, 9, minute));

function shell(
  id: string,
  minute: number,
  title: string,
  status: string,
  lineage: Record<string, unknown> = {},
) {
  return {
    id: ThreadId.make(id),
    title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    status,
    pendingRuntimeRequest: null,
    createdAt: at(minute),
    latestRunStartedAt: at(minute),
    latestRunCompletedAt: status === "completed" ? at(minute + 3) : null,
    forkedFrom: null,
    lineage: {
      rootThreadId: ThreadId.make("root"),
      parentThreadId: null,
      relationshipToParent: null,
      ...lineage,
    },
  };
}

const childOf = (parent: string, kind: "fork" | "subagent") => ({
  parentThreadId: ThreadId.make(parent),
  relationshipToParent: kind,
});

const renderPanel = (threadId: string) =>
  render(<ThreadGraphPanel threadRef={scopeThreadRef(environmentId, ThreadId.make(threadId))} />, {
    router: "/",
  });

const nodeRects = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("button[aria-label]")]
    .filter((node) => node.getAttribute("aria-label")?.includes(":"))
    .map((node) => {
      const { left, right, top, bottom } = node.getBoundingClientRect();
      return { label: node.getAttribute("aria-label")!, left, right, top, bottom };
    });

it("shows a thread with no relatives as one root node", async () => {
  state.shells = [shell("root", 0, "Solo thread", "idle")];
  await using screen = await renderPanel("root");

  await expect.element(screen.getByText("1 thread")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Thread: Solo thread/ })).toBeVisible();
  await expect.element(screen.getByText(/appear here as this thread branches/)).toBeVisible();
  expect(screen.container.querySelectorAll("[data-graph-edge]")).toHaveLength(0);
});

it("draws a family, switches between vertical and horizontal, and never overlaps nodes", async () => {
  localStorage.clear();
  state.shells = [
    shell("root", 0, "Plan the release and a very long title that must truncate", "completed"),
    shell("fork", 1, "Fork: alternative approach", "running", childOf("root", "fork")),
    shell("sub-a", 2, "Subagent: /root/review_agent", "running", childOf("root", "subagent")),
    shell("sub-b", 3, "Subagent: /root/test_runner", "failed", childOf("root", "subagent")),
    shell("nested", 4, "Nested helper", "completed", childOf("fork", "subagent")),
  ];
  await using screen = await renderPanel("root");

  await expect.element(screen.getByText("5 threads · 2 running")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Subagent: Review Agent/ }))
    .toBeVisible();
  expect(screen.container.querySelectorAll("[data-graph-edge]")).toHaveLength(4);
  const current = screen.container.querySelector('[aria-current="true"]');
  expect(current?.getAttribute("aria-label")).toContain("Plan the release");

  for (const [name, orientation] of [
    ["Horizontal", "LR"],
    ["Vertical", "TB"],
  ] as const) {
    await screen.getByRole("button", { name: `${name} layout` }).click();
    await vi.waitFor(() =>
      expect(
        screen.container
          .querySelector("[data-graph-orientation]")
          ?.getAttribute("data-graph-orientation"),
      ).toBe(orientation),
    );
    const rects = nodeRects(screen.container);
    expect(rects).toHaveLength(5);
    for (const [index, left] of rects.entries()) {
      for (const right of rects.slice(index + 1)) {
        const apart =
          left.right <= right.left ||
          right.right <= left.left ||
          left.bottom <= right.top ||
          right.bottom <= left.top;
        expect(apart, `${left.label} / ${right.label}`).toBe(true);
      }
    }
  }
});

it("remembers the chosen direction", async () => {
  localStorage.clear();
  state.shells = [
    shell("root", 0, "Root", "idle"),
    shell("a", 1, "A", "idle", childOf("root", "fork")),
  ];
  {
    await using screen = await renderPanel("root");
    await screen.getByRole("button", { name: "Horizontal layout" }).click();
  }
  await using screen = await renderPanel("root");
  await vi.waitFor(() =>
    expect(
      screen.container
        .querySelector("[data-graph-orientation]")
        ?.getAttribute("data-graph-orientation"),
    ).toBe("LR"),
  );
});
