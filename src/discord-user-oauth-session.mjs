/**
 * Small, single-process HTTP session adapter for the existing Discord
 * user-OAuth transport. An installed HTTPS application owns this state;
 * Discord owns identity; the content system independently owns source grants.
 *
 * No second Discord protocol, persistent account database, bot access token,
 * source rights, or authorization via a caller-controlled guild/role.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  discordUserAuthorizationUrl, exchangeDiscordAuthorizationCode,
  refreshDiscordAuthorization, revokeDiscordAuthorization,
  getCurrentDiscordGuildMember,
} from "./discord-user-oauth.mjs";

const MINUTE = 60_000;
const MAX_STATE_AGE = 5 * MINUTE;
const MAX_SESSION_AGE = 8 * 60 * MINUTE;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

const noStore = Object.freeze({
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

function valueOfCookie(request, name) {
  const raw = request.headers.get("cookie") ?? "";
  if (raw.length > 8192) return null;
  const matches = raw.split(";").map(part => part.trim())
    .filter(part => part.startsWith(name + "="));
  if (matches.length !== 1) return null;
  const value = matches[0].slice(name.length + 1);
  return tokenPattern.test(value) ? value : null;
}
const cookie = (name, value, age) => name + "=" + value +
  "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" + age;
const cleared = name => cookie(name, "", 0);
const redirect = (location, cookies = []) => {
  const headers = new Headers({ ...noStore, location });
  for (const setCookie of cookies) headers.append("set-cookie", setCookie);
  return new Response(null, { status: 303, headers });
};
const refused = (status, reason) =>
  new Response(JSON.stringify({kind:"discord.user-oauth.session-refusal",reason}) + "\n", {
    status, headers:{...noStore,"content-type":"application/json; charset=utf-8"},
  });
const sameState = (a, b) => tokenPattern.test(a ?? "") &&
  tokenPattern.test(b ?? "") &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

function checkConfig({
  guildId, clientId, clientSecret, redirectUri, cookieNamespace,
  continuePath, maxPending, maxSessions,
}) {
  if (!/^[0-9]{17,20}$/u.test(guildId ?? "") ||
      typeof clientId !== "string" || !clientId ||
      typeof clientSecret !== "string" || !clientSecret ||
      !/^[a-z][a-z0-9-]{0,39}$/u.test(cookieNamespace) ||
      !/^\/[a-zA-Z0-9_/-]*$/u.test(continuePath) ||
      !Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 8192 ||
      !Number.isSafeInteger(maxSessions) || maxSessions < 1 || maxSessions > 8192)
    throw new TypeError("Discord web session: pinned guild, server credentials, safe local routes and bounded stores required");
  let callback;
  try { callback = new URL(redirectUri); }
  catch { throw new TypeError("Discord web session: installed HTTPS callback required"); }
  if (callback.protocol !== "https:" || callback.username || callback.password ||
      callback.search || callback.hash || callback.pathname !== "/oauth/discord/callback" ||
      callback.origin !== new URL(callback.origin).origin)
    throw new TypeError("Discord web session: callback must be the canonical HTTPS origin");
  return callback;
}

/**
 * Mounted by the installed host, alongside one CAIRN/TUFTE application.
 * `route(request)` returns null for the caller's *existing* app routes.
 * `readSession(request)` resolves only our opaque server-held cookie.
 * Host passes readSession to CAIRN's original scoped source admission.
 *
 * In-memory sessions intentionally expire on service restart; replicas need
 * an explicitly qualified shared store before adopting this implementation.
 */
