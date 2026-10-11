import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordRestTransport, InMemoryDiscordTransport } from "../src/discord.mjs";

test("in-memory transport preserves member roles and moderation state", async () => {
  const transport = new InMemoryDiscordTransport();
  const guildId = "guild-discord";
  const role = await transport.createRole(guildId, { name: "Member" });
  await transport.addGuildMemberRole(guildId, "member-1", role.id);
  assert.deepEqual(await transport.listGuildMemberRoleIds(guildId, "member-1"), [role.id]);
  await transport.timeoutGuildMember(guildId, "member-1", "2026-09-01T00:00:00.000Z", "review");
  assert.equal(transport.memberTimeouts.get(`${guildId}:member-1`), "2026-09-01T00:00:00.000Z");
  await transport.banGuildMember(guildId, "member-1", { deleteMessageSeconds: 60, reason: "review" });
  assert.deepEqual(transport.bannedMembers.get(`${guildId}:member-1`), { deleteMessageSeconds: 60, reason: "review" });
  await transport.unbanGuildMember(guildId, "member-1", "appeal");
  assert.equal(transport.bannedMembers.has(`${guildId}:member-1`), false);
});

test("REST serializes moderation, audit reasons, multipart messages, and Discord errors", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith("/oauth2/applications/@me")) return new Response("bad request", { status: 400 });
    if (String(input).endsWith("/auto-moderation/rules") && init.method === "GET") return new Response("[]", { status: 200 });
    if (String(input).endsWith("/channels/channel-1/messages")) return new Response(JSON.stringify({ id: "message-1", channel_id: "channel-1", author: { id: "bot-1", username: "bot", bot: true }, content: "image", timestamp: "2026-09-01T00:00:00.000Z", mentions: [] }), { status: 200 });
    return new Response(JSON.stringify({ id: "rule-1", guild_id: "guild-1", name: "guard", trigger_type: 5, actions: [{ type: 1, metadata: {} }], enabled: true, exempt_roles: [], exempt_channels: [] }), { status: 200 });
  };
  try {
    const transport = new DiscordRestTransport({ token: "test-token", apiBase: "https://discord.test/api/v10" });
    await transport.timeoutGuildMember("guild-1", "member-1", "2026-09-01T00:00:00.000Z", "human review");
    await transport.createAutoModerationRule("guild-1", { name: "guard", triggerType: "mention-spam", actions: [{ type: "block-message" }], enabled: true });
    await transport.createMessage("channel-1", { content: "image", files: [{ name: "a.txt", data: new TextEncoder().encode("a"), contentType: "text/plain" }] });
    assert.equal(new Headers(calls[0].init.headers).get("x-audit-log-reason"), "human%20review");
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), { communication_disabled_until: "2026-09-01T00:00:00.000Z" });
    assert.deepEqual(JSON.parse(String(calls[1].init.body)), { name: "guard", event_type: 1, trigger_type: 5, actions: [{ type: 1, metadata: {} }], enabled: true, exempt_roles: [], exempt_channels: [] });
    assert.ok(calls[2].init.body instanceof FormData);
    const form = calls[2].init.body;
    assert.equal(form.get("payload_json"), JSON.stringify({ content: "image" }));
    assert.ok(form.get("files[0]"));
    await assert.rejects(() => transport.getApplicationId(), /Discord GET \/oauth2\/applications\/@me -> 400: bad request/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createMessage forwards caller-supplied extra headers on the non-multipart path", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ id: "message-1", channel_id: "channel-1", author: { id: "bot-1", username: "bot", bot: true }, content: "hi", timestamp: "2026-09-01T00:00:00.000Z", mentions: [] }), { status: 200 });
  };
  try {
    const transport = new DiscordRestTransport({ token: "test-token", apiBase: "https://discord.test/api/v10" });
    await transport.createMessage("channel-1", { content: "hi" }, { headers: { "x-idempotency-key": "retry-1" } });
    assert.equal(new Headers(calls[0].init.headers).get("x-idempotency-key"), "retry-1");
    assert.equal(new Headers(calls[0].init.headers).get("authorization"), "Bot test-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
