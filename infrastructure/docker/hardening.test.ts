import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

type Service = {
  cap_drop?: string[];
  cpus?: number | string;
  image?: string;
  group_add?: string[];
  mem_limit?: string;
  pids_limit?: number;
  ports?: string[];
  privileged?: boolean;
  read_only?: boolean;
  security_opt?: string[];
  volumes?: Array<string | { source?: string; target?: string }>;
  command?: string[];
};

const read = (path: string) => readFile(`${repositoryRoot}/${path}`, "utf8");

const readCompose = async (path: string) =>
  parse(await read(path)) as { services: Record<string, Service> };

const volumeTargets = (service: Service): string[] =>
  (service.volumes ?? []).map((volume) =>
    typeof volume === "string" ? volume.split(":").at(-1) ?? volume : volume.target ?? "",
  );

describe.each([
  "infrastructure/docker/compose.yaml",
  "infrastructure/docker/compose.production.yaml",
])("container policy in %s", (composePath) => {
  it("confines application containers without host or Docker control", async () => {
    const { services } = await readCompose(composePath);

    for (const serviceName of ["migrate", "api", "web"]) {
      const service = services[serviceName];
      expect(service, `${serviceName} is missing`).toBeDefined();
      expect(service?.cap_drop).toContain("ALL");
      expect(service?.security_opt).toContain("no-new-privileges:true");
      expect(service?.pids_limit).toBeGreaterThan(0);
      expect(service?.mem_limit).toMatch(/^\d+[mg]$/);
      expect(Number(service?.cpus)).toBeGreaterThan(0);
      expect(service?.read_only).toBe(true);
      expect(service?.privileged ?? false).toBe(false);
      expect(volumeTargets(service ?? {})).not.toContain("/var/run/docker.sock");
    }
  });

  it("never publishes PostgreSQL", async () => {
    const { services } = await readCompose(composePath);
    expect(services.postgres?.ports ?? []).toEqual([]);
  });

  it("runs migrations from the production dependency bundle", async () => {
    const { services } = await readCompose(composePath);
    expect(services.migrate?.command).toEqual([
      "node",
      "node_modules/@personal-intelligence-hub/database/dist/src/migrate.js",
    ]);
  });
});

describe("production network boundary", () => {
  it("requires a release-specific PostgreSQL image", async () => {
    const { services } = await readCompose("infrastructure/docker/compose.production.yaml");
    expect(services.postgres?.image).toBe("${PIH_POSTGRES_IMAGE:?set PIH_POSTGRES_IMAGE to an immutable image reference}");
  });
  it("publishes only the web service and binds it to loopback", async () => {
    const { services } = await readCompose(
      "infrastructure/docker/compose.production.yaml",
    );

    expect(services.api?.ports ?? []).toEqual([]);
    expect(services.web?.ports).toEqual([
      "127.0.0.1:${PIH_WEB_PORT:-3000}:3000",
    ]);
  });
});

describe("PostgreSQL runtime image", () => {
  it("rebuilds the reviewed gosu commit with a pinned patched Go toolchain", async () => {
    const dockerfile = await read("infrastructure/docker/postgres.Dockerfile");
    const builder = dockerfile.split("FROM postgres:")[0];

    expect(builder).toContain(
      "FROM golang:1.26.9-alpine3.24@sha256:3082400e369fa24d5fc60bca20edab3f6d604e0c5a690ec66b295eff4dd87ade AS gosu-build",
    );
    expect(builder).toContain(
      "CGO_ENABLED=0 GOTOOLCHAIN=local go install github.com/tianon/gosu@6456aaa0f3c854d199d0f037f068eb97515b7513",
    );
  });

  it("replaces only gosu in the PostgreSQL runtime with the rebuilt binary", async () => {
    const dockerfile = await read("infrastructure/docker/postgres.Dockerfile");
    const runtime = dockerfile.split("FROM postgres:")[1];

    expect(runtime).toContain(
      "COPY --from=gosu-build /go/bin/gosu /usr/local/bin/gosu",
    );
    expect(dockerfile.match(/^COPY --from=gosu-build .+$/gm)).toEqual([
      "COPY --from=gosu-build /go/bin/gosu /usr/local/bin/gosu",
    ]);
    expect(runtime).not.toMatch(/(?:go install|FROM golang:)/);
  });

  it("patches the pinned vendor image without replacing its startup or data semantics", async () => {
    const dockerfile = await read("infrastructure/docker/postgres.Dockerfile");
    expect(dockerfile).toMatch(/FROM postgres:16\.15-alpine3\.24@sha256:[a-f0-9]{64}/);
    expect(dockerfile).toContain("apk add --no-cache libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 zlib=1.3.2-r1");
    expect(dockerfile).not.toMatch(/^(ENTRYPOINT|CMD|USER|VOLUME)\s/m);
  });
});

