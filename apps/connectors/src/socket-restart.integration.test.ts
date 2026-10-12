import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import type { startConnectors as StartConnectors } from "./main.js";
import type { ConnectorsConfig } from "./config/private.js";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
let startConnectors!: typeof StartConnectors;

beforeAll(async () => {
  await exec("pnpm", ["--filter", "@personal-intelligence-hub/connectors", "build"], {
    cwd: repositoryRoot, timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
  });
  const built = await import(pathToFileURL(join(repositoryRoot, "apps/connectors/dist/src/main.js")).href) as { startConnectors: typeof StartConnectors };
  startConnectors = built.startConnectors;
});
const composeImage =
  "node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402";

const run = (args: string[], cwd: string) =>
  exec("docker", ["compose", ...args], {
    cwd,
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });

const verifyDockerExportMigrations = async (image: string): Promise<void> => {
  await exec("docker", [
    "build", "--build-arg", `NODE_IMAGE=${composeImage}`,
    "--tag", image, "--file", join(repositoryRoot, "infrastructure/docker/connectors-build.Dockerfile"),
    repositoryRoot,
  ], { cwd: repositoryRoot, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 });
  const extracted = await mkdtemp(join(tmpdir(), "pih-connectors-export-bundle-"));
  let container: string | undefined;
  try {
    const created = await exec("docker", ["create", image, "/__export_only__"], {
      cwd: repositoryRoot, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    container = created.stdout.trim();
    const rootfsArchive = join(extracted, "image-rootfs.tar");
    await exec("docker", ["export", "--output", rootfsArchive, container], {
      cwd: repositoryRoot, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    const rootfs = await exec("tar", ["-tf", rootfsArchive], {
      cwd: repositoryRoot, timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
    });
    const paths = rootfs.stdout.trim().split("\n");
    const dockerRuntimePaths = new Set([
      ".dockerenv", "dev/", "dev/console", "dev/pts/", "dev/shm/", "etc/",
      "etc/hostname", "etc/hosts", "etc/mtab", "etc/resolv.conf", "opt/", "proc/", "sys/",
    ]);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.startsWith("opt/connectors/") || dockerRuntimePaths.has(path))).toBe(true);
    await exec("docker", ["cp", `${container}:/opt/connectors/.`, extracted], {
      cwd: repositoryRoot, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    });
    const entrypoint = join(extracted, "dist/src/main.js");
    const sourceDirectory = join(repositoryRoot, "apps/connectors/src/migrations");
    const bundleDirectory = join(extracted, "dist/src/migrations");
    const names = async (directory: string) =>
      (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
    const sourceMigrations = await names(sourceDirectory);
    const bundledMigrations = await names(bundleDirectory);
    expect(bundledMigrations).toEqual(sourceMigrations);
    for (const migration of sourceMigrations) {
      const [source, bundled] = await Promise.all([
        readFile(join(sourceDirectory, migration)),
        readFile(join(bundleDirectory, migration)),
      ]);
      expect(bundled.equals(source)).toBe(true);
    }
    const runtime = await import(pathToFileURL(entrypoint).href) as { startConnectors?: unknown };
    expect(runtime.startConnectors).toBeTypeOf("function");
  } finally {
    if (container) await exec("docker", ["rm", container], { cwd: repositoryRoot });
    await rm(extracted, { recursive: true, force: true });
  }
};

const waitForPath = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error("Connector Unix socket did not appear");
};

const startUnprivilegedWebMountInspector = async (
  root: string,
  source: string,
  uid: number,
  primaryGid: number,
  clientGid: number,
): Promise<{ project: string; file: string }> => {
  const file = join(root, "compose.override.yaml");
  const project = `pih-connectors-socket-${process.pid}-${randomUUID().slice(0, 8)}`;
  await writeFile(
    file,
    [
      "services:",
      "  web-inspector:",
      `    image: ${composeImage}`,
      `    user: "${uid}:${primaryGid}"`,
      "    group_add:",
      `      - "${clientGid}"`,
      "    command: [node, -e, \"setInterval(() => {}, 1000)\"]",
      "    read_only: true",
      "    init: true",
      "    security_opt:",
      "      - no-new-privileges:true",
      "    volumes:",
      "      - type: bind",
      `        source: ${source}`,
      "        target: /run/pih-connectors",
      "        read_only: true",
      "",
    ].join("\n"),
  );
  await run(["-f", file, "-p", project, "up", "--detach", "--wait"], root);
  return { project, file };
};

const assertClientGroupRequired = async (
  source: string,
  uid: number,
  primaryGid: number,
): Promise<void> => {
  const script = [
    "const fs=require('node:fs');",
    "try{fs.readdirSync('/run/pih-connectors');process.exit(11)}",
    "catch(e){if(e.code==='EACCES')process.exit(0);console.error(e);process.exit(12)}",
  ].join("");
  await exec("docker", [
    "run", "--rm", "--user", `${uid}:${primaryGid}`,
    "--mount", `type=bind,source=${source},target=/run/pih-connectors,readonly`,
    composeImage, "node", "-e", script,
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
};

const inspectMountedSocket = async (root: string, project: string): Promise<void> => {
  const script = [
    "const fs=require('node:fs');",
    "const http=require('node:http');",
    "const assert=require('node:assert/strict');",
    "const root='/run/pih-connectors';",
    "assert.deepEqual(fs.readdirSync(root),['connectors.sock']);",
    "assert.equal(fs.existsSync(root+'/hermes-delegation.sock'),false);",
    "let denied=false;try{fs.writeFileSync(root+'/forbidden','x')}catch(e){denied=['EROFS','EACCES'].includes(e.code)}",
    "assert.equal(denied,true);",
    "http.get({socketPath:root+'/connectors.sock',path:'/health/live'},r=>{",
    "let body='';r.setEncoding('utf8');r.on('data',c=>body+=c);r.on('end',()=>{",
    "assert.equal(r.statusCode,200);assert.deepEqual(JSON.parse(body),{status:'ok'});process.exit(0)",
    "})}).on('error',e=>{console.error(e);process.exit(1)});",
  ].join("");
  await run(["-f", join(root, "compose.override.yaml"), "-p", project, "exec", "-T", "web-inspector", "node", "-e", script], root);
};

describe("directory-mounted connector socket restart", () => {
  it("keeps an unprivileged, read-only web mount connected across a real socket replacement", async () => {
    const connectorUid = process.getuid?.();
    const clientGid = process.getgid?.();
    const inspectorUid = 10_001;
    const inspectorPrimaryGid = 10_001;
    if (connectorUid === undefined || clientGid === undefined || connectorUid === 0) {
      throw new Error("Integration test requires a non-root Unix connector uid and gid");
    }
    if (connectorUid === inspectorUid || clientGid === inspectorPrimaryGid) {
      throw new Error("Integration test requires distinct connector and web inspector identities");
    }
    const root = await mkdtemp(join(tmpdir(), "pih-connectors-runtime-"));
    const runtime = join(root, "runtime");
    const web = join(runtime, "web");
    const webSocket = join(web, "connectors.sock");
    const hermesSocket = join(runtime, "hermes-delegation.sock");
    await mkdir(web, { recursive: true, mode: 0o750 });
    const hermes = createServer((socket) => socket.destroy());
    let first: Awaited<ReturnType<typeof startConnectors>> | undefined;
    let second: Awaited<ReturnType<typeof startConnectors>> | undefined;
    let inspector: { project: string; file: string } | undefined;
    const image = `pih-connectors-export-test:${process.pid}-${randomUUID().slice(0, 8)}`;
    const config: ConnectorsConfig = {
      transport: { kind: "unix", path: webSocket, socketGid: clientGid },
      databasePath: join(root, "connectors.sqlite"),
      serviceCredentials: [],
      audience: "personal-intelligence-hub-connectors",
      defaultTimeZone: "Etc/UTC",
      logLevel: "error",
    };
    const startBuiltConnectors = () =>
      startConnectors({
        environment: { NODE_ENV: "test" },
        loadConfig: () => config,
        providerModules: [],
      });
    try {
      await verifyDockerExportMigrations(image);
      await new Promise<void>((resolve, reject) => {
        hermes.once("error", reject);
        hermes.listen(hermesSocket, resolve);
      });
      first = await startBuiltConnectors();
      await waitForPath(webSocket);
      inspector = await startUnprivilegedWebMountInspector(
        root, web, inspectorUid, inspectorPrimaryGid, clientGid,
      );
      await assertClientGroupRequired(web, inspectorUid, inspectorPrimaryGid);
      await inspectMountedSocket(root, inspector.project);

      const firstInode = (await stat(webSocket)).ino;
      await first.shutdown();
      first = undefined;

      second = await startBuiltConnectors();
      await waitForPath(webSocket);
      expect((await stat(webSocket)).ino).not.toBe(firstInode);
      await inspectMountedSocket(root, inspector.project);

      await second.shutdown();
      second = undefined;
    } finally {
      if (second !== undefined) await second.shutdown().catch(() => undefined);
      if (first !== undefined) await first.shutdown().catch(() => undefined);
      if (inspector !== undefined) {
        await run(["-f", inspector.file, "-p", inspector.project, "down", "--volumes", "--remove-orphans"], root).catch(() => undefined);
      }
      await new Promise<void>((resolve) => hermes.close(() => resolve()));
      await exec("docker", ["image", "rm", "--force", image], { cwd: repositoryRoot }).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
