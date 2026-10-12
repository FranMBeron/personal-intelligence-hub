import type { ReactNode } from "react";

import { AppNavigation } from "./app-navigation";

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="app-stage">
      <div className="app-shell">
        <a className="skip-link" href="#contenido-principal">
          Saltar al contenido
        </a>
        <header className="app-bar">
          <div className="app-brand">
            <span className="app-brand__mark" aria-hidden="true" />
            <span>Personal Intelligence Hub</span>
          </div>
          <span className="app-bar__privacy">Espacio privado</span>
        </header>
        <main className="app-main" id="contenido-principal" tabIndex={-1}>
          <div className="app-main__inner">{children}</div>
        </main>
        <AppNavigation />
      </div>
    </div>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  aside,
}: Readonly<{
  eyebrow?: string;
  title: string;
  description?: string;
  aside?: ReactNode;
}>) {
  return (
    <header className="page-header">
      <div>
        {eyebrow === undefined ? null : <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description === undefined ? null : (
          <p className="page-header__description">{description}</p>
        )}
      </div>
      {aside === undefined ? null : <div className="page-header__aside">{aside}</div>}
    </header>
  );
}
