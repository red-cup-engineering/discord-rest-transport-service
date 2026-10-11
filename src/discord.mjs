import { isObjectRecord } from "@red-cup-engineering/json-services-section";

function env(name, source = process.env) {
  const value = source[name];
  return value === undefined || value.length === 0 ? undefined : value;
}
import { discordChannelCarrier, discordCommandCarrier, discordEmojiCarrier, discordGuildBoostStatusCarrier, discordGuildCarrier, discordMessageCarrier, discordPermissionOverwriteCarrier, discordRoleCarrier, discordStickerCarrier, discordUserCarrier, discordChannelTypes, discordOnboardingCarrier } from "./discord-codecs.mjs";

export const discordPermissions = Object.freeze({
  addReactions: 1n << 6n,
  viewChannel: 1n << 10n,
  sendMessages: 1n << 11n,
  manageMessages: 1n << 13n,
  embedLinks: 1n << 14n,
  attachFiles: 1n << 15n,
  readMessageHistory: 1n << 16n,
  connect: 1n << 20n,
  createPublicThreads: 1n << 35n,
  createPrivateThreads: 1n << 36n,
  sendMessagesInThreads: 1n << 38n,
  manageRoles: 1n << 28n,
  manageChannels: 1n << 4n,
  useApplicationCommands: 1n << 31n,
  manageGuildExpressions: 1n << 30n,
  createGuildExpressions: 1n << 43n,
});

// Custom expression slots by boost tier, as Discord publishes them. Static
// and animated emoji are counted separately, each against `emoji`. The table
// is a projection for planning; Discord's own refusal (error 30008 for emoji,
// 30039 for stickers) is the authority when the two disagree.
export const discordGuildExpressionLimits = Object.freeze({
  0: Object.freeze({ emoji: 50, sticker: 5 }),
  1: Object.freeze({ emoji: 100, sticker: 15 }),
  2: Object.freeze({ emoji: 150, sticker: 30 }),
  3: Object.freeze({ emoji: 250, sticker: 60 }),
});

export const discordExpressionLimitErrorCodes = Object.freeze({ emoji: 30008, sticker: 30039 });

