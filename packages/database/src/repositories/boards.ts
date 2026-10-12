import type { Board, BoardColumn, BoardSnapshot } from "@personal-intelligence-hub/contracts";
import type { PoolClient } from "pg";

import type { Page, PageQuery } from "./types.js";

type BoardRow = {
  id: string;
  name: string;
  description: string | null;
  version: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type ColumnRow = {
  id: string;
  board_id: string;
  name: string;
  position: number;
  version: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

const timestamp = (value: Date) => value.toISOString();
const nullableTimestamp = (value: Date | null) => value?.toISOString() ?? null;

export const mapBoard = (row: BoardRow): Board => ({
  id: row.id,
  name: row.name,
  description: row.description,
  version: row.version,
  archivedAt: nullableTimestamp(row.archived_at),
  createdAt: timestamp(row.created_at),
  updatedAt: timestamp(row.updated_at),
});

export const mapColumn = (row: ColumnRow): BoardColumn => ({
  id: row.id,
  boardId: row.board_id,
  name: row.name,
  position: row.position,
  version: row.version,
  archivedAt: nullableTimestamp(row.archived_at),
  createdAt: timestamp(row.created_at),
  updatedAt: timestamp(row.updated_at),
});

export const getBoardSnapshot = async (
  client: PoolClient,
  boardId: string,
): Promise<BoardSnapshot | null> => {
  const boardResult = await client.query<BoardRow>(
    `SELECT id, name, description, version, archived_at, created_at, updated_at
     FROM boards WHERE id = $1`,
    [boardId],
  );
  const board = boardResult.rows[0];
  if (board === undefined) return null;
  const columns = await client.query<ColumnRow>(
    `SELECT id, board_id, name, position, version, archived_at, created_at, updated_at
     FROM board_columns
     WHERE board_id = $1 AND archived_at IS NULL
     ORDER BY position ASC`,
    [boardId],
  );
  return { ...mapBoard(board), columns: columns.rows.map(mapColumn) };
};

export const listBoards = async (
  client: PoolClient,
  query: PageQuery,
): Promise<Page<Board>> => {
  const cursor = query.cursor?.sort;
  const result = await client.query<BoardRow>(
    `SELECT id, name, description, version, archived_at, created_at, updated_at
     FROM boards
     WHERE archived_at IS NULL
       AND ($1::timestamptz IS NULL OR (updated_at, id) < ($1::timestamptz, $2::uuid))
     ORDER BY updated_at DESC, id DESC
     LIMIT $3`,
    [cursor?.value ?? null, cursor?.id ?? null, query.limit + 1],
  );
  const hasNextPage = result.rows.length > query.limit;
  const rows = result.rows.slice(0, query.limit);
  const last = rows.at(-1);
  return {
    items: rows.map(mapBoard),
    hasNextPage,
    nextCursor:
      hasNextPage && last !== undefined
        ? {
            version: 1,
            route: "/v1/boards",
            filterHash: "none",
            sort: { value: timestamp(last.updated_at), id: last.id },
          }
        : null,
  };
};
