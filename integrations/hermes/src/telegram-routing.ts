import { z } from "zod";

/**
 * Builds the native Hermes gateway multiplex block that routes exact Telegram
 * group chats to specialist profiles through the single bot owned by the
 * default profile. Direct messages and every unrouted chat stay on the default
 * profile. Optional: an installation with one default route needs none of this.
 *
 * The builder never sees the bot token or the sender allowlist; both remain
 * exclusively in the default profile's private configuration.
 */

const ProfileIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u);
/** Telegram group and supergroup chats have negative numeric IDs; positive IDs are users or private chats. */
const GroupChatIdSchema = z.string().regex(/^-[1-9][0-9]{0,18}$/u);
const MAX_SPECIALIST_ROUTES = 32;

const InputSchema = z.object({
  defaultProfileId: ProfileIdSchema,
  specialistRoutes: z.array(z.object({
    profileId: ProfileIdSchema,
    chatId: GroupChatIdSchema,
  }).strict()).min(1).max(MAX_SPECIALIST_ROUTES),
}).strict();

export type TelegramProfileRoutingInput = z.input<typeof InputSchema>;

export type TelegramProfileRoute = Readonly<{
  name: string;
  platform: "telegram";
  chat_id: string;
  profile: string;
}>;

export type TelegramProfileRoutes = Readonly<{
  multiplex_profiles: true;
  multiplex_profile_allowlist: readonly string[];
  profile_routes: readonly TelegramProfileRoute[];
}>;

/** Closed error text: never echoes chat IDs, profile IDs, or any other input. */
const invalid = (): never => {
  throw new Error("Telegram profile routing configuration is invalid");
};

export const buildTelegramProfileRoutes = (input: TelegramProfileRoutingInput): TelegramProfileRoutes => {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success) return invalid();
  const { defaultProfileId, specialistRoutes } = parsed.data;
  const profiles = new Set<string>([defaultProfileId]);
  const chats = new Set<string>();
  for (const route of specialistRoutes) {
    // The default profile already receives every unrouted chat; a duplicate profile or chat would make routing ambiguous.
    if (profiles.has(route.profileId) || chats.has(route.chatId)) return invalid();
    profiles.add(route.profileId);
    chats.add(route.chatId);
  }
  return Object.freeze({
    multiplex_profiles: true as const,
    multiplex_profile_allowlist: Object.freeze([defaultProfileId, ...specialistRoutes.map(({ profileId }) => profileId)]),
    profile_routes: Object.freeze(specialistRoutes.map(({ profileId, chatId }) => Object.freeze({
      name: `telegram-${profileId}`,
      platform: "telegram" as const,
      chat_id: chatId,
      profile: profileId,
    }))),
  });
};
