import Link from "next/link";

import { Icon } from "../../_components/icon";
import { StatusBadge } from "../../_components/status-badge";
import type { SecondBrainFilters, SecondBrainView } from "../_lib/view";

const nextHref = (filters: SecondBrainFilters, cursor: string): string => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key !== "cursor" && value !== undefined && value !== "") query.set(key, value);
  }
  query.set("cursor", cursor);
  return `/second-brain?${query.toString()}`;
};

export function BoardView({
  view,
  filters,
}: Readonly<{ view: SecondBrainView; filters: SecondBrainFilters }>) {
  const standaloneTasks = view.tasks.filter(({ cardId }) => cardId === null);

  return (
    <div className="brain-results">
      {view.boards.map((board) => (
        <section className="brain-board" key={board.id} aria-labelledby={`board-${board.id}`}>
          <header className="brain-board__header">
            <div>
              <p className="eyebrow">Tablero</p>
              <h2 id={`board-${board.id}`}>{board.name}</h2>
              {board.description === null ? null : <p>{board.description}</p>}
            </div>
            <StatusBadge tone="neutral">{board.columns.length} columnas</StatusBadge>
          </header>
          <div className="brain-columns">
            {board.columns.map((column) => (
              <section className="brain-column" key={column.id} aria-labelledby={`column-${column.id}`}>
                <header><h3 id={`column-${column.id}`}>{column.name}</h3><span>{column.cards.length}</span></header>
                <div className="brain-column__cards">
                  {column.cards.map((card) => (
                    <article className="brain-card" key={card.id}>
                      <h4>{card.title}</h4>
                      {card.summary === null ? null : <p className="brain-card__summary">{card.summary}</p>}
                      {card.tags.length === 0 ? null : (
                        <ul className="tag-list" aria-label="Etiquetas">
                          {card.tags.map((tag) => (
                            <li key={tag.id}><span style={tag.color === null ? undefined : { backgroundColor: tag.color }} aria-hidden="true" />{tag.name}</li>
                          ))}
                        </ul>
                      )}
                      {card.relations.length === 0 ? null : (
                        <ul className="relation-list" aria-label="Relaciones">
                          {card.relations.map((relation) => (
                            <li key={relation.id}><strong>{relation.label}</strong> {relation.targetTitle}</li>
                          ))}
                        </ul>
                      )}
                      {card.tasks.length === 0 ? null : (
                        <ul className="card-task-list" aria-label="Tareas relacionadas">
                          {card.tasks.map((task) => <li key={task.id}>{task.title}</li>)}
                        </ul>
                      )}
                      {card.obsidianLinks.map((href) => (
                        <a className="brain-card__link" href={href} key={href}>
                          Abrir en Obsidian <Icon name="arrow-up-right" />
                        </a>
                      ))}
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>
      ))}

      {standaloneTasks.length === 0 ? null : (
        <section className="standalone-tasks surface" aria-labelledby="standalone-tasks-title">
          <h2 id="standalone-tasks-title">Tareas sin tarjeta</h2>
          <ul>{standaloneTasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>
        </section>
      )}

      {view.nextCursor === null ? null : (
        <nav className="brain-pagination" aria-label="Paginación de tarjetas">
          <Link className="button button--quiet" href={nextHref(filters, view.nextCursor)}>
            Siguiente página <Icon name="arrow-up-right" />
          </Link>
        </nav>
      )}
    </div>
  );
}
