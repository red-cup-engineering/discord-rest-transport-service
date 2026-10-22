import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DiscordRestTransport,
  InMemoryDiscordTransport,
  qualifyDiscordInviteCode,
  readDiscordInviteResponse,
} from "../src/discord.mjs";

const code = "xZHxzDz4zv";
const guildId = "1184863861065658419";
const publicWire = Object.freeze({
  type: 0,
  code,
  guild: { id: guildId, name: "Turntide Islands" },
  channel: { id: "1184864166142558349", name: "dock" },
  inviter: { id: "private-user", username: "do-not-publish" },
  approximate_member_count: 430,
  expires_at: null,
});

test("shared codec preserves code, guild, channel, null expiry without disclosing inviter", () => {
  const source = structuredClone(publicWire);
  const observation = readDiscordInviteResponse(source, code);
  assert.deepEqual(observation, {
    kind: "discord.invite-observation",
    code, inviteType: 0, guildId,
    channelId: "1184864166142558349", expiresAt: null,
  });
  assert.equal(Object.isFrozen(observation), true);
  assert.equal(JSON.stringify(observation).includes("private-user"), false);
  assert.deepEqual(source, publicWire, "provider response is not mutated");
  assert.equal(Object.hasOwn(readDiscordInviteResponse({
    code, guild: { id: guildId }, type: 0,
  }, code), "expiresAt"), false, "missing expiry is not an explicit null");
});

test("getInvite is one original authenticated GET with a constrained code, not join/create", async () => {
  const previous = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(publicWire), { status: 200 });
  };
  try {
    const transport = new DiscordRestTransport({
      token: "fixture-not-a-live-credential",
      apiBase: "https://discord.test/api/v10",
      env: {},
    });
    const observation = await transport.getInvite(code);
    assert.equal(observation.guildId, guildId);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://discord.test/api/v10/invites/" + code);
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[0].options.headers.authorization, "Bot fixture-not-a-live-credential");
    for (const bad of [
      "https://discord.gg/" + code, "../guilds/private", "abc?with_counts=1",
      "abc#fragment", "", "x".repeat(65),
    ]) {
      await assert.rejects(() => transport.getInvite(bad), /bounded code/u);
    }
    assert.equal(calls.length, 1, "untrusted URL/code must not reach HTTP");
  } finally {
    globalThis.fetch = previous;
  }
});

test("404 and remote errors remain source refusals, not a proof of invitation validity", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: "Unknown Invite", code: 10006,
  }), { status: 404 });
  try {
    const transport = new DiscordRestTransport({ token: "fixture", env: {} });
    await assert.rejects(transport.getInvite(code), (error) =>
      error.status === 404 && error.discordCode === 10006);
  } finally {
    globalThis.fetch = previous;
  }
});

test("negative identity/expiry cases remain unqualified, not redirected to another guild", () => {
  for (const bad of [
    { ...publicWire, code: "different" },
    { ...publicWire, type: 10 },
    { ...publicWire, expires_at: "not-a-date" },
  ]) assert.throws(() => readDiscordInviteResponse(bad, code), TypeError);
  assert.equal(readDiscordInviteResponse({
    code, type: 1, channel: null,
  }, code).guildId, null, "group DM cannot silently become guild approval");
  assert.throws(() => qualifyDiscordInviteCode("invite/code"), /bounded code/u);
});

test("in-memory transport uses exact seeded response and refuses unknown invites", async () => {
  const transport = new InMemoryDiscordTransport({
    invites: [[code, publicWire]],
    guild: { id: guildId, name: "Turntide Islands" },
  });
  assert.equal((await transport.getInvite(code)).guildId, guildId);
  await assert.rejects(() => transport.getInvite("not-listed"), (error) =>
    error.status === 404);
  assert.equal((await transport.getGuild(guildId)).id, guildId);
});
