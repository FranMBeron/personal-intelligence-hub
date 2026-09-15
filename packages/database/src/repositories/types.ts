import type {
  AuditEvent,
  Board,
  BoardSnapshot,
  Card,
  CardTagMembership,
  CompensateAuditEventBody,
  CreateBoardBody,
  CreateCardBody,
  CreateRelationBody,
  CreateTaskBody,
  CursorPayload,
  MutationContext,
  PatchCardBody,
  PatchTaskBody,
  Relation,
  Snapshot,
  Task,
} from "@personal-intelligence-hub/contracts";

export type MutationResult<T> = Readonly<{
  status: number;
  body: T;
  headers: Readonly<Record<string, string>>;
  replayed: boolean;
}>;

export type Page<T> = Readonly<{
  items: readonly T[];
  nextCursor: CursorPayload | null;
  hasNextPage: boolean;
}>;

export type PageQuery = Readonly<{
  limit: number;
  cursor?: CursorPayload;
}>;

export interface MutationPorts {
  createBoard(context: MutationContext, input: CreateBoardBody): Promise<MutationResult<BoardSnapshot>>;
  createCard(context: MutationContext, input: CreateCardBody): Promise<MutationResult<Card>>;
  patchCard(context: MutationContext, cardId: string, input: PatchCardBody): Promise<MutationResult<Card>>;
  addCardTag(context: MutationContext, cardId: string, tagId: string): Promise<MutationResult<CardTagMembership>>;
  removeCardTag(context: MutationContext, cardId: string, tagId: string): Promise<MutationResult<CardTagMembership>>;
  createRelation(context: MutationContext, input: CreateRelationBody): Promise<MutationResult<Relation>>;
  archiveRelation(context: MutationContext, relationId: string): Promise<MutationResult<Relation>>;
  createTask(context: MutationContext, input: CreateTaskBody): Promise<MutationResult<Task>>;
  patchTask(context: MutationContext, taskId: string, input: PatchTaskBody): Promise<MutationResult<Task>>;
  compensate(
    context: MutationContext,
    eventId: string,
    input: CompensateAuditEventBody,
  ): Promise<MutationResult<BoardSnapshot | Card | CardTagMembership | Relation | Task>>;
}

export interface QueryPorts {
  readonly boards: {
    list(query: PageQuery): Promise<Page<Board>>;
    get(boardId: string): Promise<BoardSnapshot | null>;
  };
  readonly cards: { get(cardId: string): Promise<Card | null> };
  readonly tasks: { list(query: PageQuery): Promise<Page<Task>> };
  readonly auditEvents: { list(query: PageQuery): Promise<Page<AuditEvent>> };
  readonly snapshot: { get(): Promise<Snapshot> };
}

export interface TransactionPorts {
  readonly mutations: MutationPorts;
  readonly queries: QueryPorts;
}

export type RepositoryErrorCode =
  | "conflict"
  | "dependency_unavailable"
  | "idempotency_key_reused"
  | "not_found"
  | "precondition_required"
  | "version_conflict";

export class RepositoryError extends Error {
  readonly replayed: boolean;
  readonly status: number | undefined;
  readonly responseBody: unknown;
  readonly responseHeaders: Readonly<Record<string, string>> | undefined;

  constructor(
    readonly code: RepositoryErrorCode,
    readonly currentEtag?: string,
    options: ErrorOptions &
      Readonly<{
        replayed?: boolean;
        status?: number;
        responseBody?: unknown;
        responseHeaders?: Readonly<Record<string, string>>;
      }> = {},
  ) {
    super(code, options);
    this.name = "RepositoryError";
    this.replayed = options.replayed ?? false;
    this.status = options.status;
    this.responseBody = options.responseBody;
    this.responseHeaders = options.responseHeaders;
  }
}
