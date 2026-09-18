import type { ReactNode } from "react";

import { AppNavigation } from "./app-navigation";

export function AppShell({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#contenido-principal">
        Saltar al contenido
      </a>
      <AppNavigation />
      <main className="app-main" id="contenido-principal" tabIndex={-1}>
        <div className="app-main__inner">{children}</div>
      </main>
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
