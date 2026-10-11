import { defineConfig } from "vite";

export default defineConfig({
  root: "src/renderer",
  server: {
    headers: {
      "Content-Security-Policy": [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
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
