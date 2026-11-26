import "~/index.css";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  shells: [] as unknown[],
  projections: {} as Record<string, unknown>,
  titles: null as Record<string, string> | null,
}));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadProjection: ((ref: { threadId: string } | null) =>
    ref === null ? null : { projection: state.projections[ref.threadId] ?? null }) as never,
  useThreadFamilyShells: (() => state.shells) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironments: (() => []) as never,
  usePrimaryEnvironment: (() => null) as never,
  useEnvironment: (() => null) as never,
  useEnvironmentProviders: (() => new Map()) as never,
}));
vi.mock(import("../../state/orchestration"), () => ({
  orchestrationEnvironment: { threadTitles: () => ({}) } as never,
  threadTitlesRead: {} as never,
}));
vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: ((atom: unknown) => ({
    data: atom === null ? null : state.titles,
    isSuccess: state.titles !== null,
    isPending: false,
  })) as never,
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

const renderPanel = (threadId: string, container?: HTMLElement) =>
  render(<ThreadGraphPanel threadRef={scopeThreadRef(environmentId, ThreadId.make(threadId))} />, {
    router: "/",
    ...(container === undefined ? {} : { container }),
  });

/** A right panel as wide as the app lets it be, with the height of a typical window. */
const panelContainer = (width: number) => {
  const container = document.createElement("div");
  container.style.cssText = `display:flex;flex-direction:column;width:${width}px;height:640px`;
  return container;
};

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

const viewportOf = (container: HTMLElement) =>
  container
    .querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!
    .getBoundingClientRect();

it.each([390, 414, 420])(
  "keeps the open thread's card fully inside a %ipx panel in the default vertical layout",
  async (width) => {
    localStorage.clear();
    state.projections = {};
    state.titles = null;
    state.shells = [
      shell("root", 0, "Plan the release", "completed"),
      shell("a", 1, "First fork", "completed", childOf("root", "fork")),
      shell("b", 2, "Second fork, the one that is open", "running", childOf("root", "fork")),
    ];
    await using screen = await renderPanel("b", panelContainer(width));

    const current = screen.container.querySelector<HTMLElement>('[aria-current="true"]')!;
    await vi.waitFor(() => {
      const card = current.getBoundingClientRect();
      const view = viewportOf(screen.container);
      expect(card.left).toBeGreaterThanOrEqual(view.left);
      expect(card.right).toBeLessThanOrEqual(view.right);
    });
  },
);

it("shows a failed merge-back from a fork the same way from either end", async () => {
  const transfers = [
    {
      type: "merge_back",
      sourceThreadId: ThreadId.make("fork"),
      targetThreadId: ThreadId.make("root"),
      status: "failed",
      updatedAt: at(5),
    },
  ];
  localStorage.clear();
  state.titles = null;
  state.shells = [
    shell("root", 0, "Parent", "completed"),
    shell("fork", 1, "Fork", "completed", childOf("root", "fork")),
  ];
  state.projections = {
    root: { thread: state.shells[0], subagents: [], contextTransfers: transfers },
    fork: { thread: state.shells[1], subagents: [], contextTransfers: [] },
  };
  for (const open of ["root", "fork"]) {
    await using screen = await renderPanel(open);
    await vi.waitFor(() =>
      expect(screen.container.querySelectorAll('[data-graph-edge="merge_back"]')).toHaveLength(1),
    );
    expect(
      screen.container.querySelector('[data-graph-edge="merge_back"] path')?.getAttribute("class"),
    ).toContain("stroke-destructive");
  }
});

it("does not offer a parent that no store holds and no lookup names", async () => {
  localStorage.clear();
  state.projections = {};
  state.shells = [shell("fork", 1, "Orphan fork", "completed", childOf("gone", "fork"))];
  state.titles = {};
  await using screen = await renderPanel("fork");
  const parent = screen.container.querySelector<HTMLElement>('button[aria-label^="Thread:"]')!;
  expect(parent.getAttribute("aria-disabled")).toBe("true");
  expect(parent.style.cursor || getComputedStyle(parent).cursor).toBe("default");
});

it("opens a parent once a title lookup names it", async () => {
  localStorage.clear();
  state.projections = {};
  state.shells = [shell("fork", 1, "Archived child", "completed", childOf("old", "fork"))];
  state.titles = { old: "Archived parent" };
  await using screen = await renderPanel("fork");
  await expect
    .element(screen.getByRole("button", { name: /Thread: Archived parent/ }))
    .toBeVisible();
  const parent = screen.container.querySelector<HTMLElement>('button[aria-label^="Thread:"]')!;
  expect(parent.getAttribute("aria-disabled")).toBeNull();
});