describe.each(["api", "web"])("%s runtime image", (application) => {
  it("uses a pinned base, drops privileges and avoids copying the workspace", async () => {
    const dockerfile = await read(`infrastructure/docker/${application}.Dockerfile`);

    expect(dockerfile).toMatch(
      /node:22\.23\.3-alpine3\.24@sha256:[a-f0-9]{64}/,
    );
    expect(dockerfile).toContain("USER node");
    expect(dockerfile).not.toMatch(/COPY --from=build[^\n]*\/workspace\s+\/app/);
    expect(dockerfile.indexOf("COPY patches/ patches/")).toBeGreaterThan(0);
    expect(dockerfile.indexOf("COPY patches/ patches/")).toBeLessThan(dockerfile.indexOf("RUN pnpm install --frozen-lockfile"));
  });

  it("refreshes vulnerable Alpine runtime libraries with reviewed exact versions", async () => {
    const dockerfile = await read(`infrastructure/docker/${application}.Dockerfile`);
    const runtime = dockerfile.split("AS runtime")[1];
    expect(runtime).toMatch(/apk add --no-cache[^\n]*libcrypto3=3\.5\.9-r0[^\n]*libssl3=3\.5\.9-r0[^\n]*zlib=1\.3\.2-r1/);
    expect(runtime).not.toContain("apk upgrade");
  });
});

describe("Docker build context", () => {
  it("excludes private local documentation and secrets", async () => {
    const dockerignore = await read(".dockerignore");
    expect(dockerignore).toMatch(/^\.local-docs$/m);
    expect(dockerignore).toMatch(/^\.env\.\*$/m);
    expect(dockerignore).toMatch(/^secrets$/m);
  });
});

describe("private connectors host bundle", () => {
  it("mounts only the recreated BFF socket directory into web", async () => {
    const { services } = await readCompose("infrastructure/docker/compose.production.yaml");
    const web = services.web;
    expect(web?.volumes).toContain("/run/pih-connectors/web:/run/pih-connectors:ro");
    expect(web?.group_add).toContain("${PIH_CONNECTORS_CLIENT_GID:?required}");
    expect(JSON.stringify(web?.volumes)).not.toContain("connectors.sock:");
    expect(JSON.stringify(web?.volumes)).not.toContain("/run/pih-connectors:/run/pih-connectors:ro");
    expect(JSON.stringify(web?.volumes)).not.toContain("hermes-delegation.sock");
    expect(JSON.stringify(services)).not.toContain("3010:3010");
  });

  it("configures the local web service with the same directory mount and client group", async () => {
    const { services } = await readCompose("infrastructure/docker/compose.yaml");
    expect(services.web?.volumes).toContain(
      "${PIH_CONNECTORS_SOCKET_SOURCE:-/run/pih-connectors/web}:/run/pih-connectors:ro",
    );
    expect(services.web?.group_add).toContain("${PIH_CONNECTORS_CLIENT_GID:?required}");
  });

  it("runs connectors as a hardened unprivileged host service", async () => {
    const unit = await read("infrastructure/systemd/personal-intelligence-hub-connectors.service");
    const sysusers = await read("infrastructure/systemd/pih-connectors.sysusers");
    expect(unit).toContain("User=pih-connectors");
    expect(unit).toContain("Group=pih-connectors");
    expect(unit).toContain("SupplementaryGroups=pih-connectors-clients hermes-agents");
    expect(unit).toContain("EnvironmentFile=/etc/pih-connectors/connectors.env");
    expect(unit).toContain("ExecStart=/usr/bin/node /opt/pih-connectors/current/dist/src/main.js");
    expect(unit).toContain("RuntimeDirectory=pih-connectors");
    expect(unit).toContain("RuntimeDirectoryPreserve=yes");
    expect(unit).toContain("RuntimeDirectoryMode=0750");
    expect(unit).toContain("StateDirectory=pih-connectors");
    expect(unit).toContain("StateDirectoryMode=0700");
    expect(unit).toContain("UMask=0007");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("ProtectSystem=strict");
    expect(unit).toContain("ReadWritePaths=/var/lib/pih-connectors /run/pih-connectors");
    expect(sysusers).toContain("g pih-connectors -");
    expect(sysusers).toContain("g pih-connectors-clients -");
    expect(sysusers).toContain("g hermes-agents -");
    expect(sysusers).toContain('u pih-connectors - "PIH private connectors" /var/lib/pih-connectors /usr/sbin/nologin');
  });

  it("exports a build-only bundle and packages the compiled entrypoint and SQL migrations", async () => {
    const dockerfile = await read("infrastructure/docker/connectors-build.Dockerfile");
    expect(dockerfile).toContain("ARG NODE_IMAGE");
    expect(dockerfile).toContain("FROM ${NODE_IMAGE} AS build");
    expect(dockerfile).toContain("pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("pnpm --filter @personal-intelligence-hub/connectors deploy --prod /opt/connectors");
    expect(dockerfile).toContain("cp -R apps/connectors/dist /opt/connectors/dist");
    expect(dockerfile).not.toMatch(/^(CMD|ENTRYPOINT|EXPOSE)\s/m);


  });
});
