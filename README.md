# discord-rest-transport-service

<!-- 561-group-standards:badges:start -->
[![Red Cup Engineering](https://img.shields.io/badge/561%20Group-Red%20Cup%20Engineering-c0392b)](https://github.com/red-cup-engineering)
[![License: MIT](https://img.shields.io/badge/license-MIT-c0392b)](LICENSE)
[![Native Discord transport tests](https://github.com/red-cup-engineering/discord-rest-transport-service/actions/workflows/native-transport-tests.yml/badge.svg)](https://github.com/red-cup-engineering/discord-rest-transport-service/actions/workflows/native-transport-tests.yml)
[![Indigenous data: CARE](https://img.shields.io/badge/Indigenous%20data-CARE-4b6f44)](https://github.com/red-cup-engineering/.github/blob/main/GOVERNANCE.md)
[![Tips welcome](https://img.shields.io/badge/tips-welcome-d4a017)](https://github.com/561-group/.github/blob/main/TIPS.md)
<!-- 561-group-standards:badges:end -->

Discord REST protocol capability: typed carriers, dependency-free codecs, bot transport, and narrow user-OAuth identity and guild-membership transport shared across the discord-services-section.

## Bounded public invite observation

`DiscordRestTransport.getInvite(code)` performs one bot-authorized
`GET /invites/{code}?with_expiration=true` against the configured Discord
REST provider. It reads the invite's *reported* code, guild ID, channel ID,
expiry and the host observation instant into
`discord.invite-provider-observation/v1`. It deliberately excludes inviter
identity, user/member counts, private guild content and any assertion that a
link is permanent, that a user can join, or that Discord participation confers
governance membership. The source pure decoder `discordInviteFromWire`
does not, by itself, authenticate externally supplied response JSON.

The observed guild ID must be compared by the consuming community service to
its original currently selected guild record; the public invite URL and any
community authorization or accepted delivery belong to their independent
owners. `expiryState: "none-reported"` means Discord returned null for
`expires_at` at the observation instant—not irrevocability. Missing expiry is
`"unknown"`, never silently null. A wrong guild, removed code, provider
outage, or rate limit is not a verified community doorway. This GET
**does not retry 429**; upstream orchestration may obey provider retry
headers under its own explicit budgets. Other preexisting transport retry
behavior is unchanged.

Source: [Discord Get Invite](https://docs.discord.com/developers/resources/invite#get-invite).
Test: `node --test test/invite-observation.test.mjs`; the existing CI
runs the full native test suite on Node 24. These checks do not attest a live
Discord invite or an installed Turntide consumer.
