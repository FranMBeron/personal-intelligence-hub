import type { Tag } from "@personal-intelligence-hub/contracts";

import type { SecondBrainFilters } from "../_lib/view";

export function Filters({
  filters,
  boards,
  tags,
}: Readonly<{
  filters: SecondBrainFilters;
  boards: readonly Readonly<{ id: string; name: string }>[];
  tags: readonly Tag[];
}>) {
  return (
    <form className="brain-filters surface" role="search" method="get">
      <label className="brain-filters__search">
        <span>Buscar</span>
        <input name="q" type="search" defaultValue={filters.q} placeholder="Título, contenido, etiqueta o tarea" />
      </label>
      <label>
        <span>Tablero</span>
        <select name="board" defaultValue={filters.board ?? ""}>
          <option value="">Todos</option>
          {boards.map((board) => <option key={board.id} value={board.id}>{board.name}</option>)}
        </select>
      </label>
      <label>
        <span>Etiqueta</span>
        <select name="tag" defaultValue={filters.tag ?? ""}>
          <option value="">Todas</option>
          {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
        </select>
      </label>
      <label>
        <span>Estado de tarea</span>
        <select name="status" defaultValue={filters.status ?? ""}>
          <option value="">Todos</option>
          <option value="todo">Pendiente</option>
          <option value="in_progress">En curso</option>
          <option value="done">Hecha</option>
          <option value="cancelled">Cancelada</option>
        </select>
      </label>
      <button className="button" type="submit">Aplicar</button>
    </form>
  );
}
