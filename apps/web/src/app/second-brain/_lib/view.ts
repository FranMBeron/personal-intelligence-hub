import type {
  Card,
  RelationType,
  Snapshot,
  Tag,
  Task,
  TaskStatus,
} from "@personal-intelligence-hub/contracts";

const PAGE_SIZE = 24;

export type SecondBrainFilters = Readonly<{
  q?: string;
  board?: string;
  tag?: string;
  status?: string;
  cursor?: string;
}>;

export type CardView = Readonly<{
  id: string;
  title: string;
  summary: string | null;
  originalContent: string;
  position: number;
  boardId: string;
  columnId: string;
  tags: readonly Tag[];
  tasks: readonly Task[];
  relations: readonly Readonly<{
    id: string;
    label: string;
    targetCardId: string;
    targetTitle: string;
  }>[];
  obsidianLinks: readonly string[];
}>;

export type SecondBrainView = Readonly<{
  generatedAt: string;
  boards: readonly Readonly<{
    id: string;
    name: string;
    description: string | null;
    columns: readonly Readonly<{
      id: string;
      name: string;
      position: number;
      cards: readonly CardView[];
    }>[];
  }>[];
  tags: readonly Tag[];
  tasks: readonly Task[];
  pageCards: readonly CardView[];
  totalCards: number;
  nextCursor: string | null;
}>;

const relationLabels: Record<
  RelationType,
  Readonly<{ outgoing: string; incoming: string }>
> = {
  related: { outgoing: "Relacionada con", incoming: "Relacionada con" },
  supports: { outgoing: "Apoya", incoming: "Apoyada por" },
  blocks: { outgoing: "Bloquea", incoming: "Bloqueada por" },
  duplicates: { outgoing: "Duplica", incoming: "Duplicada por" },
  references: { outgoing: "Referencia", incoming: "Referenciada por" },
};

const decodeOffset = (cursor: string | undefined, total: number): number => {
  if (cursor === undefined) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Object.keys(value).length !== 1 ||
      !("offset" in value) ||
      typeof value.offset !== "number" ||
      !Number.isInteger(value.offset) ||
      value.offset < 0 ||
      value.offset >= total
    ) {
      return 0;
    }
    return value.offset;
  } catch {
    return 0;
  }
};

const encodeOffset = (offset: number): string =>
  Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url");

