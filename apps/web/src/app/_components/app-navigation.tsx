"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { Icon, type IconName } from "./icon";

const items: ReadonlyArray<{ href: string; label: string; icon: IconName }> = [
  { href: "/", label: "Hoy", icon: "home" },
  { href: "/agents", label: "Agentes", icon: "agents" },
  { href: "/second-brain", label: "Second Brain", icon: "brain" },
  { href: "/system", label: "Sistema", icon: "system" },
];

export function AppNavigation() {
  const pathname = usePathname();

  return (
    <nav className="app-navigation" aria-label="Navegación principal">
      <div className="app-navigation__brand" aria-hidden="true">
        <span className="app-navigation__mark"><Icon name="spark" /></span>
        <span className="app-navigation__identity">
          <strong>Personal</strong>
          <span>Intelligence Hub</span>
        </span>
      </div>
      <div className="app-navigation__links">
        {items.map((item) => {
          const current =
            item.href === "/"
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              className="app-navigation__link"
              href={item.href}
              key={item.href}
              aria-current={current ? "page" : undefined}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>
      <p className="app-navigation__privacy">Privado · fuentes verificadas</p>
    </nav>
  );
}
