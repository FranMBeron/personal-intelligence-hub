import "server-only";

import { serverConfig } from "../config/server";
import { HttpHermesGateway } from "./adapters/http-hermes-gateway";
import { HttpPersonalDataGateway } from "./adapters/http-personal-data-gateway";
import type { HermesGateway } from "./ports/hermes-gateway";
import type { PersonalDataGateway } from "./ports/personal-data-gateway";

export type ServerRuntime = Readonly<{
  personalData: PersonalDataGateway;
  hermes: HermesGateway | null;
  hermesDashboardUrl?: string;
}>;

export const serverRuntime: ServerRuntime = Object.freeze({
  personalData: new HttpPersonalDataGateway({
    baseUrl: serverConfig.pihApiInternalUrl,
  }),
  hermes:
    serverConfig.hermesInternalUrl !== undefined &&
    serverConfig.hermesServiceToken !== undefined
      ? new HttpHermesGateway({
          baseUrl: serverConfig.hermesInternalUrl,
          serviceToken: serverConfig.hermesServiceToken,
        })
      : null,
  ...(serverConfig.hermesDashboardUrl === undefined
    ? {}
    : { hermesDashboardUrl: serverConfig.hermesDashboardUrl }),
});
