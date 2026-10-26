import { inspect } from "node:util";

import type { HermesConfig, HermesProfile, HermesProfileCredential } from "./config.js";

export class HermesProfileRegistry {
  readonly config: HermesConfig;
  readonly #apiOrigin: string;
  readonly #profiles: ReadonlyMap<string, Readonly<{
    profile: HermesProfile;
    credential: HermesProfileCredential;
  }>>;

  constructor(config: HermesConfig) {
    this.config = config;
    this.#apiOrigin = config.apiOrigin.href;
    this.#profiles = new Map(config.profiles.map((entry) => [entry.profile.id, entry]));
    Object.freeze(this);
  }

  list(): readonly HermesProfile[] {
    return Object.freeze([...this.#profiles.values()].map(({ profile }) => profile));
  }

  default(): HermesProfile {
    return this.require(this.config.defaultProfileId);
  }

  require(profileId: string): HermesProfile {
    const entry = this.#profiles.get(profileId);
    if (entry === undefined) {
      throw new Error("Hermes profile is not configured");
    }
    return entry.profile;
  }

  credential(profileId: string): HermesProfileCredential {
    const entry = this.#profiles.get(profileId);
    if (entry === undefined) {
      throw new Error("Hermes profile is not configured");
    }
    return entry.credential;
  }

  profileBaseUrl(profileId: string): URL {
    const profile = this.require(profileId);
    return new URL(`/p/${encodeURIComponent(profile.id)}/`, this.#apiOrigin);
  }

  [inspect.custom](): string {
    const capabilities = this.list().map(({ capabilities }) => capabilities);
    return `HermesProfileRegistry ${JSON.stringify({
      profileCount: capabilities.length,
      defaultProfileConfigured: this.#profiles.has(this.config.defaultProfileId),
      capabilities: {
        directConversations: capabilities.some(({ directConversations }) => directConversations),
        images: capabilities.some(({ images }) => images),
        delegationTarget: capabilities.some(({ delegationTarget }) => delegationTarget),
      },
    })}`;
  }
}
