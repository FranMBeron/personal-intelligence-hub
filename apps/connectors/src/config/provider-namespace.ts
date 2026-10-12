import type { z } from "zod";

export interface ProviderConfigNamespace<Name extends string, T> {
  readonly name: Name;
  parse(
    environment: Readonly<Record<string, string | undefined>>,
  ): T | undefined;
}

export const providerNamespace = <Name extends string, T>(
  name: Name,
  schema: z.ZodType<T>,
  select: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => unknown,
): ProviderConfigNamespace<Name, T> => ({
  name,
  parse(environment) {
    const selected = select(environment);
    return selected === undefined ? undefined : schema.parse(selected);
  },
});