export function inviteUrl(clientId, permissionBits) {
  const params = new URLSearchParams({
    client_id: clientId,
    scope: "bot applications.commands",
    permissions: permissionBits.toString(),
  });
  return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

export function normalizedName(value) {
  return value.trim().toLowerCase();
}

export function botToken(source = process.env) {
  return env("DISCORD_BOT_TOKEN", source) ?? env("DISCORD_TOKEN", source);
}

export class DiscordRestTransport {
  #token;
  #apiBase;
  #userAgent;

  constructor(options = {}) {
    const token = options.token ?? botToken(options.env);
    if (token === undefined) throw new Error("DISCORD_BOT_TOKEN or DISCORD_TOKEN is required");
    this.#token = token;
    this.#apiBase = options.apiBase ?? "https://discord.com/api/v10";
    this.#userAgent = options.userAgent ?? "@red-cup-engineering/discord-rest-transport-service";
  }

  async getApplicationId() {
    const app = await this.#request("GET", "/oauth2/applications/@me");
    const id = stringField(app, "id");
    if (id === "") throw new Error("Discord application response did not include id");
    return id;
  }

  async getCurrentUser() {
    const user = await this.#request("GET", "/users/@me");
    return userFromWire(user);
  }

  async getGuild(guildId) {
    const guild = await this.#request("GET", `/guilds/${guildId}`);
    return guildFromWire(guild);
  }

  async listGuilds() {
    const guilds = await this.#request("GET", "/users/@me/guilds");
    return guilds.map((entry) => guildFromWire(record(entry)));
  }

  async listChannels(guildId) {
    const channels = await this.#request("GET", `/guilds/${guildId}/channels`);
    return channels.map((entry) => channelFromWire(record(entry)));
  }

  async createChannel(guildId, channel) {
    const created = await this.#request("POST", `/guilds/${guildId}/channels`, channelToWire(channel));
    return channelFromWire(created);
  }

  async modifyChannel(channelId, patch) {
    const updated = await this.#request("PATCH", `/channels/${channelId}`, channelToWire(patch));
    return channelFromWire(updated);
  }

  /** Move channels between categories and reorder them in one call; `lockPermissions` syncs a moved channel to its new category. */
  async modifyChannelPositions(guildId, placements) {
    await this.#request("PATCH", `/guilds/${guildId}/channels`, placements.map((placement) => ({
      id: placement.id,
      ...(placement.position === undefined ? {} : { position: placement.position }),
      ...(placement.parentId === undefined ? {} : { parent_id: placement.parentId }),
      ...(placement.lockPermissions === undefined ? {} : { lock_permissions: placement.lockPermissions }),
    })));
  }

  async getGuildOnboarding(guildId) {
    return onboardingFromWire(await this.#request("GET", `/guilds/${guildId}/onboarding`));
  }

  /** Replace the guild's onboarding whole: Discord drops any prompt the request leaves out. */
  async putGuildOnboarding(guildId, onboarding, reason) {
    return onboardingFromWire(await this.#request("PUT", `/guilds/${guildId}/onboarding`, onboardingToWire(onboarding), reason));
  }

  async listRoles(guildId) {
    const roles = await this.#request("GET", `/guilds/${guildId}/roles`);
    return roles.map((entry) => roleFromWire(record(entry)));
  }

  async listGuildMemberRoleIds(guildId, userId) {
    const member = await this.#request("GET", `/guilds/${guildId}/members/${userId}`);
    return Array.isArray(member["roles"]) ? member["roles"].filter((value) => typeof value === "string") : [];
  }

  async createRole(guildId, role) {
    const created = await this.#request("POST", `/guilds/${guildId}/roles`, role);
    return roleFromWire(created);
  }

  async listCommands(applicationId, guildId) {
    const commands = await this.#request("GET", `/applications/${applicationId}/guilds/${guildId}/commands`);
    return commands.map((entry) => commandFromWire(record(entry)));
  }

  async registerCommand(applicationId, guildId, command) {
    const created = await this.#request("POST", `/applications/${applicationId}/guilds/${guildId}/commands`, commandToWire(command));
    return commandFromWire(created);
  }

  async updateCommand(applicationId, guildId, commandId, command) {
    const updated = await this.#request("PATCH", `/applications/${applicationId}/guilds/${guildId}/commands/${commandId}`, commandToWire(command));
    return commandFromWire(updated);
  }

  async listMessages(channelId, limit) {
    const messages = await this.#request("GET", `/channels/${channelId}/messages?limit=${Math.min(100, Math.max(1, limit))}`);
    return messages.map((entry) => messageFromWire(record(entry), channelId));
  }

  async createDirectMessageChannel(userId) {
    const channel = await this.#request("POST", "/users/@me/channels", { recipient_id: userId });
    const id = stringField(channel, "id");
    if (id === "") throw new Error("Discord create-DM response did not include a channel id");
    return id;
  }

  async createMessage(channelId, input, options = {}) {
    const files = typeof input === "string" ? undefined : input.files;
    const body = typeof input === "string" ? { content: input } : {
      content: input.content,
      allowed_mentions: input.allowedMentions === undefined ? undefined : { users: input.allowedMentions.users ?? [] },
    };
    const created =
      files === undefined || files.length === 0
        ? await this.#request("POST", `/channels/${channelId}/messages`, body, undefined, options.headers)
        : await this.#requestMultipart("POST", `/channels/${channelId}/messages`, body, files);
    return messageFromWire(created, channelId);
  }

  async deleteMessage(channelId, messageId) {
    await this.#request("DELETE", `/channels/${channelId}/messages/${messageId}`);
  }

  async timeoutGuildMember(guildId, userId, timeoutUntil, reason) {
    await this.#request("PATCH", `/guilds/${guildId}/members/${userId}`, { communication_disabled_until: timeoutUntil }, reason);
  }

  async banGuildMember(guildId, userId, options = {}) {
    const seconds = options.deleteMessageSeconds;
    if (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 0 || seconds > 604800)) throw new RangeError("deleteMessageSeconds must be an integer from 0 through 604800");
    await this.#request("PUT", `/guilds/${guildId}/bans/${userId}`, seconds === undefined ? undefined : { delete_message_seconds: seconds }, options.reason);
  }

  async unbanGuildMember(guildId, userId, reason) {
    await this.#request("DELETE", `/guilds/${guildId}/bans/${userId}`, undefined, reason);
  }

  async listAutoModerationRules(guildId) {
    const rules = await this.#request("GET", `/guilds/${guildId}/auto-moderation/rules`);
    return rules.map((entry) => autoModerationRuleFromWire(record(entry)));
  }

  async createAutoModerationRule(guildId, rule) {
    const created = await this.#request("POST", `/guilds/${guildId}/auto-moderation/rules`, autoModerationRuleToWire(rule));
    return autoModerationRuleFromWire(created);
  }

  async updateAutoModerationRule(guildId, ruleId, rule) {
    const updated = await this.#request("PATCH", `/guilds/${guildId}/auto-moderation/rules/${ruleId}`, autoModerationRuleToWire(rule));
    return autoModerationRuleFromWire(updated);
  }

  async getGuildBoostStatus(guildId) {
    const guild = await this.#request("GET", `/guilds/${guildId}`);
    return guildBoostStatusFromWire(guild);
  }

  async listGuildEmojis(guildId) {
    const emojis = await this.#request("GET", `/guilds/${guildId}/emojis`);
    return emojis.map((entry) => emojiFromWire(record(entry)));
  }

  async createGuildEmoji(guildId, emoji, reason) {
    const image = `data:${emoji.image.contentType};base64,${Buffer.from(emoji.image.data).toString("base64")}`;
    const created = await this.#request("POST", `/guilds/${guildId}/emojis`, { name: emoji.name, image, roles: emoji.roleIds ?? [] }, reason);
    return emojiFromWire(created);
  }

  async listGuildStickers(guildId) {
    const stickers = await this.#request("GET", `/guilds/${guildId}/stickers`);
    return stickers.map((entry) => stickerFromWire(record(entry)));
  }

  async createGuildSticker(guildId, sticker, reason) {
    const form = new FormData();
    form.append("name", sticker.name);
    form.append("description", sticker.description ?? "");
    form.append("tags", sticker.tags);
    form.append("file", new Blob([sticker.file.data], { type: sticker.file.contentType }), sticker.file.name);
    const created = await this.#requestForm("POST", `/guilds/${guildId}/stickers`, form, reason);
    return stickerFromWire(created);
  }

  // Discord's file-attachment upload is a multipart/form-data POST with the
  // JSON payload as a `payload_json` field alongside one `files[n]` field per
  // attachment — distinct from #request's plain JSON body path above, which
  // Discord's own message-create endpoint does not accept files through.
  async #requestMultipart(
    method,
    route,
    jsonBody,
    files,
  ) {
    const form = new FormData();
    form.append("payload_json", JSON.stringify(jsonBody));
    files.forEach((file, index) => {
      form.append(`files[${index}]`, new Blob([file.data], { type: file.contentType ?? "application/octet-stream" }), file.name);
    });
    return this.#requestForm(method, route, form);
  }

  async #requestForm(method, route, form, reason) {
    const res = await fetch(`${this.#apiBase}${route}`, {
      method,
      headers: {
        authorization: `Bot ${this.#token}`,
        "user-agent": this.#userAgent,
        ...(reason === undefined ? {} : { "x-audit-log-reason": encodeURIComponent(reason) }),
      },
      body: form,
    });
    if (res.status === 429) {
      const retry = await res.json().catch(() => ({ retry_after: 1 }));
      await new Promise((resolve) => setTimeout(resolve, Math.ceil((retry.retry_after ?? 1) * 1000)));
      return this.#requestForm(method, route, form, reason);
    }
    const text = await res.text();
    if (!res.ok) throw discordError(method, `${route} (multipart)`, res.status, text);
    return text.length === 0 ? null : JSON.parse(text);
  }

  async addGuildMemberRole(guildId, userId, roleId) {
    await this.#request("PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }

  async removeGuildMemberRole(guildId, userId, roleId) {
    await this.#request("DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
  }

  async #request(method, route, body, reason, extraHeaders) {
    const res = await fetch(`${this.#apiBase}${route}`, {
      method,
      headers: {
        authorization: `Bot ${this.#token}`,
        "content-type": "application/json",
        "user-agent": this.#userAgent,
        ...(reason === undefined ? {} : { "x-audit-log-reason": encodeURIComponent(reason) }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const retry = await res.json().catch(() => ({ retry_after: 1 }));
      await new Promise((resolve) => setTimeout(resolve, Math.ceil((retry.retry_after ?? 1) * 1000)));
      return this.#request(method, route, body, reason, extraHeaders);
    }
    const text = await res.text();
    if (!res.ok) throw discordError(method, route, res.status, text);
    return text.length === 0 ? null : JSON.parse(text);
  }
}

// A refused request keeps Discord's JSON error code, so callers can tell a
// full expression slot (30008, 30039) from any other refusal.
function discordError(method, route, status, text) {
  const error = new Error(`Discord ${method} ${route} -> ${status}: ${text.slice(0, 400)}`);
  error.status = status;
  try {
    const code = JSON.parse(text)?.code;
    if (Number.isInteger(code)) error.discordCode = code;
  } catch {}
  return error;
}

export class InMemoryDiscordTransport {
  applicationId;
  currentUser;
  guilds = new Map();
  channels = new Map();
  roles = new Map();
  commands = new Map();
  messages = new Map();
  memberRoles = new Map();
  filesReceived = new Map();
  directRecipients = new Map();
  autoModerationRules = new Map();
  memberTimeouts = new Map();
  bannedMembers = new Map();
  emojis = new Map();
  stickers = new Map();
  onboarding = new Map();
  premiumTier;
  #sequence = 0;

  constructor(options = {}) {
    this.applicationId = options.applicationId ?? "app-discord";
    this.currentUser = options.currentUser ?? { id: "bot-discord", username: "Discord Bot", bot: true };
    const guild = options.guild ?? { id: "guild-discord", name: "Discord Guild", ownerId: "owner" };
    this.guilds.set(guild.id, guild);
    this.roles.set(guild.id, { id: guild.id, guildId: guild.id, name: "@everyone", permissions: "0" });
    this.premiumTier = options.premiumTier ?? 0;
  }

  async getApplicationId() {
    return this.applicationId;
  }

  async getCurrentUser() {
    return this.currentUser;
  }

  async getGuild(guildId) {
    const guild = this.guilds.get(guildId);
    if (guild === undefined) throw new Error(`unknown guild ${guildId}`);
    return guild;
  }

  async listGuilds() {
    return [...this.guilds.values()];
  }

  async listChannels(guildId) {
    return [...this.channels.values()].filter((channel) => channel.guildId === guildId);
  }

  async createChannel(guildId, channel) {
    const id = this.#id("channel", channel.name);
    const created = Object.freeze({ id, guildId, name: channel.name, topic: channel.topic, permissionOverwrites: channel.permissionOverwrites, type: channel.type ?? "text", parentId: channel.parentId ?? null, position: channel.position ?? this.channels.size });
    this.channels.set(id, created);
    this.messages.set(id, []);
    return created;
  }

  async modifyChannel(channelId, patch) {
    const existing = this.channels.get(channelId);
    if (existing === undefined) throw new Error(`unknown channel ${channelId}`);
    const updated = Object.freeze({ ...existing, ...patch });
    this.channels.set(channelId, updated);
    return updated;
  }

  async modifyChannelPositions(guildId, placements) {
    for (const placement of placements) {
      const existing = this.channels.get(placement.id);
      if (existing === undefined || existing.guildId !== guildId) throw new Error(`unknown channel ${placement.id}`);
      this.channels.set(placement.id, Object.freeze({
        ...existing,
        ...(placement.position === undefined ? {} : { position: placement.position }),
        ...(placement.parentId === undefined ? {} : { parentId: placement.parentId }),
      }));
    }
  }

  async getGuildOnboarding(guildId) {
    await this.getGuild(guildId);
    return this.onboarding.get(guildId) ?? Object.freeze({ enabled: false, mode: 0, defaultChannelIds: [], prompts: [] });
  }

  async putGuildOnboarding(guildId, onboarding) {
    await this.getGuild(guildId);
    const stored = Object.freeze({ ...onboarding, prompts: onboarding.prompts.map((prompt, index) => ({ id: prompt.id ?? `prompt-${index}`, ...prompt })) });
    this.onboarding.set(guildId, stored);
    return stored;
  }

  async listRoles(guildId) {
    return [...this.roles.values()].filter((role) => role.guildId === guildId);
  }

  async listGuildMemberRoleIds(guildId, userId) {
    await this.getGuild(guildId);
    return Object.freeze([...(this.memberRoles.get(`${guildId}:${userId}`) ?? new Set())]);
  }

  async createRole(guildId, role) {
    const id = this.#id("role", role.name);
    const created = Object.freeze({ id, guildId, name: role.name, permissions: "0", managed: false, position: this.roles.size });
    this.roles.set(id, created);
    return created;
  }

  async listCommands(applicationId, guildId) {
    return [...this.commands.values()].filter((command) => command.applicationId === applicationId && command.guildId === guildId);
  }

  async registerCommand(applicationId, guildId, command) {
    const id = this.#id("command", command.name);
    const created = Object.freeze({ id, applicationId, guildId, name: command.name, description: command.description, options: command.options, defaultMemberPermissions: command.defaultMemberPermissions, dmPermission: command.dmPermission });
    this.commands.set(id, created);
    return created;
  }

  async updateCommand(applicationId, guildId, commandId, command) {
    const existing = this.commands.get(commandId);
    if (existing === undefined) throw new Error(`unknown command ${commandId}`);
    const updated = Object.freeze({ ...existing, name: command.name, description: command.description, options: command.options, defaultMemberPermissions: command.defaultMemberPermissions, dmPermission: command.dmPermission });
    this.commands.set(commandId, updated);
    return updated;
  }

  async listMessages(channelId, limit) {
    return [...(this.messages.get(channelId) ?? [])].slice(0, Math.max(1, limit));
  }

  async createDirectMessageChannel(userId) {
    const existing = [...this.directRecipients.entries()].find(([, recipient]) => recipient === userId)?.[0];
    if (existing !== undefined) return existing;
    const channelId = this.#id("dm", userId);
    this.directRecipients.set(channelId, userId);
    this.messages.set(channelId, []);
    return channelId;
  }

  async createMessage(channelId, input, _options = {}) {
    const content = typeof input === "string" ? input : input.content;
    const message = Object.freeze({
      id: this.#id("message", channelId),
      channelId,
      authorId: this.currentUser.id,
      authorName: this.currentUser.username,
      authorBot: this.currentUser.bot ?? false,
      content,
      timestamp: new Date().toISOString(),
      mentionedUserIds: Object.freeze([...content.matchAll(/<@!?(\w[\w-]*)>/gu)].map((match) => match[1])),
    });
    this.messages.set(channelId, [message, ...(this.messages.get(channelId) ?? [])]);
    if (typeof input !== "string" && input.files !== undefined && input.files.length > 0) {
      this.filesReceived.set(message.id, input.files);
    }
    return message;
  }

  async deleteMessage(channelId, messageId) {
    const messages = this.messages.get(channelId) ?? [];
    if (!messages.some((message) => message.id === messageId)) throw new Error(`unknown message ${messageId}`);
    this.messages.set(channelId, messages.filter((message) => message.id !== messageId));
  }

  async timeoutGuildMember(guildId, userId, timeoutUntil) {
    await this.getGuild(guildId);
    this.memberTimeouts.set(`${guildId}:${userId}`, timeoutUntil);
  }

  async banGuildMember(guildId, userId, options = {}) {
    await this.getGuild(guildId);
    const seconds = options.deleteMessageSeconds ?? 0;
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 604800) throw new RangeError("deleteMessageSeconds must be an integer from 0 through 604800");
    this.bannedMembers.set(`${guildId}:${userId}`, Object.freeze({ deleteMessageSeconds: seconds, reason: options.reason }));
  }

  async unbanGuildMember(guildId, userId) {
    await this.getGuild(guildId);
    this.bannedMembers.delete(`${guildId}:${userId}`);
  }

  async listAutoModerationRules(guildId) {
    return [...this.autoModerationRules.values()].filter((rule) => rule.guildId === guildId);
  }

  async createAutoModerationRule(guildId, rule) {
    await this.getGuild(guildId);
    const created = Object.freeze({ id: this.#id("automod", rule.name), guildId, ...copyAutoModerationRuleSpec(rule) });
    this.autoModerationRules.set(created.id, created);
    return created;
  }

  async updateAutoModerationRule(guildId, ruleId, rule) {
    const existing = this.autoModerationRules.get(ruleId);
    if (existing === undefined || existing.guildId !== guildId) throw new Error(`unknown auto moderation rule ${ruleId}`);
    const updated = Object.freeze({ id: ruleId, guildId, ...copyAutoModerationRuleSpec(rule) });
    this.autoModerationRules.set(ruleId, updated);
    return updated;
  }

  async getGuildBoostStatus(guildId) {
    await this.getGuild(guildId);
    return { guildId, premiumTier: this.premiumTier, boostCount: [0, 2, 7, 14][this.premiumTier] };
  }

  // Past a tier's limit Discord keeps the oldest expressions usable and marks
  // the rest unavailable; the in-memory guild mirrors that by upload order.
  async listGuildEmojis(guildId) {
    await this.getGuild(guildId);
    const limit = discordGuildExpressionLimits[this.premiumTier].emoji;
    const all = [...this.emojis.values()].filter((emoji) => emoji.guildId === guildId);
    return all.map((emoji) => ({ ...emoji, available: all.filter((other) => other.animated === emoji.animated).indexOf(emoji) < limit }));
  }

  async createGuildEmoji(guildId, emoji) {
    await this.getGuild(guildId);
    const animated = emoji.image.contentType === "image/gif" || emoji.animated === true;
    const used = [...this.emojis.values()].filter((entry) => entry.guildId === guildId && entry.animated === animated).length;
    if (used >= discordGuildExpressionLimits[this.premiumTier].emoji) throw Object.assign(new Error("Maximum number of emojis reached"), { status: 400, discordCode: discordExpressionLimitErrorCodes.emoji });
    const created = Object.freeze({ id: this.#id("emoji", emoji.name), guildId, name: emoji.name, animated, available: true });
    this.emojis.set(created.id, created);
    return created;
  }

  async listGuildStickers(guildId) {
    await this.getGuild(guildId);
    const limit = discordGuildExpressionLimits[this.premiumTier].sticker;
    return [...this.stickers.values()].filter((sticker) => sticker.guildId === guildId).map((sticker, index) => ({ ...sticker, available: index < limit }));
  }

  async createGuildSticker(guildId, sticker) {
    await this.getGuild(guildId);
    const used = [...this.stickers.values()].filter((entry) => entry.guildId === guildId).length;
    if (used >= discordGuildExpressionLimits[this.premiumTier].sticker) throw Object.assign(new Error("Maximum number of stickers reached"), { status: 400, discordCode: discordExpressionLimitErrorCodes.sticker });
    const created = Object.freeze({ id: this.#id("sticker", sticker.name), guildId, name: sticker.name, description: sticker.description, tags: sticker.tags, format: "png", available: true });
    this.stickers.set(created.id, created);
    return created;
  }

  seedUserMessage(channelId, content, user = { id: "member-discord", username: "member" }) {
    const message = Object.freeze({
      id: this.#id("message", channelId),
      channelId,
      authorId: user.id,
      authorName: user.username,
      authorBot: user.bot ?? false,
      content,
      timestamp: new Date().toISOString(),
      mentionedUserIds: Object.freeze([...content.matchAll(/<@!?(\w[\w-]*)>/gu)].map((match) => match[1])),
    });
    this.messages.set(channelId, [message, ...(this.messages.get(channelId) ?? [])]);
    return message;
  }

  async addGuildMemberRole(guildId, userId, roleId) {
    const key = `${guildId}:${userId}`;
    const roles = this.memberRoles.get(key) ?? new Set();
    roles.add(roleId);
    this.memberRoles.set(key, roles);
  }

  async removeGuildMemberRole(guildId, userId, roleId) {
    this.memberRoles.get(`${guildId}:${userId}`)?.delete(roleId);
  }

  memberHasRole(guildId, userId, roleId) {
    return this.memberRoles.get(`${guildId}:${userId}`)?.has(roleId) ?? false;
  }

  #id(kind, name) {
    this.#sequence += 1;
    return `${kind}-${normalizedName(name).replace(/[^a-z0-9]+/gu, "-")}-${this.#sequence}`;
  }
}

const channelTypeNames = Object.freeze(Object.fromEntries(Object.entries(discordChannelTypes).map(([name, code]) => [code, name])));

function channelToWire(channel) {
  if (channel.type !== undefined && discordChannelTypes[channel.type] === undefined) throw new TypeError(`unknown Discord channel type ${channel.type}`);
  return {
    ...(channel.name === undefined ? {} : { name: channel.name }),
    ...(channel.type === undefined ? {} : { type: discordChannelTypes[channel.type] }),
    ...(channel.topic === undefined ? {} : { topic: channel.topic }),
    ...(channel.parentId === undefined ? {} : { parent_id: channel.parentId }),
    ...(channel.position === undefined ? {} : { position: channel.position }),
    ...(channel.permissionOverwrites === undefined ? {} : {
      permission_overwrites: channel.permissionOverwrites.map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type === "role" ? 0 : 1,
        allow: overwrite.allow,
        deny: overwrite.deny,
      })),
    }),
  };
}

function guildFromWire(raw) {
  const candidate = { id: stringField(raw, "id"), name: stringField(raw, "name"), ownerId: optionalStringField(raw, "owner_id") };
  discordGuildCarrier.assert({ kind: "discord.guild", ...candidate }, "Discord guild");
  return candidate;
}

function guildBoostStatusFromWire(raw) {
  const candidate = {
    guildId: stringField(raw, "id"),
    premiumTier: typeof raw["premium_tier"] === "number" ? raw["premium_tier"] : 0,
    boostCount: typeof raw["premium_subscription_count"] === "number" ? raw["premium_subscription_count"] : 0,
  };
  discordGuildBoostStatusCarrier.assert({ kind: "discord.guild-boost-status", ...candidate }, "Discord guild boost status");
  return candidate;
}

function emojiFromWire(raw) {
  const candidate = { id: stringField(raw, "id"), name: stringField(raw, "name"), animated: raw["animated"] === true, available: raw["available"] !== false };
  discordEmojiCarrier.assert({ kind: "discord.emoji", ...candidate }, "Discord emoji");
  return candidate;
}

const stickerFormats = { 1: "png", 2: "apng", 3: "lottie", 4: "gif" };

function stickerFromWire(raw) {
  const candidate = {
    id: stringField(raw, "id"),
    name: stringField(raw, "name"),
    description: optionalStringField(raw, "description"),
    tags: stringField(raw, "tags"),
    format: stickerFormats[raw["format_type"]] ?? "png",
    available: raw["available"] !== false,
  };
  discordStickerCarrier.assert({ kind: "discord.sticker", ...candidate }, "Discord sticker");
  return candidate;
}

function userFromWire(raw) {
  const candidate = { id: stringField(raw, "id"), username: stringField(raw, "username"), bot: raw["bot"] === true };
  discordUserCarrier.assert({ kind: "discord.user", ...candidate }, "Discord user");
  return candidate;
}

function roleFromWire(raw) {
  const candidate = {
    id: stringField(raw, "id"),
    name: stringField(raw, "name"),
    permissions: optionalStringField(raw, "permissions"),
    managed: raw["managed"] === true,
    position: typeof raw["position"] === "number" ? raw["position"] : undefined,
  };
  discordRoleCarrier.assert({ kind: "discord.role", ...candidate }, "Discord role");
  return candidate;
}

function commandToWire(command) {
  return {
    name: command.name,
    description: command.description,
    type: 1,
    ...(command.defaultMemberPermissions === undefined ? {} : { default_member_permissions: command.defaultMemberPermissions }),
    ...(command.dmPermission === undefined ? {} : { dm_permission: command.dmPermission }),
    ...(command.options === undefined ? {} : {
      options: command.options.map((option) => ({
        type: 3,
        name: option.name,
        description: option.description,
        required: option.required ?? false,
      })),
    }),
  };
}

const autoModerationTriggerTypeToWire = {
  keyword: 1,
  "harmful-link": 2,
  spam: 3,
  "keyword-preset": 4,
  "mention-spam": 5,
};

const autoModerationActionTypeToWire = {
  "block-message": 1,
  "send-alert": 2,
  timeout: 3,
};

function autoModerationRuleToWire(rule) {
  if (rule.name.trim() === "") throw new TypeError("AutoMod rule name must not be empty");
  if (rule.actions.length === 0) throw new TypeError("AutoMod rule must contain at least one action");
  return {
    name: rule.name,
    event_type: 1,
    trigger_type: autoModerationTriggerTypeToWire[rule.triggerType],
    ...(rule.triggerMetadata === undefined ? {} : { trigger_metadata: rule.triggerMetadata }),
    actions: rule.actions.map(autoModerationActionToWire),
    enabled: rule.enabled,
    exempt_roles: rule.exemptRoleIds ?? [],
    exempt_channels: rule.exemptChannelIds ?? [],
  };
}

function autoModerationActionToWire(action) {
  if (action.durationSeconds !== undefined && (!Number.isInteger(action.durationSeconds) || action.durationSeconds < 0)) {
    throw new RangeError("AutoMod timeout durationSeconds must be a non-negative integer");
  }
  return {
    type: autoModerationActionTypeToWire[action.type],
    metadata: {
      ...(action.channelId === undefined ? {} : { channel_id: action.channelId }),
      ...(action.durationSeconds === undefined ? {} : { duration_seconds: action.durationSeconds }),
      ...(action.customMessage === undefined ? {} : { custom_message: action.customMessage }),
    },
  };
}

function autoModerationRuleFromWire(raw) {
  const triggerType = autoModerationTriggerTypeFromWire(raw["trigger_type"]);
  const actions = Array.isArray(raw["actions"])
    ? raw["actions"].map((entry) => autoModerationActionFromWire(record(entry)))
    : [];
  if (actions.length === 0) throw new Error("Discord AutoMod rule did not include actions");
  return {
    id: stringField(raw, "id"),
    guildId: stringField(raw, "guild_id"),
    name: stringField(raw, "name"),
    triggerType,
    ...(raw["trigger_metadata"] === undefined ? {} : { triggerMetadata: record(raw["trigger_metadata"]) }),
    actions,
    enabled: raw["enabled"] === true,
    exemptRoleIds: stringArrayField(raw["exempt_roles"]),
    exemptChannelIds: stringArrayField(raw["exempt_channels"]),
  };
}

function autoModerationTriggerTypeFromWire(value) {
  switch (value) {
    case 1: return "keyword";
    case 2: return "harmful-link";
    case 3: return "spam";
    case 4: return "keyword-preset";
    case 5: return "mention-spam";
    default: throw new Error(`Unsupported Discord AutoMod trigger type ${String(value)}`);
  }
}

function autoModerationActionFromWire(raw) {
  const type = autoModerationActionTypeFromWire(raw["type"]);
  const metadata = record(raw["metadata"]);
  const durationSeconds = metadata["duration_seconds"];
  return {
    type,
    ...(optionalStringField(metadata, "channel_id") === undefined ? {} : { channelId: optionalStringField(metadata, "channel_id") }),
    ...(typeof durationSeconds === "number" ? { durationSeconds } : {}),
    ...(optionalStringField(metadata, "custom_message") === undefined ? {} : { customMessage: optionalStringField(metadata, "custom_message") }),
  };
}

function autoModerationActionTypeFromWire(value) {
  switch (value) {
    case 1: return "block-message";
    case 2: return "send-alert";
    case 3: return "timeout";
    default: throw new Error(`Unsupported Discord AutoMod action type ${String(value)}`);
  }
}

function copyAutoModerationRuleSpec(rule) {
  autoModerationRuleToWire(rule);
  return Object.freeze({
    ...rule,
    ...(rule.triggerMetadata === undefined ? {} : { triggerMetadata: Object.freeze({ ...rule.triggerMetadata }) }),
    actions: Object.freeze(rule.actions.map((action) => Object.freeze({ ...action }))),
    ...(rule.exemptRoleIds === undefined ? {} : { exemptRoleIds: Object.freeze([...rule.exemptRoleIds]) }),
    ...(rule.exemptChannelIds === undefined ? {} : { exemptChannelIds: Object.freeze([...rule.exemptChannelIds]) }),
  });
}

function stringArrayField(value) {
  return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
}

function commandFromWire(raw) {
  const options = Array.isArray(raw["options"])
    ? raw["options"].map((entry) => {
        const option = record(entry);
        return { name: stringField(option, "name"), description: stringField(option, "description"), required: option["required"] === true };
      })
    : undefined;
  const candidate = {
    id: stringField(raw, "id"),
    name: stringField(raw, "name"),
    description: stringField(raw, "description"),
    options,
    defaultMemberPermissions: optionalStringField(raw, "default_member_permissions"),
    dmPermission: typeof raw["dm_permission"] === "boolean" ? raw["dm_permission"] : undefined,
  };
  discordCommandCarrier.assert({ kind: "discord.command", ...candidate }, "Discord command");
  return candidate;
}

function channelFromWire(raw) {
  const overwrites = Array.isArray(raw["permission_overwrites"])
    ? raw["permission_overwrites"].map((entry) => overwriteFromWire(record(entry)))
    : undefined;
  const candidate = {
    id: stringField(raw, "id"),
    name: stringField(raw, "name"),
    topic: optionalStringField(raw, "topic"),
    permissionOverwrites: overwrites,
    type: typeof raw["type"] === "number" ? channelTypeNames[raw["type"]] ?? `type-${raw["type"]}` : undefined,
    parentId: typeof raw["parent_id"] === "string" ? raw["parent_id"] : raw["parent_id"] === null ? null : undefined,
    position: typeof raw["position"] === "number" ? raw["position"] : undefined,
  };
  discordChannelCarrier.assert({ kind: "discord.channel", ...candidate }, "Discord channel");
  return candidate;
}

function onboardingFromWire(raw) {
  const ids = (value) => Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : [];
  const candidate = {
    enabled: raw["enabled"] === true,
    mode: typeof raw["mode"] === "number" ? raw["mode"] : 0,
    defaultChannelIds: ids(raw["default_channel_ids"]),
    prompts: (Array.isArray(raw["prompts"]) ? raw["prompts"] : []).map((entry) => {
      const prompt = record(entry);
      return {
        id: optionalStringField(prompt, "id"),
        title: stringField(prompt, "title"),
        singleSelect: prompt["single_select"] === true,
        required: prompt["required"] === true,
        inOnboarding: prompt["in_onboarding"] !== false,
        options: (Array.isArray(prompt["options"]) ? prompt["options"] : []).map((value) => {
          const option = record(value);
          const emoji = option["emoji"] && typeof option["emoji"] === "object" ? option["emoji"] : {};
          return {
            id: optionalStringField(option, "id"),
            title: stringField(option, "title"),
            description: optionalStringField(option, "description") ?? undefined,
            emojiName: typeof emoji["name"] === "string" && emoji["name"] ? emoji["name"] : undefined,
            emojiId: typeof emoji["id"] === "string" ? emoji["id"] : undefined,
            channelIds: ids(option["channel_ids"]),
            roleIds: ids(option["role_ids"]),
          };
        }),
      };
    }),
  };
  discordOnboardingCarrier.assert({ kind: "discord.onboarding", ...candidate }, "Discord onboarding");
  return candidate;
}

function onboardingToWire(onboarding) {
  return {
    enabled: onboarding.enabled,
    mode: onboarding.mode ?? 0,
    default_channel_ids: onboarding.defaultChannelIds,
    prompts: onboarding.prompts.map((prompt) => ({
      ...(prompt.id === undefined ? {} : { id: prompt.id }),
      type: 0,
      title: prompt.title,
      single_select: prompt.singleSelect === true,
      required: prompt.required === true,
      in_onboarding: prompt.inOnboarding !== false,
      options: prompt.options.map((option) => ({
        ...(option.id === undefined ? {} : { id: option.id }),
        title: option.title,
        ...(option.description === undefined ? {} : { description: option.description }),
        ...(option.emojiId !== undefined ? { emoji_id: option.emojiId } : option.emojiName !== undefined ? { emoji_name: option.emojiName } : {}),
        channel_ids: option.channelIds,
        role_ids: option.roleIds,
      })),
    })),
  };
}

function overwriteFromWire(raw) {
  const candidate = {
    id: stringField(raw, "id"),
    type: raw["type"] === 1 ? "member" : "role",
    allow: stringField(raw, "allow"),
    deny: stringField(raw, "deny"),
  };
  discordPermissionOverwriteCarrier.assert({ kind: "discord.permission-overwrite", ...candidate }, "Discord permission overwrite");
  return candidate;
}

function messageFromWire(raw, channelIdFallback) {
  const author = record(raw["author"]);
  const candidate = {
    id: stringField(raw, "id"),
    channelId: optionalStringField(raw, "channel_id") ?? channelIdFallback,
    authorId: stringField(author, "id"),
    authorName: stringField(author, "username"),
    authorBot: author["bot"] === true,
    content: stringField(raw, "content"),
    timestamp: optionalStringField(raw, "timestamp") ?? new Date().toISOString(),
    replyToId: optionalStringField(record(raw["message_reference"]), "message_id"),
    mentionedUserIds: Array.isArray(raw["mentions"])
      ? raw["mentions"].map((value) => stringField(record(value), "id")).filter((value) => value !== "")
      : [],
  };
  discordMessageCarrier.assert({ kind: "discord.message", ...candidate }, "Discord message");
  return candidate;
}

export function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function stringField(raw, key) {
  const value = raw[key];
  return typeof value === "string" ? value : "";
}

export function optionalStringField(raw, key) {
  const value = stringField(raw, key);
  return value === "" ? undefined : value;
}

/**
 * Patch a deferred interaction's original response — the Discord Interactions
 * follow-up webhook, authenticated by the interaction token itself rather
 * than the bot token, used to deliver an answer computed after the initial
 * 3-second acknowledgement window.
 */
export async function postInteractionFollowup(
  applicationId,
  interactionToken,
  content,
  options = {},
) {
  const apiBase = options.apiBase ?? "https://discord.com/api/v10";
  const res = await fetch(`${apiBase}/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`Discord interaction followup -> ${res.status}: ${(await res.text()).slice(0, 400)}`);
}
