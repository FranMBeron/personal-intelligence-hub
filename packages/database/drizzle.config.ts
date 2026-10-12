import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  out: "./migrations",
  schema: "./src/schema/index.ts",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgresql://pih_local:pih_local@127.0.0.1:5432/pih_local",
  },
  strict: true,
  verbose: true,
});
