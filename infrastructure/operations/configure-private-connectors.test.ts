import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const script = join(repositoryRoot, "infrastructure/operations/configure-private-connectors.sh");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Pseudo-terminal driver: answers each prompt by label, records whether the
 * terminal echo flag was set when the prompt appeared, and reports output.
 */
const driver = String.raw`
import json, os, pty, select, sys, termios
script, answers_path, report_path = sys.argv[1:4]
answers = json.load(open(answers_path))
pid, fd = pty.fork()
if pid == 0:
    os.execvp("sh", ["sh", script])
output = b""
prompts = []
answered_until = 0
exhausted = False
while True:
    ready, _, _ = select.select([fd], [], [], 20)
    if not ready:
        os.kill(pid, 9)
        exhausted = True
        break
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    output += chunk
    pending = output[answered_until:]
    if pending.endswith(b": "):
        line = pending.decode("utf-8", "replace").splitlines()[-1]
        echo = bool(termios.tcgetattr(fd)[3] & termios.ECHO)
        label = next((key for key in answers if key in line), None)
        prompts.append({"text": line, "echo": echo, "answered": label is not None})
        answered_until = len(output)
        if label is None:
            exhausted = True
            os.write(fd, b"\x04")
        else:
            os.write(fd, answers[label].encode("utf-8") + b"\n")
_, status = os.waitpid(pid, 0)
json.dump({
    "status": os.waitstatus_to_exitcode(status),
    "prompts": prompts,
    "output": output.decode("utf-8", "replace"),
    "exhausted": exhausted,
}, open(report_path, "w"))
`;

const key = (fill: number): string => Buffer.alloc(32, fill).toString("base64url");
const credentials = JSON.stringify([
  ["pih-web", ["human"], ["system:read"]],
  ["hermes-central", ["agent"], ["calendar:read"]],
  ["telegram-gateway", ["service"], ["hermes:agents:read"]],
  ["pih-deployer", ["service"], ["health:read"]],
].map(([serviceId, actorTypes, maxScopes], index) => ({
  serviceId,
  serviceToken: `fictional-configurator-service-token-${index}-0000000000`,
  delegatedIssuer: `fictional-issuer-${String(serviceId)}`,
  delegatedKey: key(index + 1),
  actorTypes,
  maxScopes,
  ...(serviceId === "hermes-central" ? { boundActorId: "00000000-0000-4000-8000-0000000000b1" } : {}),
})));
const profiles = JSON.stringify([
  { id: "orchestrator", displayName: "Orchestrator", keyEnvironment: "HERMES_ORCHESTRATOR_API_KEY", enabled: true,
    capabilities: { directConversations: true, images: true, delegationTarget: false } },
  { id: "specialist", displayName: "Specialist", keyEnvironment: "HERMES_SPECIALIST_API_KEY", enabled: true,
    capabilities: { directConversations: true, images: true, delegationTarget: true } },
]);
const peers = JSON.stringify([{
  sourceAgentId: "orchestrator",
  ownerActorId: "00000000-0000-4000-8000-0000000000b1",
  targetAgentId: "specialist",
  tokenEnvironment: "HERMES_SPECIALIST_PEER_TOKEN",
}]);

const secrets = {
  credentials,
  orchestratorKey: "fictional-orchestrator-api-key-000000000000",
  specialistKey: "fictional-specialist-api-key-0000000000000",
  peerToken: "fictional-specialist-peer-token-00000000000000",
  clientId: "fictional-client-id.apps.example.test",
  clientSecret: "fictional-client-secret-value-000000",
  keyring: JSON.stringify([{ id: "fictional-key-1", key: key(9) }]),
  blindIndex: key(10),
};

const answersFor = (uploadDirectory: string, overrides: Readonly<Record<string, string>> = {}) => ({
  "Host BFF socket path": "",
  "Numeric GID of pih-connectors-clients": "990",
  "Service credential map": secrets.credentials,
  "Default IANA time zone": "",
  "Log level": "",
  "Configure Hermes delegation": "yes",
  "Configure Hermes": "",
  "Hermes loopback API origin": "http://127.0.0.1:18642",
  "Hermes profiles": profiles,
  "Default gateway profile ID": "orchestrator",
  "API key for HERMES_ORCHESTRATOR_API_KEY": secrets.orchestratorKey,
  "API key for HERMES_SPECIALIST_API_KEY": secrets.specialistKey,
  "Hermes upload directory": uploadDirectory,
  "Delegating orchestrator profile ID": "orchestrator",
  "Agent-only delegation socket path": "",
  "Numeric GID of hermes-agents": "991",
  "Delegation peers": peers,
  "Peer token for HERMES_SPECIALIST_PEER_TOKEN": secrets.peerToken,
  "Configure Google Calendar": "",
  "Private PIH HTTPS origin": "https://pih.example.test",
  "Google OAuth redirect URI": "",
  "Google OAuth client ID": secrets.clientId,
  "Google OAuth client secret": secrets.clientSecret,
  "Active Calendar encryption key ID": "fictional-key-1",
  "Calendar encryption keyring": secrets.keyring,
  "Calendar blind-index key": secrets.blindIndex,
  "Configure a device connection": "",
  ...overrides,
});

