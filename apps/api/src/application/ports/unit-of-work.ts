import type {
  BoardSnapshot,
  Card,
  CardTagMembership,
  CompensateAuditEventBody,
  CreateBoardBody,
  CreateCardBody,
  CreateRelationBody,
  CreateTaskBody,
  MutationContext,
  PatchCardBody,
  PatchTaskBody,
  Relation,
  Task,
} from "@personal-intelligence-hub/contracts";

import type { QueryPorts } from "./queries.js";

export type MutationResult<T> = Readonly<{
  status: number;
  body: T;
  headers: Readonly<Record<string, string>>;
  replayed: boolean;
}>;

export interface MutationPorts {
  createBoard(
    context: MutationContext,
    input: CreateBoardBody,
  ): Promise<MutationResult<BoardSnapshot>>;
  createCard(
    context: MutationContext,
    input: CreateCardBody,
  ): Promise<MutationResult<Card>>;
  patchCard(
    context: MutationContext,
    cardId: string,
    input: PatchCardBody,
  ): Promise<MutationResult<Card>>;
  addCardTag(
    context: MutationContext,
    cardId: string,
    tagId: string,
  ): Promise<MutationResult<CardTagMembership>>;
  removeCardTag(
    context: MutationContext,
    cardId: string,
    tagId: string,
  ): Promise<MutationResult<CardTagMembership>>;
  createRelation(
    context: MutationContext,
    input: CreateRelationBody,
  ): Promise<MutationResult<Relation>>;
  archiveRelation(
    context: MutationContext,
    relationId: string,
  ): Promise<MutationResult<Relation>>;
  createTask(
    context: MutationContext,
    input: CreateTaskBody,
  ): Promise<MutationResult<Task>>;
  patchTask(
    context: MutationContext,
    taskId: string,
    input: PatchTaskBody,
  ): Promise<MutationResult<Task>>;
  compensate(
    context: MutationContext,
    eventId: string,
    input: CompensateAuditEventBody,
  ): Promise<
    MutationResult<BoardSnapshot | Card | CardTagMembership | Relation | Task>
  >;
}

export interface TransactionPorts {
  readonly mutations: MutationPorts;
  readonly queries: QueryPorts;
}

export interface UnitOfWork {
  execute<T>(operation: (ports: TransactionPorts) => Promise<T>): Promise<T>;
}
