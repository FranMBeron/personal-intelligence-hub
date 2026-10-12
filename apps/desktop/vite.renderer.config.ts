import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [
    {
      name: "development-control-csp",
      apply: "serve",
      // A meta CSP intersects response headers. Keep production strict while
      // allowing Vite's local WebSocket and injected styles during development.
      transformIndexHtml: {
        order: "pre",
        handler: (html) => html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[^>]*>/iu, ""),
      },
    },
  ],
  root: "src/renderer",
  server: {
    headers: {
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self'",
        "connect-src 'self' ws://localhost:* ws://127.0.0.1:* ws://[::1]:*",
        "base-uri 'none'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'none'",
      ].join("; "),
    },
  },
  build: {
    outDir: "../../.vite/renderer",
  },
});