type Report = Readonly<{
  status: number;
  prompts: readonly Readonly<{ text: string; echo: boolean; answered: boolean }>[];
  output: string;
  exhausted: boolean;
}>;

const setup = async (options: Readonly<{ fakeChmodMode?: string }> = {}) => {
  const root = await mkdtemp(join(tmpdir(), "pih-configure-"));
  roots.push(root);
  const bin = join(root, "bin");
  const fakeRoot = join(root, "fake-root");
  const runtime = join(root, "connectors/current/dist/src/operations");
  const uploadDirectory = join(root, "uploads");
  await mkdir(bin);
  await mkdir(join(fakeRoot, "etc"), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await writeFile(join(runtime, "validate-config-command.js"), "");
  const fakes: Record<string, string> = {
    id: "#!/bin/sh\nprintf '0\\n'\n",
    chown: "#!/bin/sh\nexit 0\n",
    stat: `#!/bin/sh
if [ "$1" = "-c" ] && [ "$2" = "%u:%g:%a" ]; then printf '0:0:%s\\n' "$(/usr/bin/stat -c '%a' "$3")"; exit 0; fi
exec /usr/bin/stat "$@"
`,
    "systemd-run": `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> "$SYSTEMD_RUN_LOG"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; break ;;
    -p)
      case "$2" in EnvironmentFile=*) set -a; . "\${2#EnvironmentFile=}"; set +a ;; esac
      shift 2
      ;;
    --*) shift ;;
    *) exit 2 ;;
  esac
done
exec "$@"
`,
    // Runs the real validator source with the production parsers.
    "validator-node": `#!/bin/sh
shift
cd "$REPOSITORY_ROOT"
exec "$REAL_NODE" --conditions=development --import tsx --disable-warning=ExperimentalWarning \\
  "$REPOSITORY_ROOT/apps/connectors/src/operations/validate-config-command.ts" "$@"
`,
  };
  if (options.fakeChmodMode !== undefined) {
    fakes.chmod = `#!/bin/sh\nshift\nexec /usr/bin/chmod ${options.fakeChmodMode} "$@"\n`;
  }
  for (const [name, contents] of Object.entries(fakes)) await writeFile(join(bin, name), contents, { mode: 0o700 });

  const run = async (answers: Readonly<Record<string, string>>): Promise<Report> => {
    const answersPath = join(root, "answers.json");
    const reportPath = join(root, "report.json");
    const driverPath = join(root, "driver.py");
    await writeFile(answersPath, JSON.stringify(answers), { mode: 0o600 });
    await writeFile(driverPath, driver);
    await exec("python3", ["-I", driverPath, script, answersPath, reportPath], {
      cwd: repositoryRoot,
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: root,
        PIH_CONFIGURE_ROOT: fakeRoot,
        PIH_CONNECTORS_ROOT: join(root, "connectors"),
        PIH_CONNECTORS_NODE: join(bin, "validator-node"),
        REPOSITORY_ROOT: repositoryRoot,
        REAL_NODE: process.execPath,
        SYSTEMD_RUN_LOG: join(root, "systemd-run.log"),
      },
      timeout: 60_000,
    });
    return JSON.parse(await readFile(reportPath, "utf8")) as Report;
  };

  const target = join(fakeRoot, "etc/pih-connectors/connectors.env");
  const configDirectoryEntries = async (): Promise<string[]> => {
    try {
      return await readdir(join(fakeRoot, "etc/pih-connectors"));
    } catch {
      return [];
    }
  };
  return { root, run, target, uploadDirectory, configDirectoryEntries, systemdRunLog: join(root, "systemd-run.log") };
};

const expectNoSecrets = (text: string): void => {
  for (const value of Object.values(secrets)) expect(text).not.toContain(value);
};

