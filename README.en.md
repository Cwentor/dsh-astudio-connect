# dsh-astudio-connect

English | [中文](./README.md)

Bring the models signed in to the AStudio desktop app into [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) with zero configuration.

An adaptation of the design in [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect), heavily slimmed down for AStudio's maas-api (a standard OpenAI protocol).

> **Zero configuration**: reuses your local AStudio sign-in. No second login, nothing written to disk.

## Table of Contents

- [Installation](#installation)
- [Features](#features)
- [Configuration](#configuration)
- [Model Catalog](#model-catalog)
- [Reasoning Effort and Probing](#reasoning-effort-and-probing)
- [Model Visibility](#model-visibility)
- [Points and the daily claim](#points-and-the-daily-claim)
- [Billing and Points](#billing-and-points)
- [Settings Card](#settings-card)
- [DSH Version Support](#dsh-version-support)
- [Known Limitations](#known-limitations)
- [Security](#security)
- [Development](#development)
- [Disclaimer](#disclaimer)
- [Related Projects / Community Ecosystem](#related-projects--community-ecosystem)
- [Acknowledgements](#acknowledgements)
- [License](#license)

## Installation

### Prerequisites

- Node.js `^22.19.0 || >=24.0.0` installed locally
- A xfyun account: sign in with a WeChat QR code in DSH Settings — **AStudio is not required**. If the app is installed and signed in, the plugin reuses that sign-in too.
- A DeepSeek Harness runtime — see [DSH Version Support](#dsh-version-support)

### Install the plugin

**Command line**:

```bash
dsh plugin --profile web add dsh-astudio-connect@latest
```

Replace `web` with the profile you actually boot.

> The plugin version must match your DSH kernel generation, or the host refuses to load it. Installing the latest is enough; if it is still refused, report your DSH kernel version and the full error on [Issues](https://github.com/Cwentor/dsh-astudio-connect/issues) rather than bypassing the host check.

### Verify

After installing you must **fully quit and restart DSH**, then confirm:

1. An **AStudio** group appears in the model picker;
2. Pick a model from that group and complete a short conversation that answers normally.

Both must hold for the install to count as successful. If the group does not appear, run `npx dsh-astudio-connect doctor` inside the profile directory (`$DSH_HOME/profiles/<name>`) to check sign-in state.

> You can also hand the install to an agent you already have locally (DSH Agent, Codex, Claude Code, Cursor, …) by sending it this paragraph verbatim:
>
> Please install and verify the DSH (DeepSeek Harness) plugin dsh-astudio-connect (npm package: `dsh-astudio-connect`):
> Read the project README first, and confirm which interface I actually use (Web / Desktop / TUI) and the DSH kernel version;
> On Desktop use **Add plugin** in the Plugins panel and enter `dsh-astudio-connect`; for a command-line profile use `dsh plugin --profile <name> add dsh-astudio-connect@latest`, without modifying dependency packages or bypassing host validation;
> If the host refuses it because the kernel generation does not match, give me my DSH kernel version and the full error;
> Ask me for consent and back up any local file or configuration change;
> Once installed, verify that an AStudio group appears in the model picker, and run a short conversation with me.

## Features

- **Works out of the box**: no extra configuration after the plugin is installed and enabled.
- **Credential reuse**: reads AStudio's `experimental_bearer_token`; no separate OAuth flow.
- **Standard protocol**: maas-api speaks standard OpenAI-compatible protocol, which pi-ai supports natively — no protocol translation.
- **Full capability bridge**: non-streaming, streaming SSE, tool calls, `reasoning_content` from reasoning models, and context compaction all reuse the DSH host's own implementations.
- **Model catalog**: taken entirely from AStudio's own model-manager endpoint, carrying real context windows and max output; the plugin ships no roster of its own and reports "No models available" when it cannot fetch one.
- **Reasoning-effort probing**: for models that declare no levels, sends a minimal sentinel-bearing request under your explicit consent, first confirming the upstream really validates `reasoning_effort`, then which levels it accepts.
- **Model visibility**: pick which models appear in the picker from the settings card; a model you switch off leaves the picker immediately, and a session using it must select another before it can send.
- **Points and the daily claim**: a new **AStudio points** section in Settings lists the account's general and Spark balances with Refresh and Claim, so neither needs the AStudio client — nor an AStudio model selected.
- **Settings card**: the AStudio Connect card under the sidebar Plugins panel, split into Account / Models / Probe sections, with manual catalog refresh and per-model probing.
- **Command-line diagnostics**: `status`, `doctor` and `logout` — never emit credential material.
- **Update check**: compares against npm's public dist-tags to decide whether a newer release exists, and enriches with GitHub release notes.

## Configuration

Plugin configuration is managed through DSH's plugin page (on 0.2.x: sidebar **Plugins** panel → AStudio Connect):

| Field | Description |
|------|------|
| `displayName` | Provider name shown in the model picker (default `AStudio`) |
| `configPath` | Explicit path to AStudio's `config.toml` |

`cordis.patch.yml` only registers the plugin; it does not change the profile's current default model.

## Model Catalog

The model roster and context parameters come from AStudio's **model-manager** endpoint.

**Catalog parsing rules:**

- Only models with `visibility` of `list` are kept; those with `supported_in_api` of `false` are dropped, as are rows missing a context window or output budget;
- Context window and max output come from the upstream's real values (e.g. `spark-x2.6-preview` is 262144 / 100000).

**The plugin ships no model roster at all.** The list is whatever upstream actually returned:

1. Live catalog — the models this fetch returned;
2. Last successful snapshot — that same upstream answer, when this fetch could not be made (network, auth, malformed response);
3. Neither — the list is empty.

Case 3 is not filled in with a built-in roster, a placeholder or a default model: the settings card says "No models available" and names the reason (signed out / endpoint error / unreadable response / unreachable / upstream listed none), and the model picker shows the host's own "No models available". An upstream answer that is **explicitly empty** is treated the same way and written to the snapshot — otherwise a later failed refresh would resurrect models upstream has withdrawn. A response whose `models` field is missing, of the wrong type, or whose rows are all unusable is treated as a malformed response rather than as "upstream withdrew every model", and leaves the existing snapshot untouched.

## Reasoning Effort and Probing

For WorkBuddy-style upstreams, reasoning-level information is scattered across upstream endpoints and the client's private UI logic, and the model roster changes quickly. If the plugin backfilled a uniform level for every model that declares none, it would have to keep chasing undocumented product logic with no stable contract.

Testing also shows that some models accept the `reasoning_effort` parameter yet may ignore unknown values and fall back to default behaviour — a single successful response does not prove a level is genuinely available.

So this plugin uses a **user-consented, dynamically discovered** approach:

1. The Probe section of the settings card offers Probe / Re-probe for models with no declared levels;
2. Clicking sends a minimal request carrying a sentinel string (`max_tokens: 1`, 30 second per-request timeout);
3. Upstream accepts → recorded as `validating`, storing only the accepted levels; upstream rejects with `invalid_parameter_value` → recorded as `rejected` / `non-validating`;
4. Results are persisted per `account:modelId` and expire after 24 hours.

Probing sends one real upstream request, consuming a small number of upstream tokens (like every other call the plugin makes, that counts against upstream usage, not AStudio points — see [Billing and Points](#billing-and-points)). A result only means the current upstream accepts that level — **it does not promise that reasoning quality or speed will change**.

The mapping from `reasoning_effort` to pi-ai levels only exposes levels the upstream declared; `off` is exposed only when the model declares `none` (i.e. thinking can be switched off), and **what actually goes out on the wire is `none`, not `off`** — upstream's vocabulary is only `none` / `high` / `max`, and a literal `off` gets the whole request refused with 10005.

## Model Visibility

In the Context section of the settings card you can check which models appear in the model picker. Visibility preferences are written to `$DSH_HOME/.astudio-connect/model-visibility.json`, stored per local identity.

- **Only affects selectability**: hidden models do not appear in the picker, in `listModels()`, or in the shim's `/v1/models`; but sessions already using that model are unaffected, and `resolveModel()` does not filter.
- **New accounts and newly listed models are visible by default.**

AStudio's token carries no stable uid, so this plugin has a single local identity, `astudio-local` — catalog snapshots, visibility preferences and probe records all hang off it, with no multi-account isolation.

## Points and the daily claim

The last row of DSH's Settings navigation is **AStudio points**; opening it shows both balances and both actions:

```
General points                       1393
────────────────────────────────────────
Spark points                        24621
────────────────────────────────────────
One daily login reward per day…  [Claim] [Refresh]
```

The two balances are shown separately and are **never added together**, because they pay for different things:

- **General points** (`totalBalance`): every model, plus plugins and Skill calls (AStudio's own plugins and Skills — **not this plugin**).
- **Spark points** (`sparkTotalBalance`): Spark-branded models only.

The data comes from the account endpoint the AStudio desktop app itself uses (`https://agent.xfyun.cn/xingchen-studio/points/balance`). AStudio's settings page requests its own loopback service, which forwards to the account API carrying the desktop session cookie; this plugin reaches the same upstream directly with that same cookie, so it **does not require AStudio to be running**. The cookie has two possible sources — a sign-in performed here, or the one AStudio wrote into `astron-session.json` — and ours wins; see [WeChat QR sign-in](#wechat-qr-sign-in).

> `ssoSessionId`, the `modelBearerToken` used by the catalog, and the chat `experimental_bearer_token` all live in the same file — but they are three credentials for three different purposes.

Behaviour guarantees:

- **Read timing**: once when the section opens, and again when you press **Refresh**. **No timed polling of the balance** — every read hits the upstream. (The one thing asked about on a timer is the sign-in QR code; see [WeChat QR sign-in](#wechat-qr-sign-in).)
- **Independent of the session**: this page does not look at the selected model, so the balance is readable with no AStudio model selected — even in a session running someone else's model. (The same numbers used to live in the composer badge, which only appeared while that session had an AStudio model selected.)
- **Fresh on open**: the mount read sends `?refresh=1`, bypassing the host's 30-second cache. Opening Settings is an explicit "how much do I have right now"; answering it with a 30-second-old number would be pointless.
- **Never shows a fabricated number on failure**: an unreadable balance shows `—` with the reason, never `0`.
- **Failures are not cached**, so the next read asks the upstream again.

| Situation | Display |
|---|---|
| Network failure / upstream error | Numbers show `—` with "the account service returned no readable balance"; **Refresh** retries |
| Sign-in expired (upstream `code: 80000`, or 401/403) | "The AStudio sign-in expired" — sign in to AStudio again |
| Account has no Spark pool | Only general points are shown; no `0` |
| The balance really is 0 | Shows `0` normally (0 is a real balance, not "unknown") |
| Never signed in to AStudio | "AStudio is not signed in"; **Claim** is disabled (there is no session to book against) |

> **Known limitation**: the account endpoint only provides aggregate balances, with no per-transaction detail — the AStudio desktop app itself is the same way (it directs users to the web to view details). So this page can reflect *balance changes* but cannot say *exactly how much this conversation consumed*.

> **This number will not move while you chat through the plugin.** An unchanged balance does not mean nothing was spent — it means the call never entered AStudio's ledger at all. See [Billing and Points](#billing-and-points).

### WeChat QR sign-in

The top card of this section is the sign-in. **It needs neither an installed nor a running AStudio**: scan a WeChat code and the plugin exchanges it for the model key itself, storing the credential in `$DSH_HOME/.astudio-login.json` (mode `0600`, readable by this user only).

It performs the same three calls the desktop app does — plain HTTPS, no device fingerprint, no signature, no local service:

```
GET  sso.xfyun.cn/SSOService/wx/scanlogin/qrcode?fd=<ticket>   → WeChat QR image URL
GET  sso.xfyun.cn/SSOService/wx/scanlogin/uids?fd=<ticket>     → code -1 until scanned; then infoList[{uid, ssoSessionId}]
GET  agent.xfyun.cn/xingchen-studio/bot/models/configs         → cookie from the scan; each row carries an api_key
```

That `api_key` is the same kind of value AStudio stores as `experimental_bearer_token`, so once signed in everything on this path — chat, catalog, probing, balances, claim — keeps working with the credential's source switched to the plugin. The ticket is eight characters from AStudio's own reduced alphabet (no `I/l/0/1/o/O`), good for about a minute.

| Situation | Display |
|---|---|
| No sign-in at all | "No sign-in found" + **Sign in with WeChat** |
| Using the app's sign-in | "Using the AStudio app's sign-in"; scanning still replaces it |
| Waiting for the scan | The QR + "Waiting for the scan…", polled every 2 seconds; "The code expired" after a minute |
| WeChat bound to several accounts | The account names are listed; one press finishes |
| WeChat bound to no AStudio account | "That WeChat account has no AStudio account attached"; the code stays up for another WeChat |
| Scanned, but the account offers no model key | "Signed in, but the account offers no model credential"; nothing is stored |
| Signed in | "Signed in from DSH · Account …", and the button becomes **Sign out** |

Precedence is **our own sign-in over AStudio's files**. The reasoning is plain: whoever scanned here already said which account to use, and silently falling back to a stale file from an app that may no longer be installed would make the QR flow look broken. **Sign out** deletes only our file — the app's session is untouched — and the store falls back to it.

> The QR image is fetched by the host and inlined as a data URL, so the page loads nothing from a third-party origin.

### Daily login reward

The same card ends with a **Claim** button, which books AStudio's daily login reward (100 on trial, 200 on basic, 400 on Pro/Enjoy) **without opening AStudio**.

It is not really a check-in. AStudio delivers the reward as a popup: `client-popups/pending` answers one `DAILY_REWARD_DIALOG` carrying `popupId`, `instanceKey` and the amount, and `client-popups/complete` books it. The desktop client fires that completion **itself** the moment the dialog arrives — the button in its UI is decoration — so "today's points landed" really means "AStudio was opened today". This button just makes the days it was not opened count too.

One press is two requests: read the pending list, then report completion. The balance the answer carries is then shown directly, so the press does not trigger a second read. Upstream is idempotent (a repeated completion answers `11003002`, read as "already claimed"), so extra presses cannot mint credit and a mistake cannot drain the account.

| Outcome | Display |
|---|---|
| Claimed | Balance updates in place, `+100` appears in green beside the button and fades after 6 seconds |
| Upstream answered `11003002` — booked before this press | "Already claimed today"; the balance does not move |
| The pending list holds no reward | "Nothing to claim right now"; the balance does not move |
| Sign-in expired (`code: 80000`, or 401/403) | Numbers cleared, "Sign-in expired" |
| Upstream error / no `clientType` for this platform | "Unavailable" |

The third row is deliberately not worded as "already claimed": the two are not the same state. `11003002` is upstream *saying* the popup was booked; an empty list only says the service is holding no reward at this moment — it may not have been issued yet, or the account may not have travelled with the request. Calling that "already claimed" tells someone to stop pressing a button that would still have worked, which is exactly what an earlier version did.

Two identity headers are mandatory (without either, the gateway answers `11001001`): `clientType` (`21` on Windows, `22` on macOS) and `studioVersion`. The latter is only shape-checked, which is why the plugin sends a constant instead of reading the installed app's version — and why this works with AStudio uninstalled.

One more detail `pending` will not forgive: `popupId` is a **positive integer**, and `complete` is parsed with `Number.isSafeInteger` upstream — a string makes the desktop client treat the whole popup config as invalid. The plugin used to read it as a string, which filtered out every reward the service sent while still reporting "already claimed", leaving the reward sitting there for the client to book. It now parses ids the way the client does and skips anything non-positive (the `-3` a preview uses, for instance).

These endpoints are also scoped to the **account**, not just the session: the desktop client sends `ssoSessionId`, `sso_sessionid`, `account_id` and `token` on every account call. The plugin now sends all four, where it used to send only the session.

> This is the plugin's **only** route that changes account state (`POST /astudio/claim`). It writes no local file, and it never touches other popup kinds in the pending list (announcements, feature tours): completing a popup it does not understand would mean deciding something on the user's behalf without knowing what.

If this page reports "Unavailable" and **Refresh** does nothing, first confirm the plugin artifacts match the running DSH version: DSH loads plugins at startup, so after rebuilding you must **fully quit and restart DSH** (refreshing the page is not enough). If the nav row is missing entirely, the installed plugin predates this section — it shipped in the same change that replaced the composer badge with it.

## Billing and Points

> **The short version**: calls made by this plugin **do not consume AStudio points**. AStudio's points are not charged by the model gateway. The desktop app settles them per *turn*, from usage it reports itself. The plugin is a separate process and is never on that path.

The thing that actually charges you is the desktop app, not `maas-api`:

1. The acode runtime opens a turn (carrying `turn_id` / `thread_id` / `session_id`).
2. Each model request goes through the desktop's local model gateway to `model_providers.astron-spark.base_url`; the gateway records that request's input / output / cached tokens as a runtime event.
3. When the turn ends, the desktop app aggregates those events into a `ClientTurnUsageReport` (schema 1.3) and writes it to `turn_billing_outbox` in `state.sqlite`.
4. `DirectPointsGateway.settle()` POSTs that report to `{studioApiBaseUrl}points/deduce-balance` with the desktop session cookie; the server rates it into `ratedPoints` and deducts `GENERAL_POINTS` / `SPARK_POINTS`.

Three conditions must hold at once to be charged: the request belongs to an acode turn, that turn finishes as `completed`, and the settlement request is submitted successfully. Miss any one and nothing is charged — **merely leaving through that gateway is not enough**.

### This is not the same as "free"

- **Upstream tokens are still consumed** — they just never reach AStudio's ledger.
- **The balance gate does not cover the plugin**: when its own balance hits 0, AStudio rejects requests with `402 astron_points_exhausted` — but that check lives in its own local gateway, which the plugin does not traverse. In theory the plugin still works at zero balance (inferred from the current implementation; not tested).
- **Upstream can move metering into the gateway at any time**, keying it on uid or token. When that happens this path closes immediately, with no code change on our side.
- **Do not try to "report back" on the plugin's behalf**: the `session_id` / `thread_id` / `call_ids` / `capability_usages` in `ClientTurnUsageReport` can only be produced by the acode runtime, and the server keeps `turn_billing_usage_reviews` as a missing-usage audit. A fabricated report only lands in the audit table; it does not make the books right.

The points page reads AStudio's own ledger, so of course it stays still while you chat through the plugin — **an unchanged balance does not mean nothing was spent, only that the spend missed that ledger**. Read the [Disclaimer](#disclaimer) before using this.

## Settings Card

Sidebar **Plugins** panel → AStudio Connect. One card split into three sections, switching between Chinese and English with the plugin language:

- **Account**: sign-in state, catalog source (live / saved / no models), model count, and a one-click catalog refresh.
- **Models**: a visibility switch per model, committed by **Save** — a model switched off disappears from DSH's model picker right away. A session that was using that model has to select another one before it can send again. Until then the card says "n unsaved" in its header and "once saved, n of m exposed to DSH" in the body; **Discard** drops the draft.
- **Probe**: probe state and accepted levels per model, with per-model probe / re-probe. A press turns the button into "Probing…" and answers with a pressed-in displacement plus a haptic tick where the platform has one.

The card reads the status document once on mount and then every 60 seconds; all data comes from the same-origin `GET /astudio/status` and carries no credential material.

### Same-origin routes

| Path | Method | Purpose | Guards |
|---|---|---|---|
| `/astudio/status` | `GET` | Status document | loopback Host + Origin |
| `/astudio/points` | `GET` | Points balance (`?refresh=1` bypasses the cache) | loopback Host + Origin |
| `/astudio/claim` | `POST` | Book the daily login reward | loopback Host + Origin + in-process control key |
| `/astudio/login/qr` | `POST` | Mint a sign-in ticket and its QR code | loopback Host + Origin + in-process control key |
| `/astudio/login/qr/poll` | `POST` | Read the scan state; exchange and store the credential on a scan | loopback Host + Origin + in-process control key |
| `/astudio/login/logout` | `POST` | Forget the plugin's own sign-in (the app's session is untouched) | loopback Host + Origin + in-process control key |
| `/astudio/update` | `GET` | Version and update info | loopback Host + Origin |
| `/astudio/probe/{modelId}` | `POST` | Reasoning-effort probing | loopback Host + Origin + in-process control key |
| `/astudio/visibility/{modelId}` | `POST` | Model visibility (one per changed model, sent by Save) | loopback Host + Origin + in-process control key |

Five write routes (probing, visibility, claim, and the two sign-in routes) require the same in-process control key (handed out with the status document, rotated per process, never persisted): the status route's loopback check stops a DNS-rebinding **page**, and that is not the same as authorising a **state-changing** action. The claim route additionally checks Origin — a cross-site `fetch` reaches `127.0.0.1` just as well, and "another page claimed points for me" is exactly what that header rules out.

## DSH Version Support

| Plugin version | DSH kernel range it supports |
|---|---|
| `0.2.0` | `^0.2.1-rc.2` (from `0.2.1-rc.2`, below `0.3.0`) |
| `0.1.1` | `^0.2.1-rc.2` (from `0.2.1-rc.2`, below `0.3.0`) |
| `0.1.0` | `0.2.0-rc.2` (exact) |

The plugin declares a kernel range in `peerDependencies`; the host's `evaluatePluginCompatibility` checks it with semver and refuses to load the plugin when the range is unmet. `0.1.0` pinned an exact version, so every kernel rc needed a matching plugin release; from `0.1.1` the requirement is `^0.2.1-rc.2`, which covers every prerelease and the final release of the `0.2.1` line (`rc.3`, `rc.4`, `rc.5` all load as-is), and only a move to `0.3.x` requires a new plugin version. `0.1.0` shipped against `0.2.0-rc.2`, which was the real-machine environment; on the `0.1.1` line provider registration, the settings card and the points section are covered by local unit and integration tests, and the exact desktop build number still needs re-confirming on the new kernel.

`0.2.0` carries the same kernel range as `0.1.1` and adds nothing but features: the points section in Settings (balance and the daily claim) and WeChat QR sign-in. One thing to know before upgrading — **from `0.2.0` the plugin writes a credential file to disk**. That is unavoidable for QR sign-in: without the app, somebody has to hold the session. It lives at `$DSH_HOME/.astudio-login.json`, mode `0600`, created only when you scan a code and deleted when you sign out. If you want the old behaviour — read the app's credentials and write nothing at all — stay on `0.1.1`.

## When the upstream refuses a request

maas-api answers a non-conforming request with a bare `10005 invalid request` and never names the field. The plugin heals the request in the forwarding layer, in this order, without DSH or pi-ai having to change:

1. **Wire repair** — `tool_calls[].function.arguments` that is not a string, a `tool` message with no `tool_call_id`, `content` set to `null`. Every OpenAI-compatible server rejects these, so they are fixed in place and logged at warn level.
2. **Effort guard** — a `reasoning_effort` the model does not declare (or any effort for a model that does not reason) is dropped. The gateway validates the level per model and answers 400 for the whole request otherwise.
3. **Shape fallback** — drop platform-only fields (`store`, `stream_options`, `prompt_cache_key`, …) and rewrite `developer` as `system`; if that still earns a 400, flatten text-only content arrays to strings. The first accepted shape is reused for the rest of the process, so later requests cost no extra round trip.
4. **Self-diagnosis (once per process)** — when every shape is refused, the plugin asks the gateway instead of guessing: it changes one dimension at a time (`max_tokens`, the whole `tools` array, `reasoning_effort`, the message history), then bisects whichever one is at fault. The conclusion is included in the error handed back to DSH (`diagnosis: …`), and what can be fixed is fixed and resent, staying fixed for the process:
   - `max_tokens` above the limit → clamped to 8192;
   - a refused tool definition → dropped by name (logged), the rest still apply;
   - an unsupported effort → removed.

`store` is never sent (`supportsStore: false`), so steps 1–3 normally do nothing and cost no requests.

A refused body is also written to `%TEMP%\dsh-astudio-connect\failed-requests\` (five files at most, 16 MB each) because only the real body shows what the gateway objects to. Those files contain conversation text and stay on the machine; set `ASTUDIO_DUMP_FAILED=0` to disable this, or `ASTUDIO_DUMP_FAILED_DIR` to relocate it.

## Known Limitations

- [ ] **Image input is not enabled yet**: the adapter already maps a model to `input: ['text', 'image']` based on the catalog declaration, but model-manager parsing currently hardcodes `supportsImages: false` (and the upstream document has no corresponding field), so every model accepts plain text only.
- [ ] **Windows only for now**: macOS / Linux are neither adapted nor verified, so they are unsupported.
- [ ] **A single local identity**: AStudio's token carries no stable uid, so catalog snapshots, visibility preferences and probe records all hang off `astudio-local`, with no multi-account isolation.
- [ ] **Plugin calls are not billed to AStudio points**: points are settled by the desktop app per turn, and the plugin creates no turn, so nothing is deducted. For better or worse this is an unmetered path — see [Billing and Points](#billing-and-points). The plugin deliberately offers no way to "report back".
- [ ] **The balance gate does not cover the plugin**: AStudio itself returns `402` at zero balance, but that check lives inside its own local gateway, which the plugin bypasses (inferred, not tested).
- [ ] **No per-transaction billing detail**: the account endpoint only provides aggregate balances, so Settings can only reflect balance changes; plugin calls produce no billing records at all, let alone detail.
- [ ] **No long-term compatibility guarantee for upstream private endpoints**: the model catalog, account endpoint and reasoning-level information are the AStudio client's own interfaces rather than an official open API, and upstream changes may break the plugin. In that case it degrades to "last successful catalog", and says so plainly when there is no snapshot either, but long-term compatibility cannot be promised.
- [ ] **QR sign-in depends on three private upstream endpoints**: `scanlogin/qrcode` and `scanlogin/uids` on `sso.xfyun.cn`, plus the `api_key` inside `bot/models/configs`. If upstream adds a captcha, a signature or a device fingerprint, sign-in stops working (the panel then says "Sign-in is unavailable"), though a credential already stored keeps working.
- [ ] **A stored sign-in is not refreshed**: once its `ssoSessionId` expires you have to scan again; the plugin does not renew it (upstream exposes no renewal endpoint — the client simply signs in again).
- [ ] **One QR sign-in per DSH home**: switching accounts means signing out first; no multi-account coexistence.
- [ ] **The claim button depends on two hard-coded client identity headers**: `clientType` (platform) and `studioVersion` (the constant `3.5.5`). If upstream ever demands a build number, a signature or a device fingerprint, this path dies immediately and the button will only report "Unavailable".
- [ ] **The CLI's `status` now issues one live fetch**: it waits for a real request so it can report the actual catalog source and model count; offline or signed out, it reports `empty` with the matching failure.
- [ ] **No account-switch following**: unlike WorkBuddy's two variants, AStudio is a single product, so the plugin does not replicate variant-level capabilities.

## Security

- Credentials read from AStudio's files are cached only in memory and never written to any file; points reads re-read the session file every time (so an AStudio re-login takes effect immediately) but only take `ssoSessionId`.
- **The only credential written to disk is the session the plugin's own QR sign-in produces**: `$DSH_HOME/.astudio-login.json`, mode `0600`, written only after a person presses **Sign in with WeChat** and completes a scan, and deleted by **Sign out**. Its `ssoSessionId` and model key never appear in any response, UI or log — the panel shows only the account id and nickname.
- The shim binds only to `127.0.0.1` and accepts no external network access.
- Inbound requests must pass four checks: Host, Origin, Content-Type and the Bearer shared secret; the Host check blocks DNS rebinding.
- The shared secret is a random 32-byte value generated per process, compared in constant time with `timingSafeEqual`; the real AStudio token is resolved by the credential layer alone and never travels in a request header.
- Tokens are never echoed in any UI or log; the CLI strips JWT-shaped strings from error text.
- The points route and the status route apply the same loopback Host / Origin double check; responses contain only numbers and state, and account credentials stay inside the host process.
- There are exactly two account-side writes: the claim route reports that today's daily-reward popup is complete and touches no other popup kind, and the sign-in routes write the file above only after a scan. Neither answer carries a credential — only a state and account identity.
- Every upstream response is treated as untrusted input: streaming reads carry size caps, and route responses are re-validated in the browser before rendering.

## Development

```bash
npm install
npm run check      # typecheck + test + build
npm test           # run 302 tests (29 test files)
npm run build      # produce lib/ (the directory DSH actually loads)
```

In `lib/`, `index.js` is the host entry, `client.js` is the browser half, and `bin.js` is the command line. Host and runtime dependencies (pi-ai, cordis, schemastery, the `dsh-*` packages) are all declared external and not bundled, avoiding duplication with the host modules in the profile; the browser side keeps only React as a runtime dependency.

Strict TypeScript, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled.

## Disclaimer

This project is **for personal learning and research only**. It drives only the user's own AStudio account on the local machine — do not use it commercially or beyond reasonable personal use.

Users must comply with AStudio's terms of service; any consequence arising from use of this project (including but not limited to account restrictions, cleared credits, or service interruption) is borne by the user alone.

**This plugin implements neither AStudio's usage reporting nor its points settlement**: calls made through it never enter AStudio's points ledger (mechanism in [Billing and Points](#billing-and-points)). That gap follows from the other side's client-reported billing model — it is not a feature of this project, and it must not be used to evade billing. If you want to pay for these calls, use the official AStudio client.

The authors accept no liability for any direct or indirect damages arising from the use or misuse of this project.

This project is not affiliated with, authorised by, or endorsed by iFLYTEK, AStudio, or DeepSeek. Names appearing in this document are used only to describe compatibility; their trademark rights belong to their respective owners.

## Related Projects / Community Ecosystem

- **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)** (MIT) — the sibling DSH bridge plugin, aimed at the WorkBuddy desktop app. This project follows its overall structure, with AStudio's maas-api as the upstream instead.

> Refer to that project's own documentation for supported versions and installation requirements. It is maintained independently by a third party; listing it is not an endorsement, and is not a stability or compatibility promise about this plugin's internal interfaces.

## Acknowledgements

- **[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect)** (MIT) — the overall structure, the settings card sections, the reasoning-effort probing and the command-line design of this project are all implemented following it.

## License

[MIT](./LICENSE)
