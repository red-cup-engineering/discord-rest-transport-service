/**
 * Discord's user-authorized HTTP boundary.
 *
 * This is deliberately separate from DiscordRestTransport: that transport
 * speaks as a bot, while these calls speak only with the narrow authority a
 * reader granted through OAuth.  In particular, guilds.members.read can
 * observe the current reader's membership in one named guild without exposing
 * their complete guild list or retaining a high-authority bot token.
 */

import { isObjectRecord } from "@red-cup-engineering/json-services-section";

export const DISCORD_USER_SCOPES = Object.freeze(["identify", "guilds.members.read"]);
export const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
export const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";
export const DISCORD_REVOKE_URL = "https://discord.com/api/oauth2/token/revoke";
export const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
export const DISCORD_USER_AGENT = "DiscordBot (https://561.group, 1.1.0)";

export class DiscordUserAuthorizationError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "DiscordUserAuthorizationError";
    this.code = code;
    this.status = options.status;
    this.retryAfter = options.retryAfter;
  }
}

function required(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function record(value) {
  if (!isObjectRecord(value)) {
    throw new DiscordUserAuthorizationError("malformed_response", "Discord returned a malformed object");
  }
  return value;
}

function retryAfter(response) {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function discordJson(response, operation) {
  if (!response.ok) {
    throw new DiscordUserAuthorizationError(
      response.status === 429 ? "rate_limited" : response.status >= 500 ? "discord_unavailable" : "discord_refused",
      `Discord ${operation} failed with HTTP ${response.status}`,
      { status: response.status, retryAfter: retryAfter(response) },
    );
  }
  try {
    return await response.json();
  } catch {
    throw new DiscordUserAuthorizationError("malformed_response", `Discord ${operation} returned non-JSON`);
  }
}

function normalizedScopes(value) {
  const scopes = typeof value === "string"
    ? value.split(/\s+/u).filter(Boolean)
    : Array.isArray(value) && value.every((scope) => typeof scope === "string")
      ? value
      : [];
  return Object.freeze([...new Set(scopes)].sort());
}

function authorizationFromWire(value) {
  const raw = record(value);
  const accessToken = required(raw.access_token, "Discord access_token");
  const refreshToken = required(raw.refresh_token, "Discord refresh_token");
  const expiresIn = Number(raw.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new DiscordUserAuthorizationError("malformed_response", "Discord returned an invalid token expiry");
  }
  if (typeof raw.token_type !== "string" || raw.token_type.toLowerCase() !== "bearer") {
    throw new DiscordUserAuthorizationError("malformed_response", "Discord returned a non-Bearer token");
  }
  const scopes = normalizedScopes(raw.scope);
  for (const scope of DISCORD_USER_SCOPES) {
    if (!scopes.includes(scope)) {
      throw new DiscordUserAuthorizationError("insufficient_scope", `Discord authorization omitted ${scope}`);
    }
  }
  return Object.freeze({ accessToken, refreshToken, expiresIn, tokenType: "Bearer", scopes });
}

export function discordUserAuthorizationUrl(input) {
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", required(input.clientId, "Discord clientId"));
  url.searchParams.set("redirect_uri", required(input.redirectUri, "Discord redirectUri"));
  url.searchParams.set("scope", DISCORD_USER_SCOPES.join(" "));
  url.searchParams.set("state", required(input.state, "Discord state"));
  url.searchParams.set("code_challenge", required(input.codeChallenge, "Discord codeChallenge"));
  url.searchParams.set("code_challenge_method", "S256");
  if (input.prompt !== undefined) url.searchParams.set("prompt", input.prompt);
  return url.toString();
}

async function tokenRequest(
  body,
  input,
) {
  body.set("client_id", required(input.clientId, "Discord clientId"));
  body.set("client_secret", required(input.clientSecret, "Discord clientSecret"));
  const response = await (input.fetchImpl ?? fetch)(DISCORD_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": DISCORD_USER_AGENT },
    body: body.toString(),
  });
  return authorizationFromWire(await discordJson(response, "token exchange"));
}

export function exchangeDiscordAuthorizationCode(code, input) {
  return tokenRequest(new URLSearchParams({
    grant_type: "authorization_code",
    code: required(code, "Discord authorization code"),
    redirect_uri: required(input.redirectUri, "Discord redirectUri"),
    code_verifier: required(input.codeVerifier, "Discord codeVerifier"),
  }), input);
}

export function refreshDiscordAuthorization(refreshToken, input) {
  return tokenRequest(new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: required(refreshToken, "Discord refreshToken"),
  }), input);
}

export async function revokeDiscordAuthorization(token, input) {
  const body = new URLSearchParams({
    token: required(token, "Discord token"),
    client_id: required(input.clientId, "Discord clientId"),
    client_secret: required(input.clientSecret, "Discord clientSecret"),
  });
  if (input.tokenTypeHint !== undefined) body.set("token_type_hint", input.tokenTypeHint);
  const response = await (input.fetchImpl ?? fetch)(DISCORD_REVOKE_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": DISCORD_USER_AGENT },
    body: body.toString(),
  });
  if (!response.ok) await discordJson(response, "token revocation");
}

export async function getCurrentDiscordUser(
  accessToken,
  input = {},
) {
  const response = await (input.fetchImpl ?? fetch)(`${input.apiBaseUrl ?? DISCORD_API_BASE_URL}/users/@me`, {
    headers: { authorization: `Bearer ${required(accessToken, "Discord accessToken")}`, "user-agent": DISCORD_USER_AGENT },
  });
  const raw = record(await discordJson(response, "current-user lookup"));
  const id = required(raw.id, "Discord user id");
  const username = required(raw.username, "Discord username");
  const globalName = typeof raw.global_name === "string" && raw.global_name.length > 0 ? raw.global_name : undefined;
  return Object.freeze({ id, username, ...(globalName === undefined ? {} : { globalName }) });
}

export async function getCurrentDiscordGuildMember(
  accessToken,
  guildId,
  input = {},
) {
  const response = await (input.fetchImpl ?? fetch)(
    `${input.apiBaseUrl ?? DISCORD_API_BASE_URL}/users/@me/guilds/${encodeURIComponent(required(guildId, "Discord guildId"))}/member`,
    { headers: { authorization: `Bearer ${required(accessToken, "Discord accessToken")}`, "user-agent": DISCORD_USER_AGENT } },
  );
  if (response.status === 404) return null;
  const raw = record(await discordJson(response, "guild-member lookup"));
  if (!Array.isArray(raw.roles) || !raw.roles.every((role) => typeof role === "string" && role.length > 0)) {
    throw new DiscordUserAuthorizationError("malformed_response", "Discord guild member omitted role IDs");
  }
  const nick = typeof raw.nick === "string" && raw.nick.length > 0 ? raw.nick : undefined;
  return Object.freeze({
    roles: Object.freeze([...raw.roles]),
    pending: raw.pending === true,
    ...(nick === undefined ? {} : { nick }),
  });
}

export function discordMemberHasRole(member, roleId) {
  return member !== null && member.pending !== true && member.roles.includes(required(roleId, "Discord roleId"));
}
