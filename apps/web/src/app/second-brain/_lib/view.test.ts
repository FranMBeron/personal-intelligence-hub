import type {
  BoardSnapshot,
  Card,
  Relation,
  Snapshot,
  Tag,
  Task,
} from "@personal-intelligence-hub/contracts";
import { describe, expect, it } from "vitest";

import { buildSecondBrainView } from "./view";

const timestamp = "2026-09-18T12:00:00.000Z";
const id = (value: number) =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const metadata = (value: number) => ({
  id: id(value),
  version: 1,
  archivedAt: null,
  createdAt: timestamp,
  updatedAt: timestamp,
});
const tag: Tag = {
  id: id(40),
  name: "Research",
  color: "#276653",
  createdAt: timestamp,
  updatedAt: timestamp,
};
const board: BoardSnapshot = {
  ...metadata(1),
  name: "Private board name",
  description: "A fictional board.",
  columns: [
    { ...metadata(2), boardId: id(1), name: "Inbox", position: 1 },
    { ...metadata(3), boardId: id(1), name: "Review", position: 2 },
  ],
};
const card = (value: number, overrides: Partial<Card> = {}): Card => ({
  ...metadata(value),
  boardId: id(1),
  columnId: id(2),
  originalContent: `Fictional capture ${value}`,
  title: `Card ${String(value).padStart(2, "0")}`,
  summary: null,
  position: value,
  tags: [],
  ...overrides,
});
const task = (value: number, overrides: Partial<Task> = {}): Task => ({
  ...metadata(value),
  title: `Task ${value}`,
  description: null,
  status: "todo",
  priority: "normal",
  dueAt: null,
  startsAt: null,
  completedAt: null,
  cardId: null,
  ...overrides,
});
const relation = (fromCardId: string, toCardId: string): Relation => ({
  ...metadata(70),
  fromCardId,
  toCardId,
  type: "supports",
});
const snapshot = (overrides: Partial<Snapshot> = {}): Snapshot => ({
  generatedAt: timestamp,
  lastSequence: "8",
  boards: [board],
  cards: [],
  relations: [],
  tasks: [],
  ...overrides,
});

describe("buildSecondBrainView", () => {
  it("places cards by board and column and labels their relations", () => {
    const source = card(10, {
      title: "Source insight",
      tags: [tag],
      originalContent:
        "Open obsidian://open?vault=Notes&file=source but never javascript:alert(1)",
    });
    const target = card(11, { title: "Target insight", columnId: id(3) });
    const view = buildSecondBrainView(
      snapshot({
        cards: [target, source],
        relations: [relation(source.id, target.id)],
        tasks: [task(60, { title: "Review source", cardId: source.id })],
      }),
      {},
    );

    expect(view.boards[0]?.columns[0]?.cards[0]).toMatchObject({
      title: "Source insight",
      tags: [{ name: "Research" }],
      relations: [{ label: "Apoya", targetTitle: "Target insight" }],
      tasks: [{ title: "Review source" }],
      obsidianLinks: ["obsidian://open?vault=Notes&file=source"],
    });
    expect(view.boards[0]?.columns[1]?.cards[0]?.title).toBe("Target insight");
    expect(
      view.pageCards.flatMap(({ obsidianLinks }) => obsidianLinks),
    ).not.toContain("javascript:alert(1)");
  });

  it("searches only approved fields case-insensitively", () => {
    const source = snapshot({
      cards: [card(10, { title: "Neural Connections", tags: [tag] })],
      tasks: [task(60, { title: "SYNTHESIZE notes", cardId: id(10) })],
    });

    expect(buildSecondBrainView(source, { q: "neural" }).totalCards).toBe(1);
    expect(buildSecondBrainView(source, { q: "RESEARCH" }).totalCards).toBe(1);
    expect(buildSecondBrainView(source, { q: "synthesize" }).totalCards).toBe(1);
    expect(buildSecondBrainView(source, { q: "private board" }).totalCards).toBe(0);
  });

  it("applies board, tag and task-status filters independently", () => {
    const source = snapshot({
      cards: [card(10, { tags: [tag] }), card(11)],
      tasks: [
        task(60, { title: "Open task", status: "todo", cardId: id(10) }),
        task(61, { title: "Closed task", status: "done" }),
      ],
    });
    const view = buildSecondBrainView(source, {
      board: board.id,
      tag: tag.id,
      status: "done",
    });

    expect(view.totalCards).toBe(1);
    expect(view.tasks.map(({ title }) => title)).toEqual(["Closed task"]);
    expect(view.pageCards[0]?.tasks).toEqual([]);
  });

  it("paginates 24 deterministically and clamps invalid cursors", () => {
    const cards = Array.from({ length: 26 }, (_, index) => card(100 + index));
    const first = buildSecondBrainView(snapshot({ cards }), {});
    const second = buildSecondBrainView(snapshot({ cards }), {
      cursor: first.nextCursor!,
    });
    const invalid = buildSecondBrainView(snapshot({ cards }), {
      cursor: "not-a-valid-cursor",
    });

    expect(first.pageCards).toHaveLength(24);
    expect(first.pageCards[0]?.title).toBe("Card 100");
    expect(second.pageCards.map(({ title }) => title)).toEqual(["Card 124", "Card 125"]);
    expect(second.nextCursor).toBeNull();
    expect(invalid.pageCards[0]?.title).toBe("Card 100");
  });
});