describe("configure-private-connectors.sh", () => {
  it("disables echo for every credential, validates, and writes a root-only file", async () => {
    const fixture = await setup();
    const report = await fixture.run(answersFor(fixture.uploadDirectory));
    expect(report.exhausted).toBe(false);
    expect(report.status).toBe(0);
    const hidden = report.prompts.filter(({ text }) => text.includes("(hidden)"));
    expect(hidden.map(({ text }) => text.replace(/ \(hidden\): $/u, ""))).toEqual([
      "Service credential map (compact JSON array)",
      "API key for HERMES_ORCHESTRATOR_API_KEY",
      "API key for HERMES_SPECIALIST_API_KEY",
      "Peer token for HERMES_SPECIALIST_PEER_TOKEN",
      "Google OAuth client ID",
      "Google OAuth client secret",
      "Calendar encryption keyring (compact JSON array)",
      "Calendar blind-index key (base64url, 32 bytes)",
    ]);
    for (const prompt of report.prompts) expect(prompt.echo).toBe(!prompt.text.includes("(hidden)"));
    expectNoSecrets(report.output);
    expect(report.output).toContain("configuration_valid");

    const written = await readFile(fixture.target, "utf8");
    expect((await stat(fixture.target)).mode & 0o777).toBe(0o600);
    expect(written).toContain(`CONNECTORS_SERVICE_CREDENTIALS_JSON='${secrets.credentials}'\n`);
    expect(written).toContain(`GOOGLE_CALENDAR_ENCRYPTION_KEYS_JSON='${secrets.keyring}'\n`);
    expect(written).toContain("CONNECTORS_SOCKET_PATH='/run/pih-connectors/web/connectors.sock'\n");
    expect(written).toContain("HERMES_DELEGATION_SOCKET_PATH='/run/pih-connectors/hermes-delegation.sock'\n");
    expect(written).toContain("GOOGLE_CALENDAR_OAUTH_REDIRECT_URI='https://pih.example.test/api/ui/v1/calendar/oauth/callback'\n");
    expect(written).not.toMatch(/TELEGRAM/u);
    expect(await fixture.configDirectoryEntries()).toEqual(["connectors.env"]);

    const systemdRun = await readFile(fixture.systemdRunLog, "utf8");
    expect(systemdRun).toContain("--production --require hermes --require calendar");
    expectNoSecrets(systemdRun);
  }, 90_000);

  it.each([
    ["a blank secret", { "Google OAuth client secret": "" }, "a blank credential is not allowed"],
    ["a non-loopback Hermes origin", { "Hermes loopback API origin": "http://192.0.2.10:8642" }, "HERMES_API_ORIGIN"],
    ["another BFF socket path", { "Host BFF socket path": "/run/pih-connectors/connectors.sock" }, "CONNECTORS_SOCKET_PATH"],
    ["another delegation socket path", { "Agent-only delegation socket path": "/run/pih-connectors/web/delegation.sock" }, "HERMES_DELEGATION_SOCKET_PATH"],
    ["an unknown default profile", { "Default gateway profile ID": "unknown-profile" }, "is not a configured profile"],
    ["an unknown peer profile", { "Delegation peers": peers.replace("specialist", "unknown-profile") }, "references an unknown profile"],
    ["a redirect outside the PIH origin", { "Google OAuth redirect URI": "https://other.example.test/api/ui/v1/calendar/oauth/callback" }, "GOOGLE_CALENDAR_OAUTH_REDIRECT_URI"],
    ["a single quote in a secret", { "Google OAuth client secret": "fictional'quoted-secret" }, "single quotes are not allowed"],
    ["a control character in a secret", { "Google OAuth client secret": "fictional\u0001control-secret" }, "control characters are not allowed"],
  ])("rejects %s before writing any file", async (_name, overrides, message) => {
    const fixture = await setup();
    const report = await fixture.run(answersFor(fixture.uploadDirectory, overrides));
    expect(report.status).toBe(1);
    expect(report.output).toContain(message);
    expect(report.output).toContain("Nothing was written");
    expectNoSecrets(report.output);
    expect(report.output).not.toContain("fictional'quoted-secret");
    expect(await fixture.configDirectoryEntries()).toEqual([]);
    await expect(readFile(fixture.systemdRunLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 90_000);

  it("refuses a world-readable candidate and leaves no file behind", async () => {
    const fixture = await setup({ fakeChmodMode: "0644" });
    const report = await fixture.run(answersFor(fixture.uploadDirectory));
    expect(report.status).toBe(1);
    expect(report.output).toContain("root:root mode 0600");
    expect(await fixture.configDirectoryEntries()).toEqual([]);
    await expect(readFile(fixture.systemdRunLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 90_000);

  it("keeps the existing file when the production validator rejects the candidate", async () => {
    const fixture = await setup();
    await mkdir(join(fixture.root, "fake-root/etc/pih-connectors"), { mode: 0o700 });
    await writeFile(fixture.target, "EXISTING='kept'\n", { mode: 0o600 });
    // A 31-byte key passes the shell alphabet check but fails the production parser.
    const report = await fixture.run(answersFor(fixture.uploadDirectory, {
      "Calendar encryption keyring": JSON.stringify([{ id: "fictional-key-1", key: Buffer.alloc(31, 9).toString("base64url") }]),
    }));
    expect(report.status).toBe(1);
    expect(report.output).toContain("configuration_invalid section=calendar");
    expect(report.output).toContain("Validation failed");
    expect(await readFile(fixture.target, "utf8")).toBe("EXISTING='kept'\n");
    expect(await fixture.configDirectoryEntries()).toEqual(["connectors.env"]);
    expectNoSecrets(report.output);
  }, 90_000);

  it("refuses non-interactive input and arguments", async () => {
    await expect(exec("sh", [script], { env: { PATH: process.env.PATH ?? "" } }))
      .rejects.toMatchObject({ code: 1 });
    await expect(exec("sh", [script, "--token", "fictional"], { env: { PATH: process.env.PATH ?? "" } }))
      .rejects.toMatchObject({ code: 64 });
  });
});
