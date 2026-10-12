import type { Relation } from "@personal-intelligence-hub/contracts";
import type { PoolClient } from "pg";

type RelationRow = {
  id: string;
  from_card_id: string;
  to_card_id: string;
  relation_type: Relation["type"];
  version: number;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export const mapRelation = (row: RelationRow): Relation => ({
  id: row.id,
  fromCardId: row.from_card_id,
  toCardId: row.to_card_id,
  type: row.relation_type,
  version: row.version,
  archivedAt: row.archived_at?.toISOString() ?? null,
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

export const getRelation = async (
  client: PoolClient,
  relationId: string,
): Promise<Relation | null> => {
  const result = await client.query<RelationRow>(
    `SELECT id, from_card_id, to_card_id, relation_type, version,
            archived_at, created_at, updated_at
     FROM relations WHERE id = $1`,
    [relationId],
  );
  return result.rows[0] === undefined ? null : mapRelation(result.rows[0]);
};

export const listRelations = async (client: PoolClient): Promise<Relation[]> => {
  const result = await client.query<RelationRow>(
    `SELECT id, from_card_id, to_card_id, relation_type, version,
            archived_at, created_at, updated_at
     FROM relations
     WHERE archived_at IS NULL
     ORDER BY updated_at DESC, id DESC`,
  );
  return result.rows.map(mapRelation);
};
