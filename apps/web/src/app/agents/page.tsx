import { Icon } from "../_components/icon";
import { PageHeader } from "../_components/app-shell";
import { AgentRosterSection } from "./_components/agent-roster-section";
import type { RosterResult } from "./_lib/agents-view";
import { loadHermesPageData, pageRequestContext } from "../../server/page-data";
import { serverRuntime } from "../../server/runtime";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const context = await pageRequestContext();
  const { capabilities, agents } = await loadHermesPageData(context);
  const result: RosterResult = agents.state === "loaded"
    ? { state: "available", agents: agents.value }
    : { state: agents.state };

  return (
    <div className="agents-page">
      <PageHeader
        title="Agentes"
        description="Estado, trabajo actual y acceso directo."
        aside={serverRuntime.hermesDashboardUrl === undefined ? undefined : (
          <a className="button button--quiet" href={serverRuntime.hermesDashboardUrl} target="_blank" rel="noopener noreferrer">
            Administrar en Hermes <Icon name="arrow-up-right" />
          </a>
        )}
      />
      <AgentRosterSection
        result={result}
        capabilities={capabilities.state === "loaded" ? capabilities.value : null}
      />
    </div>
  );
}
