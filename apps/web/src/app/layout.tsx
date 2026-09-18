import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppShell } from "./_components/app-shell";
import "./globals.css";

export const metadata: Metadata = {
  applicationName: "Centro de Inteligencia Personal",
  title: {
    default: "Personal Intelligence Hub",
    template: "%s · Personal Intelligence Hub",
  },
  description: "Espacio privado para prioridades, agentes y conocimiento personal.",
  icons: { icon: "/favicon.svg" },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#15231e",
};

export default function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="es" data-scroll-behavior="smooth">
      <body><AppShell>{children}</AppShell></body>
    </html>
  );
}
