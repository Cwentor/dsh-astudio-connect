import { a as readTokenFromConfig, i as createAStudioAuth, n as createAStudioCatalog, t as DEFAULT_CATALOG } from "./catalog-C4lvmq56.js";
import z from "@deepseek-ai/schemastery";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
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
//#region src/loopback.ts
/** Loopback hostnames a local plugin surface may be addressed by. */
const LOOPBACK_HOSTS = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"localhost",
	"[::1]"
]);
/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
function hostnameOfHost(host) {
	let hostname = host.trim().toLowerCase();
	if (hostname.startsWith("[")) {
		const end = hostname.indexOf("]");
		return end === -1 ? hostname : hostname.slice(0, end + 1);
	}
	const colon = hostname.lastIndexOf(":");
	if (colon !== -1 && !hostname.slice(0, colon).includes(":") && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
	return hostname;
}
/**
* The request's Host header must name the loopback interface. A DNS-rebinding
* page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
* Host, so this check drops those before any routing happens.
*/
function hostIsLoopback(host) {
	if (host === void 0 || host.trim() === "") return false;
	return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
/**
* A browser-sent Origin (present header) must be loopback. Non-browser
* clients (the plugin's own fetch calls) send no Origin at all and pass.
*/
function originIsLoopback(origin) {
	if (origin === void 0 || origin.trim() === "") return true;
	try {
		const { hostname } = new URL(origin);
		return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
	} catch {
		return false;
	}
}
/**
* Ports fetch refuses to connect to, per the fetch standard's port blocking
* table (https://fetch.spec.whatwg.org/#port-blocking). Kept in sync with the
* `badPorts` table undici ships: only the entries a host's ephemeral range can
* actually reach matter, but carrying the whole list costs nothing and keeps
* the check honest on machines with a customised range.
*/
const FETCH_BLOCKED_PORTS = /* @__PURE__ */ new Set([
	1,
	7,
	9,
	11,
	13,
	15,
	17,
	19,
	20,
	21,
	22,
	23,
	25,
	37,
	42,
	43,
	53,
	69,
	77,
	79,
	87,
	95,
	101,
	102,
	103,
	104,
	109,
	110,
	111,
	113,
	115,
	117,
	119,
	123,
	135,
	137,
	139,
	143,
	161,
	179,
	389,
	427,
	465,
	512,
	513,
	514,
	515,
	526,
	530,
	531,
	532,
	540,
	548,
	554,
	556,
	563,
	587,
	601,
	636,
	989,
	990,
	993,
	995,
	1719,
	1720,
	1723,
	2049,
	3659,
	4045,
	4190,
	5060,
	5061,
	6e3,
	6566,
	6665,
	6666,
	6667,
	6668,
	6669,
	6679,
	6697,
	10080
]);
/** Whether fetch (and therefore pi-ai) refuses to connect to `port`. */
function isFetchBlockedPort(port) {
	return FETCH_BLOCKED_PORTS.has(port);
}
/** Bind attempts allowed before giving up, including the first. */
const DEFAULT_MAX_ATTEMPTS = 16;
/**
* Bind `server` to an ephemeral port fetch will actually connect to, and
* resolve with the address it ended up on.
*
* `listen(0)` lets the OS hand out any free ephemeral port, and a handful of
* the ports it can hand out are on the fetch standard's bad-port list: fetch
* refuses to connect to them and fails with `TypeError: fetch failed` before a
* socket is opened. The shim is only ever reached through fetch (pi-ai calls
* it), so settling on one of those ports leaves the plugin with an endpoint
* that answers raw HTTP and rejects every real request. The port is not
* negotiable at request time, so the only fix is to bind again.
*
* A blocked port is closed and rebound; a listen error is fatal, as it was
* before, because nothing about picking another port would fix it.
*/
async function bindToUsablePort(server, options) {
	const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
	const isPortBlocked = options.isPortBlocked ?? isFetchBlockedPort;
	let lastBlockedPort = 0;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		const address = await listenOnEphemeralPort(server, options.host);
		if (!isPortBlocked(address.port)) return address;
		lastBlockedPort = address.port;
		options.onBlockedPort?.(address.port, attempt);
		await closeQuietly(server);
	}
	throw new Error(`could not bind a fetch-reachable loopback port after ${maxAttempts} attempts (last blocked port: ${lastBlockedPort})`);
}
/** One `listen(0)` on `host`, resolving with the address the OS handed out. */
function listenOnEphemeralPort(server, host) {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			server.off("listening", onListening);
			server.off("error", onError);
		};
		const onListening = () => {
			cleanup();
			const address = server.address();
			if (address === null || typeof address === "string") {
				reject(/* @__PURE__ */ new Error("astudio shim has no listening address"));
				return;
			}
			resolve(address);
		};
		const onError = (error) => {
			cleanup();
			reject(error);
		};
		server.once("listening", onListening);
		server.once("error", onError);
		server.listen(0, host);
	});
}
/** Close between attempts; a listener that already closed is not an error here. */
function closeQuietly(server) {
	return new Promise((resolve) => {
		server.closeAllConnections();
		server.close(() => resolve());
	});
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
	const ready = bindToUsablePort(server, {
		host: "127.0.0.1",
		onBlockedPort: (port, attempt) => {
			logger?.warn(`dsh-astudio-connect: port ${port} is blocked for fetch; rebinding (attempt ${attempt})`);
		}
	}).then(() => void 0);
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
				const hidden = catalog.hiddenModelIds();
				writeJson(res, 200, {
					object: "list",
					data: catalog.current().filter((m) => !hidden.includes(m.id)).map((m) => ({
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
	const reasoning = info.reasoning;
	if (reasoning === void 0 || reasoning.supports !== true) return { reasoning: false };
	const efforts = reasoning.supportedEfforts;
	if (efforts === void 0 || efforts.length === 0) return { reasoning: false };
	return {
		reasoning: true,
		thinkingLevelMap: {
			off: efforts.includes("off") && reasoning.canDisableThinking === true ? "off" : null,
			minimal: null,
			low: efforts.includes("low") ? "low" : null,
			medium: efforts.includes("medium") ? "medium" : null,
			high: efforts.includes("high") ? "high" : null,
			xhigh: efforts.includes("xhigh") ? "xhigh" : null,
			max: efforts.includes("max") ? "max" : null
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
		input: info.supportsImages === true ? ["text", "image"] : ["text"],
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
		const models = await super.listModels(provider);
		const hidden = new Set(this.catalog.hiddenModelIds());
		return models.filter((model) => !hidden.has(model.id)).map((model) => {
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
/** Assemble the probe summary for one identity from the live catalog. */
function buildProbe(catalog, probe, identity) {
	const results = [];
	for (const model of catalog.current()) {
		const record = probe.get(identity, model.id);
		if (record === void 0) continue;
		results.push({
			modelId: record.modelId,
			validation: record.validation,
			efforts: [...record.efforts],
			expiresAtMs: record.expiresAtMs
		});
	}
	return {
		account: identity,
		results
	};
}
/**
* Mount the GET status route on the host web server.
*
* The route serves a JSON document with connection state, catalog provenance,
* hidden models, and probe observations. It checks the loopback Host header
* before answering.
*/
function registerAStudioStatusRoute(ctx, options) {
	const { store, catalog } = options;
	const identity = options.identity ?? "astudio-local";
	ctx.webServer.register({
		kind: "exact",
		path: ASTRO_STATUS_PATH,
		handler: async (req, res) => {
			const hostName = (req.headers.host ?? "").split(":")[0]?.toLowerCase() ?? "";
			if (hostName !== "127.0.0.1" && hostName !== "localhost") {
				res.writeHead(403, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "forbidden" }));
				return;
			}
			const authStatus = await store.status();
			const models = catalog.current();
			const probe = options.probe === void 0 ? {
				account: identity,
				results: []
			} : buildProbe(catalog, options.probe, identity);
			const body = {
				auth: {
					state: authStatus.state,
					...authStatus.tokenLength !== void 0 ? { tokenLength: authStatus.tokenLength } : {}
				},
				catalog: {
					source: catalog.source(),
					modelCount: models.length,
					models: models.map((m) => ({
						id: m.id,
						name: m.name
					}))
				},
				visibility: { hidden: [...catalog.hiddenModelIds()] },
				probe
			};
			res.writeHead(200, { "Content-Type": "application/json" });
			res.end(JSON.stringify(body));
		}
	});
}
//#endregion
//#region src/visibility-store.ts
/**
* AStudio model visibility persistence. Hidden-model preferences are kept
* per identity under the DSH home. Hiding is selectability-only: it filters
* picker/model-list reads, but never makes an already-running session's model
* unresolvable.
*
* @module dsh-astudio-connect/visibility-store
*/
/** Filename for the visibility file inside the DSH home. */
const ASTRO_VISIBILITY_FILENAME = ".astudio-connect/model-visibility.json";
/** File path for the visibility file. */
function astudioVisibilityPath() {
	return join(resolveDshHome(), ASTRO_VISIBILITY_FILENAME);
}
/** Read one identity's hidden model ids. */
function readHiddenModels(path, identity) {
	if (!existsSync(path)) return [];
	try {
		const file = JSON.parse(readFileSync(path, "utf8"));
		if (file.version !== 1) return [];
		return file.visibility[identity]?.hidden ?? [];
	} catch {
		return [];
	}
}
/** Set one model visible/hidden for one identity. */
async function setModelVisible(path, identity, modelId, visible) {
	await mkdir(dirname(path), { recursive: true });
	const file = existsSync(path) ? readFileSync(path, "utf8") : "{}";
	const parsed = JSON.parse(file);
	const existing = new Set(parsed.visibility?.[identity]?.hidden ?? []);
	if (visible) existing.delete(modelId);
	else existing.add(modelId);
	const next = {
		version: 1,
		visibility: {
			...parsed.visibility,
			[identity]: { hidden: [...existing] }
		}
	};
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}
/** Create a store bound to one path. */
function createAStudioVisibilityStore(path = astudioVisibilityPath()) {
	return {
		hidden: (identity) => readHiddenModels(path, identity),
		setVisible: (identity, modelId, visible) => setModelVisible(path, identity, modelId, visible)
	};
}
//#endregion
//#region src/version.ts
/** Current package version. */
const ASTRO_VERSION = "0.1.0";
//#endregion
//#region src/host-heartbeat.ts
/** Basename of the host heartbeat file inside the Harness home. */
const ASTRO_HOST_HEARTBEAT_FILENAME = ".astudio-host-heartbeat.json";
/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1;
/** Absolute path of the host heartbeat file. */
function astudioHostHeartbeatPath() {
	return join(resolveDshHome(), ASTRO_HOST_HEARTBEAT_FILENAME);
}
/**
* Write (or overwrite) the heartbeat after the host bundle registered the
* provider. A failed write is non-fatal: the host is already running, and the
* status CLI will simply report "heartbeat missing" rather than failing.
*/
async function writeHostHeartbeat() {
	const document = {
		version: HEARTBEAT_FORMAT_VERSION,
		package: "dsh-astudio-connect",
		pluginVersion: ASTRO_VERSION,
		registeredAt: Date.now(),
		pid: process.pid
	};
	try {
		await writeFile(astudioHostHeartbeatPath(), JSON.stringify(document), "utf8");
	} catch {}
}
/** Remove the heartbeat on plugin disposal so a stale file does not linger. */
async function clearHostHeartbeat() {
	try {
		await rm(astudioHostHeartbeatPath(), { force: true });
	} catch {}
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
	const visibility = createAStudioVisibilityStore();
	const catalog = createAStudioCatalog({
		upstream,
		token: () => store.resolve(),
		visibility
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
				clearHostHeartbeat();
			});
		} catch {
			releaseAdapter();
			shim.close();
			clearHostHeartbeat();
		}
		registerAStudioStatusRoute(ctx, {
			store,
			catalog
		});
		writeHostHeartbeat();
		ctx.logger.info("dsh-astudio-connect: shim listening at", shim.baseUrl());
		catalog.refresh().catch(() => {});
	}).catch((error) => {
		ctx.logger.error("dsh-astudio-connect: shim failed to start", error);
	});
}
//#endregion
export { ASTRO_PROVIDER, ASTRO_SETTINGS_NS, ASTRO_STREAM_IDLE_TIMEOUT_MS, Config, DEFAULT_CATALOG, DEFAULT_UPSTREAM_URL, apply, apply as default, createAStudioAdapter, createAStudioAuth, createAStudioCatalog, createAStudioShim, createAStudioUpstream, inject, readTokenFromConfig };
