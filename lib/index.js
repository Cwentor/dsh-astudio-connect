import { a as createAStudioAuth, i as localIdentity, n as createAStudioCatalog, o as readTokenFromConfig, t as DEFAULT_CATALOG } from "./catalog-DcqKkLz1.js";
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
import { fileURLToPath } from "node:url";
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
function hostIsLoopback$1(host) {
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
function readBody$1(req) {
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
			if (!hostIsLoopback$1(req.headers.host)) {
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
		const raw = (await readBody$1(req)).toString("utf8");
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
//#region src/status-paths.ts
/**
* Shared constants and web-facing types for AStudio Connect's local HTTP
* surfaces. Node-free: imported by both the host bundle and the browser
* client, so it must stay dependency-free.
*
* @module dsh-astudio-connect/status-paths
*/
/** Status endpoint consumed by the browser half. */
const ASTRO_STATUS_PATH = "/astudio/status";
/**
* Probe control endpoint.
*
* Separate from the status route because it accepts writes: the status route's
* loopback Host/Origin guard protects against a DNS-rebinding *page*, which is
* not the same as authorizing a state-changing action. This route therefore
* also requires the in-process key the browser half receives with the status
* document.
*/
const ASTRO_PROBE_PATH = "/astudio/probe";
/**
* Same-origin route backing the browser's update reminder.
*
* Read-only like the status route, so the same loopback Host/Origin gate
* applies; it answers public npm/GitHub metadata only and never token
* material.
*/
const ASTRO_UPDATE_PATH = "/astudio/update";
//#endregion
//#region src/web-status.ts
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
/**
* Package identity reported by the update route.
*
* Keeping the version here keeps the route's public document self-contained
* while the single source of truth remains the package.json `version` field.
*
* @module dsh-astudio-connect/version
*/
/** Package name reported by the update route. */
const ASTRO_PACKAGE_NAME = "dsh-astudio-connect";
/** Current package version. */
const ASTRO_VERSION = "0.1.0";
/** Repository URL reported by the update route. */
const ASTRO_REPOSITORY_URL = "https://github.com/astudio-connect/dsh-astudio-connect";
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
const ASTRO_UPDATE_NPM_METADATA_URL = `https://registry.npmjs.org/-/package/${ASTRO_PACKAGE_NAME}/dist-tags`;
const ASTRO_UPDATE_RELEASES_API_URL = `${ASTRO_REPOSITORY_URL.replace("https://github.com", "https://api.github.com/repos")}/releases?per_page=100`;
const ASTRO_RELEASE_PAGE_BASE = `${ASTRO_REPOSITORY_URL}/releases/tag/`;
const ASTRO_UPDATE_MAX_METADATA_BYTES = 65536;
const ASTRO_UPDATE_MAX_RELEASES_BYTES = 1048576;
/** GitHub caps one page at 100 releases; ours is far below that today. */
const RELEASES_LIST_MAX = 100;
const RELEASE_NAME_MAX_CHARS = 200;
const RELEASE_NOTES_MAX_CHARS = 16e3;
/** Parse one exact SemVer version, accepting the conventional leading `v`. */
function parseAStudioVersion(raw) {
	if (typeof raw !== "string") return void 0;
	const normalized = raw.startsWith("v") ? raw.slice(1) : raw;
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(normalized);
	if (match === null) return void 0;
	const rawPrerelease = match[4] === void 0 ? [] : match[4].split(".");
	if (rawPrerelease.some((identifier) => /^\d+$/u.test(identifier) && !/^(0|[1-9]\d*)$/u.test(identifier))) return void 0;
	const prerelease = rawPrerelease.map((identifier) => /^(0|[1-9]\d*)$/u.test(identifier) ? Number(identifier) : identifier);
	if (prerelease.some((identifier) => typeof identifier === "number" && !Number.isSafeInteger(identifier))) return void 0;
	const parsed = {
		major: Number(match[1]),
		minor: Number(match[2]),
		patch: Number(match[3]),
		prerelease
	};
	return [
		parsed.major,
		parsed.minor,
		parsed.patch
	].every(Number.isSafeInteger) ? parsed : void 0;
}
/**
* One canonical spelling per SemVer value: leading `v` and build metadata
* fold away, so `v0.6.4`, `0.6.4`, and `0.6.4+build` dedupe as one release.
* Returns `undefined` for unparseable input; callers drop those first.
*/
function canonicalAStudioVersion(version) {
	const parsed = parseAStudioVersion(version);
	if (parsed === void 0) return void 0;
	return `${String(parsed.major)}.${String(parsed.minor)}.${String(parsed.patch)}` + (parsed.prerelease.length === 0 ? "" : `-${parsed.prerelease.join(".")}`);
}
function compareIdentifiers(left, right) {
	if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
	if (typeof left === "number") return -1;
	if (typeof right === "number") return 1;
	return left < right ? -1 : left > right ? 1 : 0;
}
/** Compare two versions using SemVer precedence (build metadata ignored). */
function compareAStudioVersions(left, right) {
	const a = parseAStudioVersion(left);
	const b = parseAStudioVersion(right);
	if (a === void 0 || b === void 0) throw new TypeError("invalid AStudio Connect version");
	for (const [aPart, bPart] of [
		[a.major, b.major],
		[a.minor, b.minor],
		[a.patch, b.patch]
	]) if (aPart !== bPart) return aPart < bPart ? -1 : 1;
	if (a.prerelease.length === 0 && b.prerelease.length !== 0) return 1;
	if (a.prerelease.length !== 0 && b.prerelease.length === 0) return -1;
	for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
		const aPart = a.prerelease[index];
		const bPart = b.prerelease[index];
		if (aPart === void 0) return -1;
		if (bPart === void 0) return 1;
		const comparison = compareIdentifiers(aPart, bPart);
		if (comparison !== 0) return comparison;
	}
	return 0;
}
function boundedText(value, maxBytes) {
	if (new TextEncoder().encode(value).byteLength > maxBytes) throw new RangeError("update response is too large");
	return value;
}
async function readBoundedText(response, maxBytes) {
	if (response.body === null) return boundedText(await response.text(), maxBytes);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel();
				throw new RangeError("update response is too large");
			}
			chunks.push(decoder.decode(next.value, { stream: true }));
		}
		chunks.push(decoder.decode());
		return chunks.join("");
	} finally {
		reader.releaseLock();
	}
}
async function fetchBounded(fetchImpl, url, maxBytes, timeoutMs, headers) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(/* @__PURE__ */ new Error("update request timed out"));
	}, timeoutMs);
	try {
		const response = await fetchImpl(url, {
			headers,
			signal: controller.signal
		});
		return {
			response,
			text: await readBoundedText(response, maxBytes)
		};
	} finally {
		clearTimeout(timer);
	}
}
/** Strip control characters, normalize newlines, and cap the length. */
function cleanReleaseText(value, maxLength) {
	if (typeof value !== "string" || value.length === 0) return void 0;
	const clean = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, "").replace(/\r\n?/gu, "\n").trim().slice(0, maxLength);
	return clean.length === 0 ? void 0 : clean;
}
function cleanPublishedAt(value) {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/iu.test(value) ? value.slice(0, 64) : void 0;
}
/**
* The `latest` dist-tag only. Pre-release channels are not this plugin's
* release line, so recommending one would be wrong even when newer.
*/
function latestDistTag(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return void 0;
	const tags = value["dist-tags"] ?? value;
	if (typeof tags !== "object" || tags === null || Array.isArray(tags)) return void 0;
	const candidate = tags["latest"];
	return typeof candidate === "string" && parseAStudioVersion(candidate) !== void 0 ? candidate : void 0;
}
function releasePageUrl(version) {
	return `${ASTRO_RELEASE_PAGE_BASE}v${version}`;
}
/**
* Parse GitHub's release-list page into the in-range releases, newest first.
* Unknown entry shapes are skipped, never fatal: the count and the notes both
* degrade per-entry rather than dropping the whole judgement.
*/
function releasesInRange(currentVersion, latestVersion, value) {
	if (!Array.isArray(value) || value.length > RELEASES_LIST_MAX) return void 0;
	const releases = [];
	const seen = /* @__PURE__ */ new Set();
	for (const raw of value) {
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
		const entry = raw;
		const tag = entry["tag_name"];
		if (typeof tag !== "string") continue;
		if (parseAStudioVersion(tag) === void 0) continue;
		if (compareAStudioVersions(tag, currentVersion) <= 0 || compareAStudioVersions(tag, latestVersion) > 0) continue;
		const canonical = canonicalAStudioVersion(tag);
		if (canonical === void 0 || seen.has(canonical)) continue;
		seen.add(canonical);
		const name = cleanReleaseText(entry["name"], RELEASE_NAME_MAX_CHARS);
		const notes = cleanReleaseText(entry["body"], RELEASE_NOTES_MAX_CHARS);
		const publishedAt = cleanPublishedAt(entry["published_at"]);
		releases.push({
			version: tag,
			...name === void 0 ? {} : { name },
			...notes === void 0 ? {} : { notes },
			...publishedAt === void 0 ? {} : { publishedAt }
		});
	}
	releases.sort((left, right) => compareAStudioVersions(right.version, left.version));
	return releases;
}
/** Enrich an available update from GitHub's release list; degrade on failure. */
async function releaseList(currentVersion, latestVersion, fetchImpl, timeoutMs) {
	try {
		const { response, text } = await fetchBounded(fetchImpl, ASTRO_UPDATE_RELEASES_API_URL, ASTRO_UPDATE_MAX_RELEASES_BYTES, timeoutMs, { accept: "application/vnd.github+json" });
		if (!response.ok) return void 0;
		return releasesInRange(currentVersion, latestVersion, JSON.parse(text));
	} catch {
		return;
	}
}
/** Check npm's public dist-tags and enrich an available update with release notes. */
async function checkAStudioUpdate(options) {
	const { currentVersion } = options;
	if (parseAStudioVersion(currentVersion) === void 0) return {
		status: "unavailable",
		currentVersion,
		reason: "invalid-current-version"
	};
	const fetchImpl = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? 8e3;
	let metadata;
	try {
		const { response, text } = await fetchBounded(fetchImpl, ASTRO_UPDATE_NPM_METADATA_URL, ASTRO_UPDATE_MAX_METADATA_BYTES, timeoutMs, { accept: "application/json" });
		if (!response.ok) return {
			status: "unavailable",
			currentVersion,
			reason: "registry-unavailable"
		};
		metadata = JSON.parse(text);
	} catch (error) {
		return {
			status: "unavailable",
			currentVersion,
			reason: error instanceof SyntaxError || error instanceof RangeError ? "invalid-registry-response" : "registry-unavailable"
		};
	}
	const latestVersion = latestDistTag(metadata);
	if (latestVersion === void 0) return {
		status: "unavailable",
		currentVersion,
		reason: "invalid-registry-response"
	};
	if (compareAStudioVersions(latestVersion, currentVersion) <= 0) return {
		status: "up-to-date",
		currentVersion,
		latestVersion: currentVersion
	};
	const releases = await releaseList(currentVersion, latestVersion, fetchImpl, timeoutMs);
	return {
		status: "update-available",
		currentVersion,
		latestVersion,
		releaseUrl: releasePageUrl(latestVersion),
		releases: releases ?? [],
		...releases === void 0 ? {} : { versionsBehind: releases.length }
	};
}
//#endregion
//#region src/update-route.ts
function json$1(res, status, value) {
	const payload = JSON.stringify(value);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		"Cache-Control": "no-store",
		"X-Content-Type-Options": "nosniff"
	});
	res.end(payload);
}
/** The same browser-origin gate the status route uses: DNS-rebinding pages die here. */
function browserRequestAllowed(req) {
	return hostIsLoopback$1(req.headers.host) && originIsLoopback(req.headers.origin);
}
/** Build the route handler; the caller owns registration and disposal. */
function astudioUpdateHandler(options) {
	return async (req, res) => {
		if (req.method !== "GET") {
			json$1(res, 405, { error: "method not allowed" });
			return;
		}
		if (!browserRequestAllowed(req)) {
			json$1(res, 403, { error: "forbidden" });
			return;
		}
		let result;
		try {
			result = await checkAStudioUpdate({
				currentVersion: options.currentVersion,
				...options.fetchImpl === void 0 ? {} : { fetchImpl: options.fetchImpl },
				timeoutMs: options.timeoutMs ?? 8e3
			});
		} catch {
			result = {
				status: "unavailable",
				currentVersion: options.currentVersion,
				reason: "registry-unavailable"
			};
		}
		json$1(res, 200, result);
	};
}
/** Register the update route on the optional host web server. */
function registerAStudioUpdateRoute(ctx, options) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "exact",
			path: ASTRO_UPDATE_PATH,
			handler: astudioUpdateHandler(options)
		});
		return () => {
			dispose();
		};
	});
}
//#endregion
//#region src/probe-store.ts
/**
* AStudio reasoning-probe persistence. Probe records are kept per
* `account:modelId` under the DSH home, so an observation survives restarts
* and is only reused while it is not expired.
*
* @module dsh-astudio-connect/probe-store
*/
/** Filename for probe records inside the DSH home. */
const ASTRO_PROBE_FILENAME = ".astudio-connect/probe.json";
/** File path for probe records. */
function astudioProbePath() {
	return join(resolveDshHome(), ASTRO_PROBE_FILENAME);
}
/** Read one probe record for one account/model pair, or undefined. */
function readProbeRecord(path, account, modelId) {
	if (!existsSync(path)) return void 0;
	try {
		const file = JSON.parse(readFileSync(path, "utf8"));
		if (file.version !== 1) return void 0;
		const record = file.probes.find((p) => p.account === account && p.modelId === modelId);
		if (record === void 0 || record.expiresAtMs <= Date.now()) return void 0;
		return record;
	} catch {
		return;
	}
}
/** Save one probe record. */
async function writeProbeRecord(path, record) {
	await mkdir(dirname(path), { recursive: true });
	const file = existsSync(path) ? readFileSync(path, "utf8") : "{}";
	const next = {
		version: 1,
		probes: [...(JSON.parse(file).probes ?? []).filter((p) => !(p.account === record.account && p.modelId === record.modelId)), record]
	};
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}
/** Clear all probe records for one account. */
async function clearProbeRecords(path, account) {
	const file = existsSync(path) ? readFileSync(path, "utf8") : "{}";
	const next = {
		version: 1,
		probes: (JSON.parse(file).probes ?? []).filter((p) => p.account !== account)
	};
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}
/** Create a store bound to one path. */
function createAStudioProbeStore(path = astudioProbePath()) {
	return {
		get: (account, modelId) => readProbeRecord(path, account, modelId),
		put: (record) => writeProbeRecord(path, record),
		clear: (account) => clearProbeRecords(path, account)
	};
}
//#endregion
//#region src/probe.ts
/** Generate a random sentinel string for the probe prompt. */
function randomSentinel() {
	return `probe-${Math.random().toString(36).slice(2, 10)}`;
}
/** Build a minimal chat completions body for a probe. */
function probeBody(modelId, effort, sentinel) {
	return {
		model: modelId,
		messages: [{
			role: "user",
			content: sentinel
		}],
		max_tokens: 1,
		reasoning_effort: effort
	};
}
/** Classify an upstream failure text into a probe state. */
function classifyProbeFailure(message) {
	if (message.toLowerCase().includes("invalid_parameter_value")) return {
		state: "rejected",
		validation: "non-validating",
		reason: "upstream rejected the reasoning effort"
	};
	return {
		state: "failed",
		reason: message.slice(0, 400)
	};
}
/** Send one probe request through the upstream client. */
async function probeModel(options) {
	const timeoutMs = options.timeoutMs ?? 3e4;
	const sentinel = randomSentinel();
	const body = probeBody(options.modelId, options.effort, sentinel);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const result = await options.upstream.chat(options.token, body, options.signal === void 0 ? controller.signal : AbortSignal.any([controller.signal, options.signal]));
		if (!result.ok) return {
			...classifyProbeFailure(result.message),
			efforts: []
		};
		return {
			state: "ok",
			validation: "validating",
			efforts: [options.effort]
		};
	} finally {
		clearTimeout(timer);
	}
}
//#endregion
//#region src/probe-service.ts
/**
* AStudio reasoning-probe service. It gates probe requests on explicit user
* consent, delegates the wire attempt to {@link probeModel}, and persists only
* validating observations.
*
* @module dsh-astudio-connect/probe-service
*/
/** Probe retention window. */
const PROBE_RETENTION_MS = 864e5;
/** Create a probe service. */
function createAStudioProbeService(options) {
	const account = options.account ?? localIdentity();
	async function probe(modelId, effort, consent, signal) {
		if (!consent) return {
			state: "unauthorized",
			efforts: [],
			reason: "reasoning-effort probes are disabled"
		};
		const token = options.token();
		if (token === void 0) return {
			state: "unauthorized",
			efforts: [],
			reason: "AStudio token not available"
		};
		const result = await probeModel({
			upstream: options.upstream,
			token,
			modelId,
			effort,
			...signal === void 0 ? {} : { signal }
		});
		if (result.state === "ok" && result.validation === "validating") await options.store.put({
			account,
			modelId,
			validation: "validating",
			efforts: result.efforts,
			expiresAtMs: Date.now() + PROBE_RETENTION_MS
		});
		return result;
	}
	return { probe };
}
//#endregion
//#region src/probe-route.ts
/**
* AStudio reasoning-probe route. The browser half of the settings card posts to
* `POST /astudio/probe/{modelId}` to run a probe for one model. Two guards stop
* different things:
*
* 1. **Loopback Host**, shared with the status route. This drops DNS-rebinding
*    pages, whose requests arrive addressed to the attacker's domain.
* 2. **An in-process shared key**, minted per process and handed only to the
*    same-origin card. Loopback alone is not authentication — any local process
*    can write `Host: 127.0.0.1` — so a route that spends a request against the
*    upstream must prove the caller was told the key.
*
* The request body may name an `effort`; when absent, probing uses `low`. The
* route never returns token material or the raw upstream body.
*
* @module dsh-astudio-connect/probe-route
*/
/** Header carrying the in-process probe key. */
const PROBE_KEY_HEADER = "x-astudio-probe-key";
/** Default effort used when the request body names none. */
const DEFAULT_PROBE_EFFORT = "low";
/** Largest control body accepted; these payloads are a few dozen bytes. */
const MAX_BODY_BYTES = 4096;
/** Mint the per-process probe key. */
function createAStudioProbeKey() {
	return randomBytes(24).toString("hex");
}
/** Check the Host header names a loopback interface. */
function hostIsLoopback(host) {
	if (!host) return false;
	const h = host.split(":")[0]?.toLowerCase() ?? "";
	return h === "127.0.0.1" || h === "localhost" || h === "[::1]";
}
/** Constant-time key comparison; a length mismatch is a failure, not a crash. */
function keyMatches(expected, presented) {
	if (presented === void 0 || presented.length !== expected.length) return false;
	const a = Buffer.from(expected);
	const b = Buffer.from(presented);
	return a.length === b.length && timingSafeEqual(a, b);
}
function json(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Content-Length": Buffer.byteLength(payload)
	});
	res.end(payload);
}
/** Read the request body with a hard ceiling. */
async function readBody(req) {
	const chunks = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		total += buffer.length;
		if (total > MAX_BODY_BYTES) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
/** Extract the model id from the trailing path segment, ignoring any query. */
function modelFromUrl(url) {
	if (url === void 0) return void 0;
	const path = url.split("?")[0] ?? "";
	const prefix = `${ASTRO_PROBE_PATH}/`;
	if (!path.startsWith(prefix)) return void 0;
	const modelId = path.slice(prefix.length);
	return modelId === "" ? void 0 : modelId;
}
/** Parse an optional `{ effort }` body; invalid bodies fall back to the default. */
function effortFromBody(text) {
	if (text === void 0 || text.trim() === "") return DEFAULT_PROBE_EFFORT;
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return DEFAULT_PROBE_EFFORT;
		const effort = parsed.effort;
		return typeof effort === "string" && effort.trim() !== "" ? effort : DEFAULT_PROBE_EFFORT;
	} catch {
		return DEFAULT_PROBE_EFFORT;
	}
}
/**
* The probe handler, extracted so tests can mount it on a bare server with a
* known key.
*/
function astudioProbeHandler(deps, key) {
	return async (req, res) => {
		if (req.method !== "POST") {
			json(res, 405, { error: "method-not-allowed" });
			return;
		}
		if (!hostIsLoopback(req.headers.host)) {
			json(res, 403, { error: "host-not-loopback" });
			return;
		}
		if (!keyMatches(key, req.headers[PROBE_KEY_HEADER])) {
			json(res, 403, { error: "invalid-probe-key" });
			return;
		}
		const modelId = modelFromUrl(req.url);
		if (modelId === void 0) {
			json(res, 404, { error: "missing-model-id" });
			return;
		}
		const effort = effortFromBody(await readBody(req));
		const controller = new AbortController();
		req.on("close", () => controller.abort());
		const result = await deps.service.probe(modelId, effort, true, controller.signal);
		if (result.state === "ok") deps.invalidate?.();
		const response = {
			state: result.state,
			efforts: result.efforts
		};
		if (result.validation !== void 0) response.validation = result.validation;
		if (result.reason !== void 0) response.reason = result.reason;
		json(res, 200, response);
	};
}
/** Mount the probe route on an optional webServer context. */
function registerAStudioProbeRoute(ctx, deps, key) {
	ctx.effect(() => {
		const dispose = ctx.webServer.register({
			kind: "prefix",
			path: ASTRO_PROBE_PATH,
			handler: astudioProbeHandler(deps, key)
		});
		return () => dispose();
	});
}
//#endregion
//#region src/pi-ai-guard.ts
/**
* Confirm the pi-ai copy this plugin actually loaded is the generation the
* DSH 0.2.1-rc.1 host was built against.
*
* #92's failure mode: a pnpm profile with `nodeLinker: hoisted` and
* `autoInstallPeers: false` installs no peer for us, so a co-installed
* plugin's older pi-ai sits at the profile root and wins bare-specifier
* resolution. The host then adds a system message (pi-ai 0.87's
* `collapseSystemMessages`) and the older copy answers `estimateMessageTokens`
* by reading `.length` off a block it does not model — every request dies at
* `PI_AI_ERROR` before any upstream HTTP. Declaring pi-ai as a regular
* dependency (package.json) is the fix; this module exists so a future
* regression reports *what* it loaded instead of that opaque crash.
*
* It is deliberately a warning, not a throw. The plugin is mid-load at this
* point, and a hard failure here would take down a host that may still be able
* to serve other providers. The message is the product; the operator decides.
*
* @module dsh-astudio-connect/pi-ai-guard
*/
/** The pi-ai generation this plugin is built and tested against. */
const REQUIRED_PI_AI_VERSION = "1.3.0";
/**
* Read the version of the pi-ai copy Node resolves for *this* module.
*
* The package's exports map does not open `./package.json`, so the manifest
* cannot be imported. Instead the module's own specifier is resolved and the
* resulting file is walked up to the directory whose `package.json` names
* `@earendil-works/pi-ai`. That reads the copy actually loaded rather than a
* guess from the install tree.
*
* @returns The resolved version, or undefined when it cannot be determined.
*/
function resolvedPiAiVersion() {
	let entry;
	try {
		entry = import.meta.resolve("@earendil-works/pi-ai");
	} catch {
		return;
	}
	let dir = dirname(fileURLToPath(entry));
	for (let step = 0; step < 5; step += 1) {
		try {
			const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
			if (manifest.name === "@earendil-works/pi-ai" && typeof manifest.version === "string") return manifest.version;
		} catch {}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
}
/**
* One line describing a pi-ai copy that is not the required generation, or
* undefined when the resolved version matches or cannot be read.
*
* The cause is left open on purpose. A hoisted profile root is the case #92
* measured, but an updater or installer can just as easily leave the wrong copy
* in place, and this diagnostic cannot tell them apart from a version string.
* Naming both versions and the remedy is what the reader can act on; naming only
* versions and the fix also keeps any filesystem path out of logs and reports.
*
* Carries no plugin prefix: callers log it under their own.
*
* @param resolved - Version to report on. Read from the live module graph when
* omitted; pass it explicitly to describe a hypothetical copy.
*/
function piAiVersionWarning(resolved) {
	const version = arguments.length === 0 ? resolvedPiAiVersion() : resolved;
	if (version === void 0 || version === "1.3.0") return void 0;
	return `loaded @earendil-works/pi-ai ${version}, but this plugin is built for ${REQUIRED_PI_AI_VERSION}. The wrong copy is being resolved — check the profile's pi-ai install (a pnpm profile with nodeLinker "hoisted" and autoInstallPeers false can expose another package's older copy). Reinstalling the plugin so it installs its own ${REQUIRED_PI_AI_VERSION} copy resolves it`;
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
	const piAiWarning = piAiVersionWarning();
	if (piAiWarning !== void 0) ctx.logger.warn(`dsh-astudio-connect: ${piAiWarning}`);
	const store = createAStudioAuth(config.configPath !== void 0 ? { configPath: config.configPath } : {});
	const upstream = createAStudioUpstream();
	const visibility = createAStudioVisibilityStore();
	const catalog = createAStudioCatalog({
		upstream,
		token: () => store.resolve(),
		visibility
	});
	const probeStore = createAStudioProbeStore();
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
			catalog,
			probe: probeStore
		});
		registerAStudioUpdateRoute(ctx, { currentVersion: ASTRO_VERSION });
		const probeService = createAStudioProbeService({
			upstream,
			token: () => store.resolve(),
			store: probeStore
		});
		const probeKey = createAStudioProbeKey();
		registerAStudioProbeRoute(ctx, {
			service: probeService,
			invalidate: () => {
				catalog.refresh().catch(() => {});
			}
		}, probeKey);
		writeHostHeartbeat();
		ctx.logger.info("dsh-astudio-connect: shim listening at", shim.baseUrl());
		catalog.refresh().catch(() => {});
	}).catch((error) => {
		ctx.logger.error("dsh-astudio-connect: shim failed to start", error);
	});
}
//#endregion
export { ASTRO_PROVIDER, ASTRO_SETTINGS_NS, ASTRO_STREAM_IDLE_TIMEOUT_MS, Config, DEFAULT_CATALOG, DEFAULT_UPSTREAM_URL, apply, apply as default, createAStudioAdapter, createAStudioAuth, createAStudioCatalog, createAStudioShim, createAStudioUpstream, inject, readTokenFromConfig };
