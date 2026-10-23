# discord-rest-transport-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Native Discord transport tests](https://github.com/red-cup-engineering/discord-rest-transport-service/actions/workflows/native-transport-tests.yml/badge.svg)](https://github.com/red-cup-engineering/discord-rest-transport-service/actions/workflows/native-transport-tests.yml)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Discord REST protocol capability: typed carriers, dependency-free codecs, bot transport, and narrow user-OAuth identity and guild-membership transport shared across the discord-services-section.

## Reader OAuth on an installed L-Space host

The original `./user-oauth` provides Discord `identify` and
`guilds.members.read`, PKCE URL, exchange, refresh, guild lookup and revoke.
Use its new `./user-oauth/session` export
`createDiscordUserOAuthWebSessions` to compose these *existing* operations
into bounded, single-process HTTPS login state:

- `route(request)`: `GET /oauth/discord/start`, `GET /oauth/discord/callback`,
  and `POST /oauth/discord/logout`. Other URLs return `null` so the original
  CAIRN/TUFTE application handles them, without a parallel renderer or corpus.
- `readSession(request)`: resolves only an unguessable `__Host-` cookie to an
  access token held **server-side**; optionally refreshes it through the
  original transport. Neither access nor refresh token goes to the browser.
- Every one-use CSRF state is bound to an HttpOnly, Secure, SameSite=Lax
  `__Host-` cookie and its original S256 PKCE verifier. Invalid/replayed/
  expired states, unknown guild membership, pending onboarding, and Discord
  failures never produce a reader session.
- Sessions live in a bounded memory store and expire by eight hours at most;
  server restart logs readers out. For multi-process hosts, independently
  qualify a shared store rather than declaring this in-memory module
  cluster-safe.

The fixed installation guild is the Turntide Islands Discord
`1184863861065658419`, **not** a paid Discord role. Example composition:

```js
const sessions = createDiscordUserOAuthWebSessions({
  guildId: "1184863861065658419",
  clientId: installedClientId, clientSecret: installedClientSecret,
  redirectUri: "https://l-space.561.group/oauth/discord/callback",
});
// Pass sessions.readSession to CAIRN's original source admission.
// Route the three OAuth URLs with sessions.route; pass all other URLs
// to the existing TUFTE/CAIRN site without changing content identity.
```

**Do not mistake a login for content authorization.** CAIRN must independently
admit each source, exact NI and named root for the current Discord member,
using the original `getCurrentDiscordGuildMember` on new requests. Member
access never gives 561 Group internal corpus, write, voting or operator rights.
Source/test additions require native Node test, real OAuth app registration,
host credentials, content-grant installation, correct ingress, browser and
revocation receiving before describing L-Space membership as live.
