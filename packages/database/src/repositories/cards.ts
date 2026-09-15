import type { Card, Tag } from "@personal-intelligence-hub/contracts";
import type { PoolClient } from "pg";

type CardRow = {
  id: string;
  board_id: string;
  column_id: string;
  original_content: string;
  title: string;
  summary: string | null;
  position: number;
  version: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type TagRow = {
  id: string;
  name: string;
  color: string | null;
  created_at: Date;
  updated_at: Date;
};

export const mapTag = (row: TagRow): Tag => ({
  id: row.id,
  name: row.name,
  color: row.color,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const getCard = async (
  client: PoolClient,
  cardId: string,
): Promise<Card | null> => {
  const result = await client.query<CardRow>(
    `SELECT id, board_id, column_id, original_content, title, summary, position,
            version, archived_at, created_at, updated_at
     FROM cards WHERE id = $1`,
    [cardId],
  );
  const row = result.rows[0];
  if (row === undefined) return null;
  const tags = await client.query<TagRow>(
    `SELECT t.id, t.name, t.color, t.created_at, t.updated_at
     FROM tags t
     JOIN card_tags ct ON ct.tag_id = t.id
     WHERE ct.card_id = $1
     ORDER BY t.name ASC, t.id ASC`,
    [cardId],
  );
  return {
    id: row.id,
    boardId: row.board_id,
    columnId: row.column_id,
    originalContent: row.original_content,
    title: row.title,
    summary: row.summary,
    position: row.position,
    version: row.version,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    tags: tags.rows.map(mapTag),
  };
};

export const reserveCardPosition = async (
  client: PoolClient,
  columnId: string,
  position?: number,
): Promise<number> => {
  await client.query(`SELECT id FROM board_columns WHERE id = $1 FOR UPDATE`, [columnId]);
  const maximum = await client.query<{ maximum: number }>(
    `SELECT COALESCE(max(position), 0)::integer AS maximum
     FROM cards WHERE column_id = $1 AND archived_at IS NULL`,
    [columnId],
  );
  const maxPosition = maximum.rows[0]?.maximum ?? 0;
  const target = position ?? maxPosition + 1;
  if (target <= maxPosition) {
    await shiftPositions(client, columnId, target, maxPosition, 1);
  }
  return Math.min(target, maxPosition + 1);
};

export const shiftPositions = async (
  client: PoolClient,
  columnId: string,
  lower: number,
  upper: number,
  delta: 1 | -1,
  excludedCardId?: string,
) => {
  if (lower > upper) return;
  const excluded = excludedCardId ?? null;
  await client.query(
    `UPDATE cards SET position = position + 1000000
     WHERE column_id = $1 AND position BETWEEN $2 AND $3
       AND ($4::uuid IS NULL OR id <> $4::uuid)`,
    [columnId, lower, upper, excluded],
  );
  await client.query(
    `UPDATE cards SET position = position - 1000000 + $4
     WHERE column_id = $1 AND position BETWEEN $2 + 1000000 AND $3 + 1000000
       AND ($5::uuid IS NULL OR id <> $5::uuid)`,
    [columnId, lower, upper, delta, excluded],
  );
};