export function createDiscordUserOAuthWebSessions({
  guildId, clientId, clientSecret, redirectUri,
  cookieNamespace = "lspace", continuePath = "/explore",
  maxPending = 1024, maxSessions = 4096,
  now = () => Date.now(), fetchImpl,
} = {}) {
  const callback = checkConfig({
    guildId, clientId, clientSecret, redirectUri, cookieNamespace,
    continuePath, maxPending, maxSessions,
  });
  if (typeof now !== "function" || (fetchImpl !== undefined && typeof fetchImpl !== "function"))
    throw new TypeError("Discord web session: clock and OAuth fetch capability required");
  const pendingCookie = "__Host-" + cookieNamespace + "-discord-pending";
  const activeCookie = "__Host-" + cookieNamespace + "-discord";
  const pending = new Map(), sessions = new Map(), refreshes = new Map();
  const oauthInput = {clientId,clientSecret,redirectUri, ...(fetchImpl === undefined ? {} : {fetchImpl})};
  const lookupOptions = fetchImpl === undefined ? {} : {fetchImpl};
  const randomToken = () => randomBytes(32).toString("base64url");

  function reap(at = now()) {
    for (const [id, entry] of pending) if (entry.until <= at) pending.delete(id);
    for (const [id, entry] of sessions) if (entry.until <= at) sessions.delete(id);
  }

  async function readSession(request) {
    if (!(request instanceof Request)) return null;
    const id = valueOfCookie(request, activeCookie);
    if (id === null) return null;
    reap();
    const entry = sessions.get(id);
    if (entry === undefined || entry.until <= now()) return null;
    if (entry.accessUntil > now()) return Object.freeze({ accessToken: entry.accessToken });
    let refresh = refreshes.get(id);
    if (refresh === undefined) {
      refresh = refreshDiscordAuthorization(entry.refreshToken, oauthInput)
        .then(tokens => {
          if (sessions.get(id) !== entry) return false;
          entry.accessToken = tokens.accessToken;
          entry.refreshToken = tokens.refreshToken;
          entry.accessUntil = now() + Math.max(0, tokens.expiresIn * 1000 - 30_000);
          return true;
        })
        .catch(() => { sessions.delete(id); return false; })
        .finally(() => { refreshes.delete(id); });
      refreshes.set(id, refresh);
    }
    return (await refresh) && sessions.get(id) === entry
      ? Object.freeze({ accessToken: entry.accessToken }) : null;
  }

  async function route(request) {
    if (!(request instanceof Request)) throw new TypeError("Discord session gateway expects a Request");
    const url = new URL(request.url);
    const path = url.pathname;
    if (!["/oauth/discord/start", callback.pathname, "/oauth/discord/logout"].includes(path))
      return null;
    if (url.origin !== callback.origin)
      return refused(404,"origin-not-admitted");

    if (path === "/oauth/discord/start") {
      if (request.method !== "GET" || url.search) return refused(405,"start-must-be-get");
      reap();
      if (pending.size >= maxPending) return refused(503,"login-capacity");
      const state = randomToken(), verifier = randomToken();
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      pending.set(state,{verifier,until:now()+MAX_STATE_AGE});
      const authorization = discordUserAuthorizationUrl({
        clientId,redirectUri,state,codeChallenge:challenge,
      });
      return redirect(authorization,[cookie(pendingCookie,state,300)]);
    }
    if (path === callback.pathname) {
      if (request.method !== "GET") return refused(405,"callback-must-be-get");
      const code = url.searchParams.get("code"), state = url.searchParams.get("state");
      if ([...url.searchParams.keys()].some(key=>!["code","state"].includes(key)) ||
          url.searchParams.getAll("code").length!==1 ||
          url.searchParams.getAll("state").length!==1 ||
          !code || code.length>2048 ||
          !sameState(state,valueOfCookie(request,pendingCookie)))
        return refused(403,"oauth-state-or-code-invalid");
      reap();
      const challenge = pending.get(state);
      if (challenge === undefined || challenge.until <= now())
        return refused(403,"oauth-state-expired-or-replayed");
      pending.delete(state); // one-use, before network exchange
      let tokens;
      try {
        tokens = await exchangeDiscordAuthorizationCode(code,{...oauthInput,codeVerifier:challenge.verifier});
        const member = await getCurrentDiscordGuildMember(tokens.accessToken,guildId,lookupOptions);
        if (member === null || member.pending !== false) {
          await revokeDiscordAuthorization(tokens.refreshToken,{...oauthInput,tokenTypeHint:"refresh_token"}).catch(()=>{});
          return refused(403,"not-current-guild-member");
        }
      } catch { return refused(503,"oauth-verification-failed"); }
      reap();
      if (sessions.size>=maxSessions) return refused(503,"session-capacity");
      const id = randomToken(), at = now();
      sessions.set(id,{
        accessToken:tokens.accessToken,refreshToken:tokens.refreshToken,
        accessUntil:at+Math.max(0,tokens.expiresIn*1000-30_000),
        until:at+MAX_SESSION_AGE,
      });
      return redirect(continuePath,[
        cleared(pendingCookie),cookie(activeCookie,id,MAX_SESSION_AGE/1000),
      ]);
    }
    if (request.method !== "POST") return refused(405,"logout-must-be-post");
    const id = valueOfCookie(request,activeCookie);
    const entry = id===null?undefined:sessions.get(id);
    if (id!==null) sessions.delete(id); // local grant revoked even if Discord is down
    if (entry!==undefined)
      await revokeDiscordAuthorization(entry.refreshToken,{
        ...oauthInput,tokenTypeHint:"refresh_token",
      }).catch(()=>{});
    return redirect("/",[cleared(pendingCookie),cleared(activeCookie)]);
  }

  return Object.freeze({ route, readSession });
}
