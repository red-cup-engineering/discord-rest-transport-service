import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordUserOAuthWebSessions } from "../src/discord-user-oauth-session.mjs";

const origin = "https://l-space.561.group";
const callback = origin + "/oauth/discord/callback";
const guildId = "1184863861065658419";

const request = (path, {method="GET",cookie="",body}={}) => new Request(origin+path,{
  method,headers:cookie ? {cookie} : undefined,body,
});
const cookiePair = (response, name) => {
  const set = response.headers.getSetCookie().find(s=>s.startsWith(name+"="));
  assert.ok(set, "expected Set-Cookie for "+name);
  return set.split(";")[0];
};
const json = value => new Response(JSON.stringify(value),{
  headers:{"content-type":"application/json"},
});
function fixture(overrides={}) {
  let clock = 1_000_000;
  let guildMember = {roles:[],pending:false};
  let failure = false, exchanges = 0, refreshes = 0, revoked = 0, memberReads = 0;
  const fetchImpl = async (url, init) => {
    const endpoint = String(url), method = init?.method ?? "GET";
    if (endpoint.endsWith("/oauth2/token") && method === "POST") {
      const fields = new URLSearchParams(String(init.body));
      if (fields.get("grant_type")==="authorization_code") {
        exchanges++;
        assert.equal(fields.get("code_verifier")?.length,43);
        return json({access_token:"access-initial",refresh_token:"refresh-initial",
          expires_in:60,token_type:"Bearer",scope:"identify guilds.members.read"});
      }
      if (fields.get("grant_type")==="refresh_token") {
        refreshes++;
        assert.equal(fields.get("refresh_token"),"refresh-initial");
        return json({access_token:"access-refreshed",refresh_token:"refresh-initial",
          expires_in:3600,token_type:"Bearer",scope:"identify guilds.members.read"});
      }
    }
    if (endpoint.endsWith("/oauth2/token/revoke") && method === "POST") {
      revoked++; return new Response(null,{status:200});
    }
    if (endpoint.endsWith("/users/@me/guilds/"+guildId+"/member")) {
      memberReads++;
      if (failure) return new Response(null,{status:429});
      if (guildMember===null) return new Response(null,{status:404});
      return json(guildMember);
    }
    throw new Error("unexpected original Discord transport endpoint "+endpoint);
  };
  const web = createDiscordUserOAuthWebSessions({
    guildId,clientId:"1184863861065658400",clientSecret:"server-secret",redirectUri:callback,
    fetchImpl,now:()=>clock,...overrides,
  });
  return {
    web, now:()=>clock,advance:ms=>{clock+=ms;},setMember:x=>{guildMember=x;},
    setFailure:x=>{failure=x;},get exchanges(){return exchanges;},
    get refreshes(){return refreshes;},get revoked(){return revoked;},
    get memberReads(){return memberReads;},
  };
}
async function begin(t) {
  const start=await t.web.route(request("/oauth/discord/start"));
  assert.equal(start.status,303);
  assert.match(start.headers.get("cache-control"),/no-store/u);
  const target=new URL(start.headers.get("location"));
  assert.equal(target.origin,"https://discord.com");
  assert.equal(target.searchParams.get("scope"),"identify guilds.members.read");
  assert.equal(target.searchParams.get("code_challenge_method"),"S256");
  assert.equal(target.searchParams.get("redirect_uri"),callback);
  return {state:target.searchParams.get("state"),
    pending:cookiePair(start,"__Host-lspace-discord-pending")};
}
async function complete(t,pair) {
  return t.web.route(request("/oauth/discord/callback?state="+pair.state+"&code=valid-one-time-code",
    {cookie:pair.pending}));
}

