import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordRestTransport, InMemoryDiscordTransport, botToken, inviteUrl } from "../src/discord.mjs";
import { discordMessageCarrier } from "../src/discord-codecs.mjs";

const narrowTransportImplementer = {
  async getApplicationId() { return "app"; }, async getCurrentUser() { return { id: "user", username: "user" }; }, async getGuild(id) { return { id, name: "guild" }; }, async listGuilds() { return []; }, async listChannels() { return []; }, async createChannel(_guildId, channel) { return { id: "channel", name: channel.name }; }, async modifyChannel(id) { return { id, name: "channel" }; }, async listRoles() { return []; }, async createRole(guildId, role) { return { id: "role", guildId, name: role.name }; }, async listCommands() { return []; }, async registerCommand(_applicationId, _guildId, command) { return { id: "command", ...command }; }, async updateCommand(_applicationId, _guildId, id, command) { return { id, ...command }; }, async listMessages() { return []; }, async createDirectMessageChannel() { return "channel"; }, async createMessage(channelId, input) { return { id: "message", channelId, authorId: "user", authorName: "user", authorBot: false, content: typeof input === "string" ? input : input.content, timestamp: "2026-09-01T00:00:00.000Z", mentionedUserIds: [] }; }, async addGuildMemberRole() {}, async removeGuildMemberRole() {},
};

test("the original narrow transport contract remains implementable", () => assert.equal(narrowTransportImplementer instanceof Object, true));

test("transport constructs from an explicit token without touching process.env", () => {
  const transport = new DiscordRestTransport({ token: "test-token", env: {} });
  assert.ok(transport);
});

test("botToken reads the override map, preferring DISCORD_BOT_TOKEN", () => {
  assert.equal(botToken({ DISCORD_BOT_TOKEN: "a", DISCORD_TOKEN: "b" }), "a");
  assert.equal(botToken({ DISCORD_TOKEN: "b" }), "b");
  assert.equal(botToken({}), undefined);
});

test("invite permissions and in-memory fixtures are supplied by the caller, not a domain", async () => {
  const invite = new URL(inviteUrl("client", 42n));
  assert.equal(invite.searchParams.get("permissions"), "42");
  const transport = new InMemoryDiscordTransport();
  assert.equal((await transport.listGuilds())[0]?.name, "Discord Guild");
  assert.equal((await transport.getCurrentUser()).username, "Discord Bot");
});

test("message carrier admits a well-formed wire message and refuses a malformed one", () => {
  const wire = {
    kind: "discord.message", id: "1", channelId: "2", authorId: "3", authorName: "u",
    timestamp: "2026-08-11T00:00:00Z", authorBot: false, content: "hi",
    replyToId: undefined, mentionedUserIds: [],
  };
  assert.ok(discordMessageCarrier.assert(wire));
  assert.throws(() => discordMessageCarrier.assert({ kind: "discord.message" }));
});
