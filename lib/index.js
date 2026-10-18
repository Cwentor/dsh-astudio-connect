import z from "@deepseek-ai/schemastery";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
/** Regex for the bearer-token field in config.toml. */
const TOKEN_PATTERN = /experimental_bearer_token\s*=\s*"([^"]+)"/;
/**
* Read the bearer token from config.toml.
*
* Returns undefined when the file is missing, the field is absent, or the
* format is unexpected. Never throws — a missing credential is a normal state
* the plugin surfaces as "not connected" in the UI.
*/
function readTokenFromConfig(configPath) {
	if (!existsSync(configPath)) return void 0;
	let content;
	try {
		content = readFileSync(configPath, "utf8");
	} catch {
		return;
	}
	return TOKEN_PATTERN.exec(content)?.[1] ?? void 0;
}
/**
* Create a credential store that reads from config.toml and caches the result
* in memory. The cache is populated once on the first `resolve()` call;
* subsequent calls return the same value. Call `invalidate()` to force a re-read
* (e.g. after the user re-logs in).
*/
function createAStudioAuth(options = {}) {
	const configPath = options.configPath ?? "D:\\IDE\\AStudio Data\\runtime\\acode-home\\config.toml";
	let cached = null;
	return {
		resolve() {
			if (cached !== null) return cached;
			cached = readTokenFromConfig(configPath);
			return cached;
		},
		invalidate() {
			cached = null;
		}
	};
}
//#endregion
//#region src/upstream.ts
/** Default maas-api endpoint. */
const DEFAULT_UPSTREAM_URL = "https://maas-api.cn-huabei-1.xf-yun.com/v1";
/** Classify an HTTP status into an error kind. */
function classifyStatus(status) {
	if (status === 401 || status === 403) return "auth";
	if (status === 404) return "not_found";
	if (status === 429) return "rate";
	if (status >= 500) return "server";
	return "client";
}
/**
* Send a chat completion request to maas-api.
*
* Returns a structured result regardless of HTTP status. On 2xx, `ok` is
* true and `kind` is 'ok'. On failure, `kind` classifies the error and
* `message` carries a short summary extracted from the response body.
*/
function createAStudioUpstream(options = {}) {
	const baseUrl = options.baseUrl ?? "https://maas-api.cn-huabei-1.xf-yun.com/v1";
	/** Send a chat completion request. Returns the full result including the raw Response. */
	async function chat(token, body, signal) {
		const url = `${baseUrl}/chat/completions`;
		let res;
		try {
			res = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json"
				},
				body: JSON.stringify(body),
				...signal !== void 0 ? { signal } : {}
			});
		} catch (err) {
			return {
				ok: false,
				status: 0,
				kind: "server",
				message: err instanceof Error ? err.message : String(err),
				response: null
			};
		}
		if (res.ok) return {
			ok: true,
			status: res.status,
			kind: "ok",
			message: "",
			response: res
		};
		const kind = classifyStatus(res.status);
		const message = (await res.text().catch(() => "")).slice(0, 400);
		return {
			ok: false,
			status: res.status,
			kind,
			message,
			response: res
		};
	}
	return { chat };
}
//#endregion
//#region src/catalog.ts
/** Default built-in catalog — used when the upstream /v1/models is unavailable. */
const DEFAULT_CATALOG = [
	{
		id: "spark-x2.5",
		name: "Spark X2.5",
		reasoning: true,
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "spark-x2.5-4b",
		name: "Spark X2.5 4B",
		reasoning: false,
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "spark-x2.6-preview",
		name: "Spark X2.6 Preview",
		reasoning: true,
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "xopglm52",
		name: "GLM-5.2",
		reasoning: false,
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "xopdeepseekv4pro",
		name: "DeepSeek V4 Pro",
		reasoning: false,
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "xopdeepseekv4pro0813",
		name: "DeepSeek V4 Pro 0813",
		reasoning: false,
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "xopdsv4flash0731in",
		name: "DeepSeek V4 Flash",
		reasoning: false,
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "astronclaw-auto",
		name: "AstronClaw Auto",
		reasoning: false,
		contextWindow: 131072,
		maxTokens: 8192
	}
];
/**
* Create a catalog backed by the upstream /v1/models endpoint.
* Falls back to DEFAULT_CATALOG when the refresh fails.
*/
function createAStudioCatalog(options) {
	let cached = DEFAULT_CATALOG;
	const baseUrl = options.baseUrl ?? "https://maas-api.cn-huabei-1.xf-yun.com/v1";
	async function refresh() {
		const token = options.token();
		if (token === void 0) return;
		try {
			const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${token}` } });
			if (!res.ok) return;
			const data = await res.json();
			if (!data.data || data.data.length === 0) return;
			const knownIds = new Set(DEFAULT_CATALOG.map((m) => m.id));
			const upstreamIds = new Set(data.data.map((d) => d.id));
			cached = DEFAULT_CATALOG.filter((m) => upstreamIds.has(m.id));
			for (const up of data.data) if (!knownIds.has(up.id)) cached = [...cached, {
				id: up.id,
				name: up.id,
				reasoning: false,
				contextWindow: 131072,
				maxTokens: 8192
			}];
		} catch {}
	}
	return {
		current: () => cached,
		refresh
	};
}
//#endregion
//#region src/shim.ts
/**
* AStudio loopback shim. Serves an OpenAI-compatible endpoint on 127.0.0.1
* that the pi-ai provider points to. The shim validates four inbound guards
* (loopback Host, loopback Origin, JSON Content-Type, shared-secret Bearer),
* then forwards the request to maas-api via the upstream client.
*
* @module dsh-astudio-connect/shim
*/
const REQUEST_BODY_LIMIT = 67108864;
/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
	auth: 401,
	not_found: 502,
	rate: 429,
	server: 502,
	client: 400
};
/** Check the Host header names a loopback interface. */
function hostIsLoopback(host) {
	if (!host) return false;
	const h = host.split(":")[0]?.toLowerCase() ?? "";
	return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
}
/** Check the Origin header is loopback (or absent for non-browser clients). */
function originIsLoopback(origin) {
	if (!origin) return true;
	const o = origin.split(":")[0]?.toLowerCase() ?? "";
	return o === "http" || o === "https" ? origin.includes("127.0.0.1") || origin.includes("localhost") || origin.includes("[::1]") : false;
}
/** Check the Content-Type is application/json. */
function isJsonContentType(req) {
	const type = req.headers["content-type"];
	return typeof type === "string" && type.trim().toLowerCase().startsWith("application/json");
}
/** Read a request body with a size cap. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > REQUEST_BODY_LIMIT) {
				reject(/* @__PURE__ */ new Error("request body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks)));
		req.on("error", reject);
	});
}
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
	writeJson(res, status, { error: {
		message,
		type: kind,
		code: kind
	} });
}
/**
* Start the loopback endpoint. Requests carry any bearer; the loopback bind
* is the boundary, and the upstream credential comes from the store alone.
*/
function createAStudioShim(options) {
	const { store, upstream, catalog } = options;
	const logger = options.logger;
	const SHARED_SECRET = randomBytes(32).toString("base64url");
	/** Constant-time bearer check. */
	function bearerOk(req) {
		const header = req.headers.authorization;
		if (typeof header !== "string") return false;
		const match = /^Bearer\s+(.+)$/i.exec(header.trim());
		if (match === null) return false;
		const presented = match[1];
		const a = Buffer.from(presented);
		const b = Buffer.from(SHARED_SECRET);
		if (a.length !== b.length) return false;
		return timingSafeEqual(a, b);
	}
	const server = createServer((req, res) => {
		handle(req, res);
	});
	const ready = new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});
	const baseUrl = () => {
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("astudio shim has no listening address");
		return `http://127.0.0.1:${address.port}`;
	};
	async function handle(req, res) {
		try {
			if (!hostIsLoopback(req.headers.host)) {
				writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
				return;
			}
			if (!originIsLoopback(req.headers.origin)) {
				writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
				return;
			}
			if (!bearerOk(req)) {
				writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
				return;
			}
			const url = req.url ?? "/";
			if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
				writeJson(res, 200, { ok: true });
				return;
			}
			if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().map((m) => ({
						id: m.id,
						object: "model",
						created: 0,
						owned_by: "astudio"
					}))
				});
				return;
			}
			if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
				await chatCompletions(req, res);
				return;
			}
			writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
		} catch (error) {
			if (!res.headersSent) writeOpenAIError(res, 500, "internal", String(error));
			else res.end();
		}
	}
	async function chatCompletions(req, res) {
		if (!isJsonContentType(req)) {
			writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
			return;
		}
		let credential;
		try {
			credential = store.resolve();
		} catch (error) {
			writeOpenAIError(res, 401, "not_signed_in", String(error));
			return;
		}
		if (credential === void 0) {
			writeOpenAIError(res, 401, "not_signed_in", "AStudio token not available");
			return;
		}
		const raw = (await readBody(req)).toString("utf8");
		const body = JSON.parse(raw);
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await upstream.chat(credential, body, controller.signal);
		if (!result.ok) {
			const detail = result.message.slice(0, 400);
			const kind = result.kind;
			writeOpenAIError(res, KIND_STATUS[kind], kind, `astudio upstream ${kind}: ${detail}`);
			return;
		}
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			"Connection": "keep-alive",
			"X-Accel-Buffering": "no"
		});
		let sawDone = false;
		const bodyStream = Readable.fromWeb(result.response.body);
		bodyStream.on("data", (chunk) => {
			if (chunk.includes("[DONE]")) sawDone = true;
		});
		bodyStream.on("error", (error) => {
			logger?.warn("dsh-astudio-connect: upstream stream failed mid-flight", error);
			if (!sawDone && res.writable) res.end("data: [DONE]\n\n");
		});
		bodyStream.pipe(res);
	}
	return {
		ready,
		baseUrl,
		token: () => SHARED_SECRET,
		close: () => new Promise((resolve, reject) => {
			server.close(() => resolve());
			server.closeAllConnections();
			server.once("error", reject);
		})
	};
}
//#endregion
//#region src/adapter.ts
/**
* AStudio pi-ai adapter. Assembles a PiAiAdapter that registers the
* `astudio` provider into the DSH LLM seam, pointing at the loopback shim.
*
* @module dsh-astudio-connect/adapter
*/
/** Provider route this bundle owns. */
const ASTRO_PROVIDER = "astudio";
/** Provider idle ceiling while one stream read is outstanding. */
const ASTRO_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
	maxRequestImageBytes: 20971520,
	requestImagePixelBudget: 4194304,
	requestImageMaxBytes: 1048576
};
/** No per-token pricing is knowable; report zero. */
const NO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
/** Inert pi-ai auth plane — the shim shared secret is the only credential. */
const INERT_AUTH = {
	credentials: {
		async read() {},
		async list() {
			return [];
		},
		async modify() {
			throw new Error("dsh-astudio-connect: the astudio route has no pi-ai credential lifecycle");
		},
		async delete() {}
	},
	authContext: {
		async env() {},
		async fileExists() {
			return false;
		}
	}
};
/**
* Build the thinking-level map for a reasoning model.
* maas-api reasoning models support low/high/max.
*/
function reasoningFields(info) {
	if (!info.reasoning) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: "max"
		}
	};
}
/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, providerId) {
	return {
		id: info.id,
		name: info.name,
		api: "openai-completions",
		provider: providerId,
		baseUrl,
		input: ["text"],
		...reasoningFields(info),
		cost: NO_COST,
		contextWindow: info.contextWindow,
		maxTokens: info.maxTokens,
		compat: { maxTokensField: "max_tokens" }
	};
}
/**
* Assemble the adapter. The provider's `getModels` reads the live catalog,
* and every model's `baseUrl` is re-resolved per read so the shim's
* ephemeral port applies from the first snapshot after startup.
*/
function createAStudioAdapter(options) {
	const { shim, catalog } = options;
	const providerId = options.providerId ?? "astudio";
	const displayName = options.displayName ?? "AStudio";
	const buildModels = () => {
		const baseUrl = `${shim.baseUrl()}/v1`;
		return catalog.current().map((info) => toPiModel(info, baseUrl, providerId));
	};
	const provider = {
		...createProvider({
			id: providerId,
			name: displayName,
			auth: { apiKey: {
				name: "AStudio bearer token",
				async resolve({ credential }) {
					const apiKey = credential?.key;
					return apiKey === void 0 || apiKey.length === 0 ? void 0 : {
						auth: { apiKey },
						source: "AStudio"
					};
				}
			} },
			models: buildModels(),
			api: openAICompletionsApi()
		}),
		getModels: () => buildModels()
	};
	const profile = {
		provider: providerId,
		displayName,
		streamIdleTimeoutMs: ASTRO_STREAM_IDLE_TIMEOUT_MS,
		retryPolicy: resolveRetryPolicy(void 0, "dsh-astudio-connect retryPolicy"),
		configuredMaxTokens: /* @__PURE__ */ new Map(),
		modelErrors: /* @__PURE__ */ new Map(),
		...REQUEST_IMAGE_BUDGETS,
		piProvider: provider
	};
	let profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
	return {
		adapter: new AStudioPiAiAdapter(catalog, {
			profiles: () => profiles,
			auth: INERT_AUTH,
			resolveApiKey: async () => shim.token()
		}),
		invalidate: () => {
			profiles = /* @__PURE__ */ new Map([[providerId, profile]]);
		}
	};
}
/** Override listModels to apply display-name formatting from the live catalog. */
var AStudioPiAiAdapter = class extends PiAiAdapter {
	catalog;
	constructor(catalog, options) {
		super(options);
		this.catalog = catalog;
	}
	infoFor(model) {
		return this.catalog.current().find((entry) => entry.id === model);
	}
	async listModels(provider) {
		return (await super.listModels(provider)).map((model) => {
			const info = this.infoFor(model.id);
			return info === void 0 ? model : {
				...model,
				name: info.name
			};
		});
	}
	async resolveModel(provider, model, signal) {
		const resolved = await super.resolveModel(provider, model, signal);
		const info = this.infoFor(model);
		return info === void 0 ? resolved : {
			...resolved,
			name: info.name
		};
	}
};
//#endregion
//#region src/web-status.ts
/** Status route path. */
const ASTRO_STATUS_PATH = "/astudio/status";
/**
* Mount the GET status route on the host web server.
*
* The route serves a JSON document with connection state and model list.
* It checks the loopback Host header before answering.
*/
function registerAStudioStatusRoute(ctx, options) {
	const { store, catalog } = options;
	ctx.webServer.register({
		kind: "exact",
		path: ASTRO_STATUS_PATH,
		handler: (req, res) => {
			const hostName = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
			if (hostName !== "127.0.0.1" && hostName !== "localhost") {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "forbidden" }));
				return;
			}
			const connected = store.resolve() !== void 0;
			const models = catalog.current();
			const body = {
				connected,
				modelCount: models.length,
				models: models.map((m) => ({
					id: m.id,
					name: m.name
				}))
			};
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		}
	});
}
//#endregion
//#region src/index.ts
/** The model registry required before the provider can register. */
const inject = ["llm"];
/**
* Settings namespace owning the AStudio card's section.
*
* A nominal string cast to the seam type. The namespace is what
* `settings.yaml` and the TUI `/settings` read, and on DSH 0.1.5 the
* settings Plugins tab dispatches a card by rendering `settings.plugin.item`
* with `entryKey = ns` for each namespace the host serves.
*/
const ASTRO_SETTINGS_NS = "astudio";
const Config = z.object({
	displayName: z.string().description("Display name for the AStudio provider in the model picker"),
	configPath: z.string().description("Explicit AStudio config.toml path (defaults to the app's own location)")
});
/**
* Register the AStudio provider into the Harness LLM seam.
*
* Creates the credential store, upstream client, catalog, loopback shim, and
* pi-ai adapter. The shim starts listening on 127.0.0.1 and the adapter
* registers the `astudio` provider route. All resources are cleaned up when
* the host calls `ctx.dispose()`.
*/
function apply(ctx, config) {
	const store = createAStudioAuth(config.configPath !== void 0 ? { configPath: config.configPath } : {});
	const upstream = createAStudioUpstream();
	const catalog = createAStudioCatalog({
		upstream,
		token: () => store.resolve()
	});
	const shim = createAStudioShim({
		store,
		upstream,
		catalog,
		logger: {
			warn: (...args) => ctx.logger.warn("dsh-astudio-connect", ...args),
			error: (...args) => ctx.logger.error("dsh-astudio-connect", ...args)
		}
	});
	ctx.inject(["settings"], (settingsCtx) => {
		ctx.effect(() => {
			const disposer = settingsCtx.settings.configure({ auto: true });
			return () => disposer();
		});
	});
	shim.ready.then(() => {
		const { adapter } = createAStudioAdapter({
			shim,
			catalog,
			...config.displayName !== void 0 ? { displayName: config.displayName } : {}
		});
		const releaseAdapter = ctx.llm.registerAdapter([ASTRO_PROVIDER], adapter);
		try {
			ctx.effect(() => () => {
				releaseAdapter();
				shim.close();
			});
		} catch {
			releaseAdapter();
			shim.close();
		}
		registerAStudioStatusRoute(ctx, {
			store,
			catalog
		});
		ctx.logger.info("dsh-astudio-connect: shim listening at", shim.baseUrl());
		catalog.refresh().catch(() => {});
	}).catch((error) => {
		ctx.logger.error("dsh-astudio-connect: shim failed to start", error);
	});
}
//#endregion
export { ASTRO_PROVIDER, ASTRO_SETTINGS_NS, ASTRO_STREAM_IDLE_TIMEOUT_MS, Config, DEFAULT_CATALOG, DEFAULT_UPSTREAM_URL, apply, apply as default, createAStudioAdapter, createAStudioAuth, createAStudioCatalog, createAStudioShim, createAStudioUpstream, inject, readTokenFromConfig };
