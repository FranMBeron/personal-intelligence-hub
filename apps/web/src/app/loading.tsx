export default function Loading() {
  return (
    <div className="skeleton-grid" aria-busy="true" aria-label="Cargando contenido">
      <div className="skeleton" />
      <div className="skeleton" />
      <div className="skeleton" />
    </div>
  );
}
