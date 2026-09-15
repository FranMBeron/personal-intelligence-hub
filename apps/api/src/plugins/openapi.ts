import swagger from "@fastify/swagger";
import type { FastifyInstance } from "fastify";

export const registerOpenApi = (app: FastifyInstance): void => {
  void app.register(swagger, {
    openapi: {
      info: {
        title: "Personal Intelligence Hub Second Brain API",
        version: "0.1.0",
      },
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "JWT",
          },
        },
      },
    },
  });
};