test("real OAuth redirect and server-held cookie grant a free current guild member an opaque session",async()=>{
  const t=fixture(), started=await begin(t);
  const result=await complete(t,started);
  assert.equal(result.status,303);
  assert.equal(result.headers.get("location"),"/explore");
  const cookieHeaders=result.headers.getSetCookie();
  assert.ok(cookieHeaders.some(s=>s.includes("Secure; HttpOnly; SameSite=Lax")));
  assert.ok(cookieHeaders.some(s=>s.includes("Max-Age=0")));
  const session=cookiePair(result,"__Host-lspace-discord");
  assert.doesNotMatch(session,/access-initial|refresh-initial/);
  const admitted=await t.web.readSession(request("/api/marks",{cookie:session}));
  assert.deepEqual(admitted,{accessToken:"access-initial"});
  assert.equal(t.exchanges,1);
  assert.equal(t.memberReads,1);
  assert.equal(await t.web.route(request("/explore")),null,
    "host keeps the original TUFTE/CAIRN application routes");
});

test("wrong cookie/state, replayed callback and caller-supplied identity cannot authenticate",async()=>{
  const t=fixture(), pair=await begin(t);
  assert.equal((await t.web.route(request("/oauth/discord/callback?state="+pair.state+"&code=x"))).status,403);
  assert.equal((await t.web.route(request("/oauth/discord/callback?state="+pair.state+
    "&state="+pair.state+"&code=x",{cookie:pair.pending}))).status,403);
  assert.equal((await complete(t,pair)).status,303);
  assert.equal((await complete(t,pair)).status,403,"one-use OAuth state");
  assert.equal((await t.web.readSession(request("/api/marks",{cookie:"__Host-lspace-discord=forged"}))),null);
  assert.equal((await t.web.readSession(request("/api/marks",{
    cookie:"__Host-lspace-discord="+"A".repeat(43)+"; __Host-lspace-discord="+"B".repeat(43),
  }))),null,"cookie ambiguity fails closed");
  assert.equal(t.exchanges,1);
});

test("pending, departed and rate-limited Discord membership never issue sessions",async()=>{
  for(const member of [null,{roles:[],pending:true}]) {
    const t=fixture();t.setMember(member);
    const result=await complete(t,await begin(t));
    assert.equal(result.status,403);
    assert.equal(result.headers.getSetCookie().length,0);
    assert.equal(t.memberReads,1);
  }
  const broken=fixture();broken.setFailure(true);
  const rejected=await complete(broken,await begin(broken));
  assert.equal(rejected.status,503);
  assert.equal(rejected.headers.getSetCookie().length,0);
});

test("expired CSRF state and bounded capacities fail without grant",async()=>{
  const expired=fixture();const pair=await begin(expired);
  expired.advance(5*60_000+1);
  assert.equal((await complete(expired,pair)).status,403);
  assert.equal(expired.exchanges,0);
  const full=fixture({maxPending:1});
  assert.equal((await begin(full)).pending.startsWith("__Host-lspace-discord-pending="),true);
  assert.equal((await full.web.route(request("/oauth/discord/start"))).status,503);
});

test("access-token refresh retains server custody; logout revokes local and provider session",async()=>{
  const t=fixture();
  const loggedIn=await complete(t,await begin(t)),session=cookiePair(loggedIn,"__Host-lspace-discord");
  t.advance(31_000); // initial 60s expires early by 30s skew
  assert.deepEqual(await t.web.readSession(request("/explore",{cookie:session})),
    {accessToken:"access-refreshed"});
  assert.equal(t.refreshes,1);
  assert.equal((await t.web.route(request("/oauth/discord/logout",{cookie:session}))).status,405);
  const ended=await t.web.route(request("/oauth/discord/logout",{method:"POST",cookie:session}));
  assert.equal(ended.status,303);
  assert.equal(ended.headers.get("location"),"/");
  assert.equal(t.revoked,1);
  assert.equal(await t.web.readSession(request("/api/marks",{cookie:session})),null);
});

test("installed configuration refuses insecure callback or unsafe redirects",()=>{
  const defaultConfig={guildId,clientId:"123",clientSecret:"secret",redirectUri:callback};
  for(const override of [
    {redirectUri:"http://l-space.561.group/oauth/discord/callback"},
    {redirectUri:"https://attacker.test/callback"},
    {continuePath:"//attacker.test"},
    {guildId:"caller-role-not-an-ID"},
    {cookieNamespace:"evil;Path"},
    {maxPending:100_000},
  ]) assert.throws(()=>createDiscordUserOAuthWebSessions({...defaultConfig,...override}),TypeError);
});