const findObsidianLinks = (card: Card): readonly string[] => {
  const matches = `${card.originalContent}\n${card.summary ?? ""}`.match(
    /obsidian:\/\/[^\s<>"')\]]+/giu,
  );
  const links = (matches ?? []).filter((candidate) => {
    if (candidate.length > 2_048) return false;
    try {
      const url = new URL(candidate);
      return url.protocol === "obsidian:" && url.hostname !== "";
    } catch {
      return false;
    }
  });
  return [...new Set(links)];
};

const matchesSearch = (
  card: Card,
  tasks: readonly Task[],
  query: string,
): boolean =>
  [
    card.title,
    card.summary ?? "",
    card.originalContent,
    ...card.tags.map(({ name }) => name),
    ...tasks.map(({ title }) => title),
  ].some((value) => value.toLocaleLowerCase().includes(query));

export const buildSecondBrainView = (
  snapshot: Snapshot,
  filters: SecondBrainFilters,
): SecondBrainView => {
  const query = filters.q?.trim().toLocaleLowerCase() ?? "";
  const status = ["todo", "in_progress", "done", "cancelled"].includes(
    filters.status ?? "",
  )
    ? (filters.status as TaskStatus)
    : undefined;
  const boards = snapshot.boards
    .filter(({ archivedAt }) => archivedAt === null)
    .filter(({ id }) => filters.board === undefined || id === filters.board)
    .toSorted((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const boardOrder = new Map(boards.map(({ id }, index) => [id, index]));
  const columnOrder = new Map(
    boards.flatMap((currentBoard) =>
      currentBoard.columns.map((column) => [column.id, column.position] as const),
    ),
  );
  const cardTasks = new Map<string, Task[]>();
  for (const currentTask of snapshot.tasks) {
    if (currentTask.cardId === null || currentTask.archivedAt !== null) continue;
    const existing = cardTasks.get(currentTask.cardId) ?? [];
    existing.push(currentTask);
    cardTasks.set(currentTask.cardId, existing);
  }
  const filteredCards = snapshot.cards
    .filter(({ archivedAt }) => archivedAt === null)
    .filter(({ boardId }) => boardOrder.has(boardId))
    .filter(
      ({ tags }) =>
        filters.tag === undefined ||
        tags.some(({ id, name }) => id === filters.tag || name === filters.tag),
    )
    .filter((currentCard) =>
      query === ""
        ? true
        : matchesSearch(currentCard, cardTasks.get(currentCard.id) ?? [], query),
    )
    .toSorted(
      (left, right) =>
        (boardOrder.get(left.boardId) ?? Number.MAX_SAFE_INTEGER) -
          (boardOrder.get(right.boardId) ?? Number.MAX_SAFE_INTEGER) ||
        (columnOrder.get(left.columnId) ?? Number.MAX_SAFE_INTEGER) -
          (columnOrder.get(right.columnId) ?? Number.MAX_SAFE_INTEGER) ||
        left.position - right.position ||
        left.id.localeCompare(right.id),
    );
  const offset = decodeOffset(filters.cursor, filteredCards.length);
  const pageSource = filteredCards.slice(offset, offset + PAGE_SIZE);
  const cardsById = new Map(snapshot.cards.map((currentCard) => [currentCard.id, currentCard]));

  const projectCard = (currentCard: Card): CardView => {
    const relations = snapshot.relations
      .filter(({ archivedAt }) => archivedAt === null)
      .flatMap((relation) => {
        const outgoing = relation.fromCardId === currentCard.id;
        const incoming = relation.toCardId === currentCard.id;
        if (!outgoing && !incoming) return [];
        const targetCardId = outgoing ? relation.toCardId : relation.fromCardId;
        return [{
          id: relation.id,
          label: outgoing
            ? relationLabels[relation.type].outgoing
            : relationLabels[relation.type].incoming,
          targetCardId,
          targetTitle: cardsById.get(targetCardId)?.title ?? "Tarjeta no disponible",
        }];
      })
      .toSorted((left, right) => left.label.localeCompare(right.label) || left.id.localeCompare(right.id));
    return {
      id: currentCard.id,
      title: currentCard.title,
      summary: currentCard.summary,
      originalContent: currentCard.originalContent,
      position: currentCard.position,
      boardId: currentCard.boardId,
      columnId: currentCard.columnId,
      tags: currentCard.tags.toSorted((left, right) => left.name.localeCompare(right.name)),
      tasks: (cardTasks.get(currentCard.id) ?? [])
        .filter((currentTask) => status === undefined || currentTask.status === status)
        .toSorted(
          (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
        ),
      relations,
      obsidianLinks: findObsidianLinks(currentCard),
    };
  };

  const pageCards = pageSource.map(projectCard);
  const tasks = snapshot.tasks
    .filter(({ archivedAt }) => archivedAt === null)
    .filter((currentTask) => status === undefined || currentTask.status === status)
    .filter((currentTask) =>
      query === "" ? true : currentTask.title.toLocaleLowerCase().includes(query),
    )
    .toSorted((left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
  const tags = snapshot.cards
    .filter(({ archivedAt }) => archivedAt === null)
    .flatMap((currentCard) => currentCard.tags)
    .filter((currentTag, index, all) => all.findIndex(({ id }) => id === currentTag.id) === index)
    .toSorted((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

  return {
    generatedAt: snapshot.generatedAt,
    boards: boards.map((currentBoard) => ({
      id: currentBoard.id,
      name: currentBoard.name,
      description: currentBoard.description,
      columns: currentBoard.columns
        .toSorted((left, right) => left.position - right.position || left.id.localeCompare(right.id))
        .map((column) => ({
          id: column.id,
          name: column.name,
          position: column.position,
          cards: pageCards.filter((currentCard) => currentCard.columnId === column.id),
        })),
    })),
    tags,
    tasks,
    pageCards,
    totalCards: filteredCards.length,
    nextCursor:
      offset + PAGE_SIZE < filteredCards.length
        ? encodeOffset(offset + PAGE_SIZE)
        : null,
  };
};
