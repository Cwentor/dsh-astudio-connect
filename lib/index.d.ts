import z from "@deepseek-ai/schemastery";
import "@earendil-works/pi-ai";
import "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { Context } from "@deepseek-ai/cordis";
import { SettingsNamespace } from "@deepseek-ai/dsh-settings";
//#region src/upstream.d.ts
/**
 * AStudio maas-api upstream client. Sends standard OpenAI chat/completions
 * requests to maas-api and returns a structured result. No protocol
 * transformation — maas-api speaks standard OpenAI.
 *
 * @module dsh-astudio-connect/upstream
 */
/** Classification of an upstream failure. */
type UpstreamErrorKind = 'auth' | 'not_found' | 'rate' | 'server' | 'client';
/** Result of an upstream request. */
interface AStudioUpstreamResult {
  /** True when the upstream returned 2xx. */
  ok: boolean;
  /** HTTP status code. */
  status: number;
  /** Error classification, or 'ok' on success. */
  kind: UpstreamErrorKind | 'ok';
  /** Human-readable error message. */
  message: string;
  /** Raw fetch Response — caller reads .text() (non-stream) or pipes .body (stream). */
  response: Response;
}
/** Default maas-api endpoint. */
declare const DEFAULT_UPSTREAM_URL = "https://maas-api.cn-huabei-1.xf-yun.com/v1";
/** Options for the upstream client. */
interface AStudioUpstreamOptions {
  /** Override the base URL (used by tests). */
  baseUrl?: string;
}
/** The upstream client interface — exposes chat(). */
interface AStudioUpstreamClient {
  chat(token: string, body: unknown, signal?: AbortSignal): Promise<AStudioUpstreamResult>;
}
/**
 * Send a chat completion request to maas-api.
 *
 * Returns a structured result regardless of HTTP status. On 2xx, `ok` is
 * true and `kind` is 'ok'. On failure, `kind` classifies the error and
 * `message` carries a short summary extracted from the response body.
 */
declare function createAStudioUpstream(options?: AStudioUpstreamOptions): {
  chat: (token: string, body: unknown, signal?: AbortSignal) => Promise<AStudioUpstreamResult>;
};
//#endregion
//#region src/visibility-store.d.ts
/** Visibility store surface used by the catalog. */
interface AStudioVisibilityStore {
  hidden(identity: string): readonly string[];
  setVisible(identity: string, modelId: string, visible: boolean): Promise<void>;
}
//#endregion
//#region src/catalog.d.ts
/** Info for a single model. */
interface AStudioModelInfo {
  id: string;
  name: string;
  supportsImages?: boolean;
  reasoning?: {
    supports?: boolean;
    supportedEfforts?: string[];
    canDisableThinking?: boolean;
  };
  contextWindow: number;
  maxTokens: number;
}
/** The catalog interface. */
interface AStudioCatalog {
  /** Get the current model list. */
  current(): readonly AStudioModelInfo[];
  /** Force a refresh from the upstream. */
  refresh(): Promise<void>;
  /** Where the current models came from. */
  source(): 'live' | 'saved' | 'fallback';
  /** When the current models were fetched, for live and saved sources. */
  fetchedAtMs(): number | undefined;
  /** Model ids hidden by the current identity. */
  hiddenModelIds(): readonly string[];
}
/** Options for creating a catalog. */
interface AStudioCatalogOptions {
  upstream: AStudioUpstreamClient;
  token: () => string | undefined;
  /**
   * Resolve the model-manager credential. AStudio issues this separately from
   * the chat token (it lands in `astron-session.json` as `modelBearerToken`).
   */
  modelBearerToken?: () => string | undefined;
  /** Override the model-manager API base (used by tests). */
  modelManagerBaseUrl?: string;
  /** Override the identity used for catalog persistence. */
  identity?: string;
  /** Override the catalog snapshot path. */
  catalogPath?: string;
  /** Visibility store used to report hidden model ids. */
  visibility?: AStudioVisibilityStore;
}
/** Default built-in catalog — used when the upstream /v1/models is unavailable. */
declare const DEFAULT_CATALOG: readonly AStudioModelInfo[];
/**
 * Create a catalog backed by the upstream /v1/models endpoint.
 * Falls back to DEFAULT_CATALOG when the refresh fails.
 */
declare function createAStudioCatalog(options: AStudioCatalogOptions): AStudioCatalog;
//#endregion
//#region src/auth.d.ts
/**
 * AStudio credential store. Reads the chat bearer token from the AStudio
 * runtime config.toml and the model-manager token from astron-session.json,
 * caches both in memory, and never writes to disk.
 *
 * Both files live under one AStudio data root, discovered per platform rather
 * than assumed at a fixed absolute path; see ./locations.ts.
 *
 * @module dsh-astudio-connect/auth
 */
/** What the shim and upstream need from a credential. */
interface AStudioCredentialStore {
  /** Resolve the current chat bearer token, or undefined when unavailable. */
  resolve(): AStudioCredential;
  /** Resolve the model-manager token, or undefined when unavailable. */
  modelBearerToken?(): AStudioCredential;
}
/** Secret-free sign-in summary for status and doctor output. */
interface AStudioAuthStatus {
  state: 'signed-in' | 'signed-out';
  configPath: string;
  tokenLength?: number;
  /** Whether a model-manager token was also found. */
  hasModelToken?: boolean;
  hints: string[];
}
/** The credential type — a bearer token string or undefined. */
type AStudioCredential = string | undefined;
/** Options for constructing the store. */
interface AStudioAuthOptions {
  /** Override the config.toml path (used by tests and settings). */
  configPath?: string;
  /** Override the whole AStudio data root (used by tests). */
  dataHome?: string;
}
/**
 * Read the chat bearer token from a config.toml.
 *
 * Returns undefined when the file is missing, the field is absent, or the
 * format is unexpected. Never throws — a missing credential is a normal state
 * the plugin surfaces as "not connected" in the UI.
 */
