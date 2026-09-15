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

export interface MutationPorts {
  createBoard(
    context: MutationContext,
    input: CreateBoardBody,
  ): Promise<BoardSnapshot>;
  createCard(context: MutationContext, input: CreateCardBody): Promise<Card>;
  patchCard(
    context: MutationContext,
    cardId: string,
    input: PatchCardBody,
  ): Promise<Card>;
  addCardTag(
    context: MutationContext,
    cardId: string,
    tagId: string,
  ): Promise<CardTagMembership>;
  removeCardTag(
    context: MutationContext,
    cardId: string,
    tagId: string,
  ): Promise<CardTagMembership>;
  createRelation(
    context: MutationContext,
    input: CreateRelationBody,
  ): Promise<Relation>;
  archiveRelation(
    context: MutationContext,
    relationId: string,
  ): Promise<Relation>;
  createTask(context: MutationContext, input: CreateTaskBody): Promise<Task>;
  patchTask(
    context: MutationContext,
    taskId: string,
    input: PatchTaskBody,
  ): Promise<Task>;
  compensate(
    context: MutationContext,
    eventId: string,
    input: CompensateAuditEventBody,
  ): Promise<BoardSnapshot | Card | CardTagMembership | Relation | Task>;
}

export interface TransactionPorts {
  readonly mutations: MutationPorts;
  readonly queries: QueryPorts;
}

export interface UnitOfWork {
  execute<T>(operation: (ports: TransactionPorts) => Promise<T>): Promise<T>;
}
