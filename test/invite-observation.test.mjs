import assert from "node:assert/strict";
import { test } from "node:test";
import { DiscordRestTransport, InMemoryDiscordTransport, qualifyDiscordInviteCode, discordInviteFromWire } from "../src/discord.mjs";

const code = "xZHxzDz4zv";
const observedAt = "2026-10-22T14:00:00.000Z";
const guildId = "1184863861065658419";
const channelId = "1184864166142558349";
const guildInvite = () => ({
  type: 0, code, guild: { id: guildId, name: "Turntide Islands" },
  channel: { id: channelId, name: "dock" }, expires_at: null,
  inviter: { id: "123456789012345678", username: "private-issuer" },
  approximate_member_count: 999,
});

test("public invitation projection keeps exact provider destination and expiry without leaking members or inviter", () => {
  const reading = discordInviteFromWire(guildInvite(), code, observedAt);
  assert.deepEqual(reading, {
    kind: "discord.invite-provider-observation/v1",
    provider: "discord", method: "GET /invites/{code}", code, observedAt,
    guildId, channelId, expiryState: "none-reported",
  });
  assert.ok(Object.isFrozen(reading));
  assert.doesNotMatch(JSON.stringify(reading), /private-issuer|123456789012345678|999/);
  assert.equal(Object.hasOwn(reading, "authorized"), false);
  assert.equal(Object.hasOwn(reading, "valid"), false);
  assert.equal(Object.hasOwn(reading, "permanent"), false);
});

test("unknown expiry is different from provider null, and timestamp is not a permanence guarantee", () => {
  const without = guildInvite(); delete without.expires_at;
  assert.equal(discordInviteFromWire(without, code, observedAt).expiryState, "unknown");
  const expiring = { ...guildInvite(), expires_at: "2026-10-23T11:00:00.000Z" };
  const projected = discordInviteFromWire(expiring, code, observedAt);
  assert.equal(projected.expiryState, "expires-at");
  assert.equal(projected.expiresAt, expiring.expires_at);
  const alreadyExpired = discordInviteFromWire(
    { ...guildInvite(), expires_at: "2026-10-01T00:00:00Z" }, code, observedAt);
  assert.equal(alreadyExpired.expiresAt, "2026-10-01T00:00:00Z");
  assert.equal(Object.hasOwn(alreadyExpired, "available"), false);
});

test("missing guild is unverified and a different guild is faithfully observable, never silently corrected", () => {
  const absent = discordInviteFromWire({ code, type: 0, channel: null }, code, observedAt);
  assert.equal(absent.guildId, null);
  assert.equal(absent.channelId, null);
  const foreign = discordInviteFromWire({ ...guildInvite(), guild: { id: "1184863861065658420" } }, code, observedAt);
  assert.equal(foreign.guildId, "1184863861065658420");
  assert.notEqual(foreign.guildId, guildId);
});

test("malformed, mismatched, non-guild and private-input cases refuse before any claiming", () => {
  const decode = (v, c = code, at = observedAt) => discordInviteFromWire(v, c, at);
  assert.throws(() => decode(null), /matching invite code/);
  assert.throws(() => decode({ ...guildInvite(), code: "foreign-code" }), /matching invite code/);
  assert.throws(() => decode({ ...guildInvite(), type: 1 }), /not a guild invitation/);
  assert.throws(() => decode({ ...guildInvite(), expires_at: "invalid" }), /expiry is invalid/);
  assert.throws(() => decode({ ...guildInvite(), guild: { id: "other" } }), /invalid guild identity/);
  assert.throws(() => decode({ ...guildInvite(), channel: { id: "none" } }), /invalid channel identity/);
  assert.throws(() => decode(guildInvite(), "../other"), /path-safe/);
  assert.throws(() => decode(guildInvite(), code, "not-a-date"), /actual timestamp/);
});

test("actual REST transport performs one GET to canonical Discord invite endpoint and preserves only public readout", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(guildInvite()), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const client = new DiscordRestTransport({ token: "fixture-only", apiBase: "https://discord.test/api/v10" });
    const result = await client.getInvite(code);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://discord.test/api/v10/invites/" + code + "?with_expiration=true");
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.body, undefined);
    assert.equal(calls[0].options.headers.authorization, "Bot fixture-only");
    assert.equal(result.guildId, guildId);
    assert.equal(result.channelId, channelId);
    assert.equal(result.expiryState, "none-reported");
    assert.ok(Number.isFinite(Date.parse(result.observedAt)));
    assert.equal(Object.hasOwn(result, "inviter"), false);
  } finally { globalThis.fetch = originalFetch; }
});

test("malformed path never reaches provider", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { assert.fail("unqualified request escaped before validation"); };
  try {
    const client = new DiscordRestTransport({ token: "fixture-only" });
    await assert.rejects(client.getInvite("../../users/@me"), /path-safe/);
  } finally { globalThis.fetch = originalFetch; }
});

test("provider 404 and throttle are refusals, not availability or automatic retries", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ code: 10006, message: "Unknown Invite" }), { status: calls === 1 ? 404 : 429 });
  };
  try {
    const client = new DiscordRestTransport({ token: "fixture-only", apiBase: "https://discord.test/api/v10" });
    await assert.rejects(client.getInvite(code), error => error.status === 404 && error.discordCode === 10006);
    await assert.rejects(client.getInvite(code), error => error.status === 429);
    assert.equal(calls, 2, "one GET per attempt and no hidden throttle retry");
  } finally { globalThis.fetch = originalFetch; }
});


test("in-memory Get Invite shares exact production observation semantics and refuses absent or unsafe codes", async () => {
  const transport = new InMemoryDiscordTransport({
    guild: { id: guildId, name: "Turntide Islands" },
    invites: [[code, guildInvite()]],
  });
  const result = await transport.getInvite(code);
  assert.equal(result.kind, "discord.invite-provider-observation/v1");
  assert.equal(result.provider, "discord");
  assert.equal(result.guildId, guildId);
  assert.equal(result.channelId, channelId);
  assert.equal(result.expiryState, "none-reported");
  assert.ok(Number.isFinite(Date.parse(result.observedAt)));
  assert.equal(Object.hasOwn(result, "inviter"), false);
  assert.equal((await transport.getGuild(guildId)).id, guildId);
  await assert.rejects(transport.getInvite("not-found"), error => error.status === 404);
  await assert.rejects(transport.getInvite("../guilds"), /path-safe/);
  const poisoned = new InMemoryDiscordTransport({
    invites: [[code, { ...guildInvite(), code: "wrong-code" }]],
  });
  await assert.rejects(poisoned.getInvite(code), /matching invite code/);
});

test("shared path-safe invite validator is reusable and rejects URLs or arbitrary paths", () => {
  assert.equal(qualifyDiscordInviteCode(code), code);
  for (const bad of ["https://discord.gg/" + code, "../../secret", "abc?q=1", "abc#frag", "", "x".repeat(65), null]) {
    assert.throws(() => qualifyDiscordInviteCode(bad), /path-safe/);
  }
});
