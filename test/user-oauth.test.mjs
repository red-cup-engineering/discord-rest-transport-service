import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discordMemberHasRole,
  discordUserAuthorizationUrl,
  exchangeDiscordAuthorizationCode,
  getCurrentDiscordGuildMember,
  getCurrentDiscordUser,
  refreshDiscordAuthorization,
  revokeDiscordAuthorization,
} from "../src/discord-user-oauth.mjs";

const json = (value, init = {}) => new Response(JSON.stringify(value), {
  ...init,
  headers: { "content-type": "application/json", ...(init.headers ?? {}) },
});

test("authorization requests disclose only identity and one-guild membership", () => {
  const target = new URL(discordUserAuthorizationUrl({
    clientId: "client", redirectUri: "https://l-space.561.group/oauth/discord/callback",
    state: "state", codeChallenge: "challenge", prompt: "consent",
  }));
  assert.equal(target.origin, "https://discord.com");
  assert.deepEqual(target.searchParams.get("scope")?.split(" ").sort(), ["guilds.members.read", "identify"]);
  assert.equal(target.searchParams.get("scope")?.includes("guilds "), false);
  assert.equal(target.searchParams.get("code_challenge_method"), "S256");
});

test("code exchange and refresh retain required scopes and form encoding", async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push({ body: String(init?.body), headers: new Headers(init?.headers) });
    return json({ access_token: "access", refresh_token: "refresh", expires_in: 3600, token_type: "Bearer", scope: "identify guilds.members.read" });
  };
  const exchanged = await exchangeDiscordAuthorizationCode("code", {
    clientId: "client", clientSecret: "secret", redirectUri: "https://l-space.561.group/oauth/discord/callback",
    codeVerifier: "v".repeat(43), fetchImpl,
  });
  assert.equal(exchanged.accessToken, "access");
  assert.match(requests[0].body, /grant_type=authorization_code/u);
  assert.match(requests[0].body, /code_verifier=/u);
  assert.equal(requests[0].headers.get("user-agent"), "DiscordBot (https://561.group, 1.1.0)");
  await refreshDiscordAuthorization("refresh", { clientId: "client", clientSecret: "secret", fetchImpl });
  assert.match(requests[1].body, /grant_type=refresh_token/u);
});

test("an exchange omitting guild membership authority fails closed", async () => {
  await assert.rejects(
    exchangeDiscordAuthorizationCode("code", {
      clientId: "client", clientSecret: "secret", redirectUri: "https://example.test/callback", codeVerifier: "v".repeat(43),
      fetchImpl: async () => json({ access_token: "a", refresh_token: "r", expires_in: 3600, token_type: "Bearer", scope: "identify" }),
    }),
    /omitted guilds\.members\.read/u,
  );
});

test("current-user membership authorizes by immutable role id and rejects pending members", async () => {
  const fetchImpl = async (url) => String(url).endsWith("/users/@me")
    ? json({ id: "1184863861065658420", username: "reader", global_name: "Reader" })
    : json({ roles: ["role-islander", "role-other"], pending: false, nick: "An Islander" });
  const user = await getCurrentDiscordUser("access", { fetchImpl });
  const member = await getCurrentDiscordGuildMember("access", "1184863861065658419", { fetchImpl });
  assert.equal(user.id, "1184863861065658420");
  assert.equal(discordMemberHasRole(member, "role-islander"), true);
  assert.equal(discordMemberHasRole({ roles: ["role-islander"], pending: true }, "role-islander"), false);
  assert.equal(discordMemberHasRole(member, "islander"), false, "a role name is never an authorization key");
});

test("missing guild membership is a normal negative decision and logout revokes", async () => {
  const calls = [];
  const missing = await getCurrentDiscordGuildMember("access", "guild", { fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.equal(missing, null);
  await revokeDiscordAuthorization("refresh", {
    clientId: "client", clientSecret: "secret", tokenTypeHint: "refresh_token",
    fetchImpl: async (url, init) => { calls.push(`${url} ${init?.body}`); return new Response(null, { status: 200 }); },
  });
  assert.match(calls[0], /token=refresh/u);
  assert.match(calls[0], /token_type_hint=refresh_token/u);
});