declare function readTokenFromConfig(configPath: string): AStudioCredential;
/**
 * Create a credential store that reads both AStudio files and caches the
 * results in memory. Call `invalidate()` to force a re-read (e.g. after the
 * user signs in again).
 */
declare function createAStudioAuth(options?: AStudioAuthOptions): {
  resolve(): AStudioCredential;
  modelBearerToken(): AStudioCredential;
  invalidate(): void;
  status(): Promise<AStudioAuthStatus>;
  logout(): Promise<void>;
};
//#endregion
//#region src/shim.d.ts
/** Minimal logger surface. */
interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}
/** What the plugin needs from a running shim. */
interface AStudioShim {
  /** Resolves once the listener is up; rejects if listening failed. */
  ready: Promise<void>;
  /** The shim origin, e.g. `http://127.0.0.1:39271`; valid after ready. */
  baseUrl(): string;
  /** The per-process shared secret the plugin's own client must carry. */
  token(): string;
  /** Stop serving and destroy open connections. */
  close(): Promise<void>;
}
/** Constructor dependencies. */
interface AStudioShimOptions {
  store: AStudioCredentialStore;
  upstream: AStudioUpstreamClient;
  catalog: AStudioCatalog;
  logger?: ShimLogger;
}
/**
 * Start the loopback endpoint. Requests carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 */
declare function createAStudioShim(options: AStudioShimOptions): AStudioShim;
//#endregion
//#region src/adapter.d.ts
/** Provider route this bundle owns. */
declare const ASTRO_PROVIDER = "astudio";
/** Provider idle ceiling while one stream read is outstanding. */
declare const ASTRO_STREAM_IDLE_TIMEOUT_MS = 300000;
/** Constructor dependencies. */
interface AStudioAdapterOptions {
  providerId?: string;
  displayName?: string;
  shim: AStudioShim;
  catalog: AStudioCatalog;
}
/** What {@link createAStudioAdapter} hands back. */
interface AStudioAdapter {
  adapter: PiAiAdapter;
  invalidate: () => void;
}
/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's
 * ephemeral port applies from the first snapshot after startup.
 */
declare function createAStudioAdapter(options: AStudioAdapterOptions): AStudioAdapter;
//#endregion
//#region src/index.d.ts
/**
 * Host services this plugin reads.
 *
 * `webServer` is required even though the status/update/probe routes are
 * secondary to model routing: the plugin's startup chain runs inside
 * `shim.ready.then()`, and every `ctx.<service>` read there is resolved against
 * the mounting fiber's inject list. A route registration that throws takes the
 * whole chain down with it — so a service this plugin merely *optionally* wants
 * is declared here as a hard requirement, and `apply()` guards its absence with
 * `ctx.get()` instead of letting an un-injected read throw.
 */
declare const inject: string[];
/**
 * Settings namespace owning the AStudio card's section.
 *
 * A nominal string cast to the seam type. The namespace is what
 * `settings.yaml` and the TUI `/settings` read, and on DSH 0.1.5 the
 * settings Plugins tab dispatches a card by rendering `settings.plugin.item`
 * with `entryKey = ns` for each namespace the host serves.
 */
declare const ASTRO_SETTINGS_NS: SettingsNamespace;
/** Plugin configuration schema. */
interface Config {
  /** Display name shown in the provider picker. */
  displayName?: string;
  /** Explicit config path, overriding the AStudio default location. */
  configPath?: string;
}
declare const Config: z<Config>;
/**
 * Register the AStudio provider into the Harness LLM seam.
 *
 * Creates the credential store, upstream client, catalog, loopback shim, and
 * pi-ai adapter. The shim starts listening on 127.0.0.1 and the adapter
 * registers the `astudio` provider route. All resources are cleaned up when
 * the host calls `ctx.dispose()`.
 */
declare function apply(ctx: Context, config: Config): void;
/**
 * The plugin object the DSH loader mounts.
 *
 * This MUST be an object rather than the bare `apply` function. The loader
 * normalizes every plugin module with
 *
 *     exports = exports.default ?? exports
 *
 * so `export default apply` made the loader adopt that function directly — and
 * a function carries none of the module's other exports. `inject` was dropped,
 * the plugin mounted on an unscoped `Include` fiber, and each `ctx.llm` /
 * `ctx.webServer` read inside it threw `cannot get property "…" without
 * inject`. Because that throw is wrapped by the `.catch()` around
 * `shim.ready.then()`, and cordis JSON-stringifies a trailing Error argument
 * (`JSON.stringify(new Error(…))` is `{}`), the only trace was a log line
 * reading `shim failed to start {}` while the `astudio` provider silently
 * failed to register — which is why the model picker listed no AStudio models
 * even though the settings card rendered fine.
 *
 * Keeping `apply` (and `inject`) reachable as named exports is harmless: the
 * loader only ever reads the default when one exists.
 */
declare const plugin: {
  name: string;
  inject: string[];
  apply: typeof apply;
};
//#endregion
export { ASTRO_PROVIDER, ASTRO_SETTINGS_NS, ASTRO_STREAM_IDLE_TIMEOUT_MS, type AStudioShim, Config, DEFAULT_CATALOG, DEFAULT_UPSTREAM_URL, apply, createAStudioAdapter, createAStudioAuth, createAStudioCatalog, createAStudioShim, createAStudioUpstream, plugin as default, inject, readTokenFromConfig };