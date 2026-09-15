import type {
  AuditEvent,
  Board,
  BoardSnapshot,
  Card,
  CursorPayload,
  Snapshot,
  Task,
} from "@personal-intelligence-hub/contracts";

export type Page<T> = Readonly<{
  items: readonly T[];
  nextCursor: CursorPayload | null;
  hasNextPage: boolean;
}>;

export type PageQuery = Readonly<{
  limit: number;
  cursor?: CursorPayload;
}>;

export interface BoardQueries {
  list(query: PageQuery): Promise<Page<Board>>;
  get(boardId: string): Promise<BoardSnapshot | null>;
}

export interface CardQueries {
  get(cardId: string): Promise<Card | null>;
}

export interface TaskQueries {
  list(query: PageQuery): Promise<Page<Task>>;
}

export interface AuditEventQueries {
  list(query: PageQuery): Promise<Page<AuditEvent>>;
}

export interface SnapshotQueries {
  get(): Promise<Snapshot>;
}

export interface QueryPorts {
  readonly boards: BoardQueries;
  readonly cards: CardQueries;
  readonly tasks: TaskQueries;
  readonly auditEvents: AuditEventQueries;
  readonly snapshot: SnapshotQueries;
}
