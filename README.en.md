# dsh-astudio-connect

English | [中文](./README.md)

Bring the models signed in to the AStudio desktop app into [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) with zero configuration.

An adaptation of the design in [dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect), heavily slimmed down for AStudio's maas-api (a standard OpenAI protocol).

> **Zero configuration**: reuses your local AStudio sign-in. No second login, nothing written to disk.

## Table of Contents

- [Installation](#installation)
- [Features](#features)
- [Command Line](#command-line)
- [How It Works](#how-it-works)
- [Configuration](#configuration)
- [Model Catalog](#model-catalog)
- [Reasoning Effort and Probing](#reasoning-effort-and-probing)
- [Model Visibility](#model-visibility)
- [Points Balance Badge](#points-balance-badge)
- [Settings Card](#settings-card)
- [Update Check and Host Heartbeat](#update-check-and-host-heartbeat)
- [Location Discovery (Windows)](#location-discovery-windows)
- [DSH Version Support](#dsh-version-support)
- [Known Limitations](#known-limitations)
- [Security](#security)
- [Development](#development)
- [Disclaimer](#disclaimer)
- [License](#license)

## Installation

### Prerequisites

- Node.js `^22.19.0 || >=24.0.0` installed locally
- The AStudio desktop app installed and signed in (the plugin reuses the app's sign-in state; account switches follow automatically)
- A DeepSeek Harness runtime — see [DSH Version Support](#dsh-version-support)

### Install the plugin

The plugin registers its manifest through `cordis.patch.yml`, and DSH loads it at startup.

```bash
# Install from the local directory
npm install -D ./dsh-astudio-connect
```

Or add this directory path in the DSH plugin manager.

### Verify

After installing you must **fully quit and restart DSH** (DSH loads plugins at startup; refreshing the page is not enough), then confirm:

1. An **AStudio** group appears in the model picker;
2. Pick a model from that group and complete a short conversation that answers normally.

Both must hold for the install to count as successful. If the group does not appear, start with `doctor` in the [Command Line](#command-line) section to check sign-in state and the config path.

> You can also hand the install to an agent you already have locally (DSH Agent, Codex, Claude Code, Cursor, …) by sending it this paragraph verbatim:
>
> Please install and verify the DSH (DeepSeek Harness) plugin dsh-astudio-connect (local directory: `<repo path>`):
> Read the project README first, and confirm which interface I actually use (Web / Desktop / TUI) and the DSH kernel version;
> Install from the local directory using the `cordis.patch.yml` registration, without modifying dependency packages or bypassing host validation;
> Ask me for consent and back up any local file or configuration change;
> Once installed, verify that an AStudio group appears in the model picker, and run a short conversation with me.

## Features

- **Works out of the box**: no extra configuration after the plugin is installed and enabled.
- **Credential reuse**: reads AStudio's `experimental_bearer_token`; no separate OAuth flow.
- **Standard protocol**: maas-api speaks standard OpenAI-compatible protocol, which pi-ai supports natively — no protocol translation.
- **Full capability bridge**: non-streaming, streaming SSE, tool calls, `reasoning_content` from reasoning models, and context compaction all reuse the DSH host's own implementations.
- **Model catalog**: taken from AStudio's own model-manager endpoint (the same document the AStudio UI renders), carrying real context windows and max output, with a three-tier fallback of live → saved → built-in.
- **Reasoning-effort probing**: for models that declare no levels, sends a minimal sentinel-bearing request under your explicit consent, confirming the upstream actually validates `reasoning_effort` before accepting which levels it accepts.
- **Model visibility**: pick which models appear in the picker from the settings card; preferences are stored per signed-in account, and hiding only affects selectability, not sessions already using that model.
- **Balance at a glance**: with an AStudio model selected, the composer shows the account's general and Spark points balances beside the model picker, with a ↻ manual refresh and no automatic polling.
- **Settings card**: the AStudio Connect card under the sidebar Plugins panel, split into Account / Context / Probe sections, with manual catalog refresh and probing.
- **Command-line diagnostics**: `status`, `doctor` and `logout` — never emit credential material.
- **Update check**: compares against npm's public dist-tags to decide whether a newer release exists, and enriches with GitHub release notes.

## Command Line

The plugin ships a `dsh-astudio-connect` executable (the `bin` in `package.json`). It **does not start the host and does not load pi-ai**, so it can run standalone and be used to troubleshoot from anywhere:

```
Usage: dsh-astudio-connect <doctor|status|logout> [--provider astudio] [--json]

  doctor   secret-free sign-in and environment diagnostics
  status   sign-in state, catalog source, and model count
  logout   clear the plugin in-memory credential cache

  --provider  which provider to inspect; defaults to astudio
  --json      emit one secret-free JSON document (doctor/status only)
```

Run it from a local checkout (when not globally installed):

```bash
node lib/bin.js status
node lib/bin.js doctor --json
node lib/bin.js logout
```

| Command | Output | Exit code |
|---|---|---|
| `doctor` | Config file path and presence, sign-in state, whether the model-manager token exists, remediation hints | `0` when `signed-in` **and** the config file exists, otherwise `1` |
| `status` | Sign-in state, catalog source, model count | `0` when `signed-in`, otherwise `1` |
| `logout` | Clears the plugin's own in-memory credential cache | Always `0` |

Behaviour guarantees:

- **Writes nothing**: none of the three commands writes AStudio's `config.toml`; `logout` clears only the plugin's own in-memory cache, leaves the desktop app's sign-in alone, and does not promise to make the model group disappear (it still applies as long as the app's credential file is present).
- **Never echoes credentials**: output carries only `tokenLength` and "present / absent", never the token itself; JWT-shaped strings in error text are replaced with `[redacted token]`.
- **`--provider` accepts only `astudio`** — anything else errors out.

> **Known behaviour**: the catalog source reported by `status` is always `built-in`. The live refresh happens inside the host process, and a standalone CLI process does not issue that request, so it reflects the built-in roster rather than the catalog the host is actually using. For the host's real source, see the Account section of the settings card.

## How It Works

The plugin registers maas-api's models into DSH's `llm` seam through a three-layer bridge:

1. **Credential layer** (`auth.ts`): reads `experimental_bearer_token` from AStudio's `config.toml`, caches it in memory, never writes it to disk.
2. **Local shim** (`shim.ts`): starts an OpenAI-compatible endpoint on `127.0.0.1`, validates four inbound guards, then forwards to maas-api.
3. **pi-ai adapter** (`adapter.ts`): registers the shim's endpoint as DSH's `astudio` provider using `openAICompletionsApi()` + `PiAiAdapter`.

```
DSH (llm seam) → AStudioPiAiAdapter → 127.0.0.1 shim → maas-api (Bearer token)
```

The model catalog and the points balance travel over two separate read-only paths that do not go through the shim:

```
model-manager API ← modelBearerToken (model roster and context parameters)
account points API ← ssoSessionId (general / Spark points balance)
```

All three credentials come from AStudio's own files, but they serve different purposes and are not interchangeable.

### Shim routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Liveness probe |
| `GET` | `/v1/models` | Model roster, **hidden entries filtered out** |
| `POST` | `/v1/chat/completions` | Forwarded to maas-api, request body and streaming response passed through |

Request bodies are capped at 64 MB; a broken stream gets a terminating `data: [DONE]\n\n`; a single stream idles out after 300 seconds.

The port the shim binds avoids the ports the fetch standard refuses to connect to (`FETCH_BLOCKED_PORTS` in `loopback.ts`): the OS may hand out an ephemeral port that fetch will not dial, in which case the shim listens successfully yet every request fails with `TypeError: fetch failed`. So it rebinds, up to 16 attempts.

## Configuration

Plugin configuration is managed through DSH's plugin page (on 0.2.x: sidebar **Plugins** panel → AStudio Connect):

| Field | Description |
|------|------|
| `displayName` | Provider name shown in the model picker (default `AStudio`) |
| `configPath` | Explicit path to AStudio's `config.toml` |

`cordis.patch.yml` only registers the plugin; it does not change the profile's current default model.

## Model Catalog

The model roster and context parameters come from AStudio's **model-manager** endpoint (`GET /api/v1/model-manager/models`, production base `https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager`), which is the same document the AStudio UI renders. Authentication uses `modelBearerToken` from `astron-session.json` — a separate credential from the chat `experimental_bearer_token`.

> `/v1/models` is deliberately not used: that OpenAI-compatible discovery endpoint answers with a smaller, staler subset and would drop models that are in fact callable.

Catalog parsing rules:

- Only models with `visibility` of `list` are kept; those with `supported_in_api` of `false` are dropped;
- Context window and max output come from the upstream's real values (e.g. `spark-x2.6-preview` is 262144 / 100000);
- The upstream's `none` in `supported_reasoning_levels` is translated into a "thinking can be switched off" capability flag rather than treated as an effort level;
- When merging, the built-in roster's order and names win; models unique to the upstream are appended at the end.

**Fallback order**: live catalog → last successful snapshot → built-in roster. Snapshots are written to `$DSH_HOME/.astudio-connect/catalog.json`, stored per local identity. The catalog source (`live` / `saved` / `fallback`) and the fetch time are both shown on the settings card.

The current built-in roster covers:

- **Reasoning models**: `spark-x2.5`, `spark-x2.6-preview` (thinking switchable, `low` / `high` / `max`)
- **Chat models**: `spark-x2.5-4b`, `xopglm52`, `xopdeepseekv4pro`, `xopdeepseekv4pro0813`, `xopdsv4flash0731in`, `astronclaw-auto`

## Reasoning Effort and Probing

For WorkBuddy-style upstreams, reasoning-level information is scattered across upstream endpoints and the client's private UI logic, and the model roster changes quickly. If the plugin backfilled a uniform level for every model that declares none, it would have to keep chasing undocumented product logic with no stable contract.

Testing also shows that some models accept the `reasoning_effort` parameter yet may ignore unknown values and fall back to default behaviour — a single successful response does not prove a level is genuinely available.

So this plugin uses a **user-consented, dynamically discovered** approach:

1. The Probe section of the settings card offers Probe / Re-probe for models with no declared levels;
2. Clicking sends a minimal request carrying a sentinel string (`max_tokens: 1`, 30 second per-request timeout);
3. Upstream accepts → recorded as `validating`, storing only the accepted levels; upstream rejects with `invalid_parameter_value` → recorded as `rejected` / `non-validating`;
4. Results are persisted per `account:modelId` and expire after 24 hours.

Probing consumes a small amount of points. A result only means the current upstream accepts that level — **it does not promise that reasoning quality, speed, or point consumption will change**.

The mapping from `reasoning_effort` to pi-ai levels only exposes levels the upstream declared; `off` is exposed only when the model declares `none` (i.e. thinking can be switched off).

## Model Visibility

In the Context section of the settings card you can check which models appear in the model picker. Visibility preferences are written to `$DSH_HOME/.astudio-connect/model-visibility.json`, stored per local identity.

- **Only affects selectability**: hidden models do not appear in the picker, in `listModels()`, or in the shim's `/v1/models`; but sessions already using that model are unaffected, and `resolveModel()` does not filter.
- **New accounts and newly listed models are visible by default.**

AStudio's token carries no stable uid, so this plugin has a single local identity, `astudio-local` — catalog snapshots, visibility preferences and probe records all hang off it, with no multi-account isolation.

## Points Balance Badge

With an AStudio model selected, the composer's tool row (beside the model picker) shows the account's two points balances, with a ↻ manual refresh on the right:

```
General 1393 · Spark 24621
```

The two balances are shown separately and are **never added together**, because they pay for different things:

- **General points** (`totalBalance`): every model, plus plugins and Skill calls.
- **Spark points** (`sparkTotalBalance`): Spark-branded models only.

The data comes from the account endpoint the AStudio desktop app itself uses (`https://agent.xfyun.cn/xingchen-studio/points/balance`). AStudio's settings page requests its own loopback service, which forwards to the account API carrying the desktop session cookie; this plugin reaches the same upstream directly using the `ssoSessionId` already present in `astron-session.json`, so it **adds no location discovery and does not require AStudio to be running**.

> `ssoSessionId`, the `modelBearerToken` used by the catalog, and the chat `experimental_bearer_token` all live in the same file — but they are three credentials for three different purposes.

Behaviour guarantees:

- **Read timing**: once when the badge appears, and again when you click ↻. **No timed polling** — every read hits the upstream.
- **Visibility**: appears only when an AStudio model is selected in the current session; no request is issued under a provider-independent model.
- **Never shows a fabricated number on failure**: if the balance cannot be read it degrades instead of rendering "unreadable" as `0`.
- **30 second cache**: successful reads are cached for 30 seconds; ↻ sends `?refresh=1` to bypass the cache. Failures are not cached — the next read asks the upstream again.

| Situation | Display |
|---|---|
| Network failure / upstream error | "Unavailable", ↻ retries |
| Sign-in expired (upstream `code: 80000`, or 401/403) | "Sign-in expired" — sign in to AStudio again |
| Account has no Spark pool | Only general points are shown; no `0` |
| The balance really is 0 | Shows `0` normally (0 is a real balance, not "unknown") |
| Never signed in to AStudio | The badge does not appear at all |

> **Known limitation**: the account endpoint only provides aggregate balances, with no per-transaction detail — the AStudio desktop app itself is the same way (it directs users to the web to view details). So the badge can reflect *balance changes* but cannot say *exactly how much this conversation consumed*.

If the badge shows "Unavailable" and clicking ↻ does nothing, first confirm the plugin artifacts match the running DSH version: DSH loads plugins at startup, so after rebuilding you must **fully quit and restart DSH** (refreshing the page is not enough).

## Settings Card

Sidebar **Plugins** panel → AStudio Connect. One card split into three sections, switching between Chinese and English with the plugin language:

- **Account**: sign-in state, config file path, catalog source (live / saved / built-in), model count, and a one-click catalog refresh.
- **Context**: each model's context window and max output, plus the model visibility toggles.
- **Probe**: probe state and accepted levels for models with no declared levels, with manual probe / re-probe.

The card reads the status document once on mount and then every 60 seconds; all data comes from the same-origin `GET /astudio/status` and carries no credential material.

### Same-origin routes

| Path | Method | Purpose | Guards |
|---|---|---|---|
| `/astudio/status` | `GET` | Status document | loopback Host + Origin |
| `/astudio/points` | `GET` | Points balance (`?refresh=1` bypasses the cache) | loopback Host + Origin |
| `/astudio/update` | `GET` | Version and update info | loopback Host + Origin |
| `/astudio/probe/{modelId}` | `POST` | Reasoning-effort probing | loopback Host + Origin + in-process probe key |

The probe route separately requires an in-process key (handed out with the status document, rotated per process, never persisted): the status route's loopback check stops a DNS-rebinding **page**, and that is not the same as authorising a **state-changing** action.

## Update Check and Host Heartbeat

**Update check** (`update.ts`): reads npm's public dist-tags first to decide whether an update exists — looking only at the `latest` tag, since pre-release channels are not this plugin's release line; only once an update is confirmed does it query GitHub releases for the version notes. Both requests have a timeout (8 seconds) and a response body size cap, and the browser re-validates the version numbers, release URL and range with `parseAStudioUpdateResult` before rendering; any mismatch suppresses rendering.

**Host heartbeat** (`host-heartbeat.ts`): after the plugin registers the provider, it writes a JSON document containing `pid` and `registeredAt` to `$DSH_HOME/.astudio-host-heartbeat.json`; the host deletes it on `ctx.dispose()`.

The heartbeat distinguishes "the host is still running" from "the host crashed and left the file behind". Checking the PID alone is not enough — after a crash the OS may hand the same PID to an unrelated process, and that uncleared heartbeat would falsely report "host alive". So the condition is that the PID exists **and** the process holding it started no later than `registeredAt`; when the start time cannot be read, it degrades to a plain PID check.

The browser half writes no files and reports failure only through `console.error`. That asymmetry is intentional: the host is the load-bearing half, and a missing heartbeat unambiguously means the host never started.

## Location Discovery (Windows)

The plugin does not assume AStudio lives at a fixed path. It locates the data directory in this order:

1. A path explicitly set in the `configPath` setting (used verbatim, not probed)
2. The `ASTUDIO_DATA_HOME` environment variable (used verbatim, not probed)
3. AStudio's own registry record: `ProductionDataRoot` / `ProductionAcodeHome` under `HKCU\Software\AStudioStorage`
4. The `<install directory name> Data` directory beside the install directory

Item 3 is the record AStudio itself writes, so moving drives or reinstalling needs no configuration at all. A record that exists but is incomplete or of an unsupported schema version raises an explicit error rather than silently degrading to "not connected" — an older install this plugin cannot read must not win over a newer one.

Registry value-name prefixes are split by release channel: `production` → `Production*`, `canary` → `Canary*`, `development` → `Development*`; item 4's directory name follows as `AStudio Data` / `AStudio Canary Data` / `AStudio Dev Data`.

Automatic discovery is not implemented on non-Windows platforms; set `ASTUDIO_DATA_HOME` explicitly there.

## DSH Version Support

The plugin declares host dependencies in two places, both pinned to seam package version **`0.2.0-rc.2`**.

**Host-side `peerDependencies`** (run in the host process):

| Package | Purpose |
|---|---|
| `dsh-llm` / `dsh-llm-pi-ai` | Register the `astudio` provider |
| `dsh-host-webserver` | Routes for the settings card and points badge |
| `dsh-settings` | Plugin configuration |
| `dsh-home-paths` | Where snapshots, visibility preferences and the heartbeat are written |
| `dsh-attachment` | Attachment passing |
| `@deepseek-ai/cordis` | `^4.0.2` (`4.x`) |
| `@deepseek-ai/schemastery` | `^3.18.2` |
| `react` | `^18.2.0` |

**Browser-side `dsh.client.inject`** (host packages the client bundle depends on):

`dsh-client-ui-renderer`, `dsh-client-ui-conversation`, `dsh-client-ui-model-selection`, `dsh-client-locale`, `dsh-api-remotes`, `dsh-api-session-controller`.

| Status | Version | Notes |
|---|---|---|
| **Supported** | DSH Desktop **2.0.17** (seam `0.2.0-rc.2`) | Current development and verification environment: provider registration, settings card and points badge all confirmed on a real machine |
| **Not supported** | DSH **0.1.5** | Compatibility removed, see below |

**About 0.1.5**: DSH 0.1.5 used `settings.plugin.item` (keyed, one card per namespace); 0.2.x switched to `plugins.bundle.config` (dispatching a whole bundle page by package name). The plugin **only registers `plugins.bundle.config`**, so no settings card renders on 0.1.5.

Why compatibility was removed: no published package declares `settings.plugin.item` any more, and that registration path cannot be verified by any means other than compilation in the current dependency tree — keeping it would be dead code. 0.2.x hosts are unaffected (that slot never fires there).

> If you still need 0.1.5, re-add that seam's SlotMap mirror and registration in `src/client/index.tsx`, verify on a real 0.1.5 host, then declare support.

### pi-ai version constraint

`@earendil-works/pi-ai` must be **`0.87.1`** — a hard constraint, not a recommendation.

Failure mechanism: the host appends a system message to each request (pi-ai 0.87's `collapseSystemMessages`), and a stale copy that gets resolved reads `.length` on a block it does not recognise inside `estimateMessageTokens`, so every request fails with `PI_AI_ERROR` before it reaches the upstream. The typical trigger is a profile with `nodeLinker: hoisted` + `autoInstallPeers: false`: the plugin's peers are not installed, so an older pi-ai from another plugin occupies the profile root and wins bare-specifier resolution.

At startup the plugin checks the actually-resolved copy with `pi-ai-guard.ts`; a mismatch logs one warning only (non-fatal) — the host may still serve other providers, but this plugin's requests will fail. If that warning appears, check for duplicate pi-ai copies being resolved.

> Node works the same way: the plugin is published as ESM, and the `bin` depends on Node 22.19+ / 24+ module resolution behaviour.

## Known Limitations

- **Image input is not enabled yet**: the adapter already maps a model to `input: ['text', 'image']` based on the catalog declaration, but model-manager parsing currently hardcodes `supportsImages: false` (and the upstream document has no corresponding field), so every model accepts plain text only.
- **Automatic location discovery is implemented only on Windows**: macOS / Linux need `ASTUDIO_DATA_HOME` set explicitly.
- **A single local identity**: AStudio's token carries no stable uid, so catalog snapshots, visibility preferences and probe records all hang off `astudio-local`, with no multi-account isolation.
- **No per-transaction billing detail**: the account endpoint only provides aggregate balances, so the badge can only reflect balance changes.
- **No long-term compatibility guarantee for upstream private endpoints**: the model catalog, account endpoint and reasoning-level information are the AStudio client's own interfaces rather than an official open API, and upstream changes may break the plugin. In that case it degrades through "last successful catalog → built-in roster" and labels the source on the card, but long-term compatibility cannot be promised.
- **The CLI's `status` does not reflect the live catalog**: see the note in [Command Line](#command-line).
- **No account-switch following**: unlike WorkBuddy's two variants, AStudio is a single product, so the plugin does not replicate variant-level capabilities.

## Security

- Credentials are cached only in memory and never written to any file; points reads re-read the session file every time (so an AStudio re-login takes effect immediately) but only take `ssoSessionId`.
- The shim binds only to `127.0.0.1` and accepts no external network access.
- Inbound requests must pass four checks: Host, Origin, Content-Type and the Bearer shared secret; the Host check blocks DNS rebinding.
- The shared secret is a random 32-byte value generated per process, compared in constant time with `timingSafeEqual`; the real AStudio token is resolved by the credential layer alone and never travels in a request header.
- Tokens are never echoed in any UI or log; the CLI strips JWT-shaped strings from error text.
- The points route and the status route apply the same loopback Host / Origin double check; responses contain only numbers and state, and account credentials stay inside the host process.
- Every upstream response is treated as untrusted input: streaming reads carry size caps, and route responses are re-validated in the browser before rendering.

## Development

```bash
npm install
npm run check      # typecheck + test + build
npm test           # run 262 tests (28 test files)
npm run build      # produce lib/ (the directory DSH actually loads)
```

In `lib/`, `index.js` is the host entry, `client.js` is the browser half, and `bin.js` is the command line. Host and runtime dependencies (pi-ai, cordis, schemastery, the `dsh-*` packages) are all declared external and not bundled, avoiding duplication with the host modules in the profile; the browser side keeps only React as a runtime dependency.

Strict TypeScript, with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` enabled.

## Disclaimer

This project is **for personal learning and research only**. It drives only the user's own AStudio account on the local machine — do not use it commercially or beyond reasonable personal use.

Users must comply with AStudio's terms of service; any consequence arising from use of this project (including but not limited to account restrictions, cleared credits, or service interruption) is borne by the user alone.

The authors accept no liability for any direct or indirect damages arising from the use or misuse of this project.

This project is not affiliated with, authorised by, or endorsed by iFLYTEK, AStudio, or DeepSeek. Names appearing in this document are used only to describe compatibility; their trademark rights belong to their respective owners.

## Acknowledgements

[corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) (MIT) — the overall structure, the settings card sections, the reasoning-effort probing and the command-line design of this project are all implemented following it.

## License

[MIT](./LICENSE)
