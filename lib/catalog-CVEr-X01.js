import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
//#region src/locations.ts
/**
* AStudio install-location discovery.
*
* AStudio records where it keeps its data in the Windows registry
* (`HKCU\Software\AStudioStorage`, values prefixed per release profile). That
* record — not a guess derived from the executable's path — is the authority
* for `config.toml` and `astron-session.json`. The probe order is:
*
*   1. an explicit path (settings), used verbatim
*   2. `ASTUDIO_DATA_HOME`, used verbatim
*   3. the registry record for the release profile
*   4. the install-sibling `<install dir> Data` directory
*
* A present-but-unreadable record is an error, never a silent fallthrough: a
* stale older install must not win over a newer one this plugin cannot read.
*
* @module dsh-astudio-connect/locations
*/
/** Environment variable that overrides the AStudio data root. */
const ASTRO_HOME_ENV = "ASTUDIO_DATA_HOME";
/** Registry key AStudio writes its storage location into. */
const ASTRO_STORAGE_REGISTRY_KEY = "HKCU\\Software\\AStudioStorage";
/** Release profile this bundle targets. */
const DEFAULT_PROFILE = "production";
/** The registry value-name prefix for one profile. */
function profilePrefix(profile) {
	if (profile === "production") return "Production";
	if (profile === "canary") return "Canary";
	return "Development";
}
/** Read one registry value out of parsed `reg query` output. */
function registryValues(output) {
	const values = /* @__PURE__ */ new Map();
	for (const line of output.split(/\r?\n/u)) {
		const match = /^\s{2,}(\S+)\s+REG_\w+\s+(.*)$/u.exec(line);
		if (match === null) continue;
		const name = match[1];
		const value = match[2];
		if (name === void 0 || value === void 0) continue;
		values.set(name, value.trim());
	}
	return values;
}
/**
* Parse AStudio's storage registry record for one profile.
*
* Returns undefined when the record is absent, and throws when the record is
* present but incomplete or of an unsupported schema version.
*/
function parseStorageRegistry(output, profile) {
	const values = registryValues(output);
	const prefix = profilePrefix(profile);
	const schemaVersion = values.get(`${prefix}SchemaVersion`);
	const dataRoot = values.get(`${prefix}DataRoot`);
	const acodeHome = values.get(`${prefix}AcodeHome`);
	if (schemaVersion === void 0 && dataRoot === void 0 && acodeHome === void 0) return void 0;
	if (schemaVersion === void 0) throw new Error(`AStudio ${prefix} storage location record is incomplete.`);
	if (schemaVersion !== "0x1" && schemaVersion !== "1") throw new Error(`Unsupported AStudio storage location schema: ${schemaVersion}`);
	if (dataRoot === void 0 || dataRoot === "" || acodeHome === void 0 || acodeHome === "") throw new Error(`AStudio ${prefix} storage location record is incomplete.`);
	return {
		dataRoot,
		acodeHome
	};
}
/** Derive the install-sibling data directory AStudio uses on Windows. */
function installSiblingHome(executablePath, profile) {
	const directoryName = profile === "canary" ? "AStudio Canary Data" : profile === "development" ? "AStudio Dev Data" : "AStudio Data";
	return join(dirname(executablePath), "..", directoryName);
}
/**
* Query AStudio's storage registry record through `reg.exe`.
*
* A non-zero exit or an unparseable answer reads as "no record" so a machine
* without AStudio degrades to the other candidates instead of failing. A
* record that *is* present but incomplete still throws, via
* {@link parseStorageRegistry}.
*/
function readStorageRegistry(options = {}) {
	if ((options.platform ?? process.platform) !== "win32") return void 0;
	const result = (options.run ?? defaultRun)("reg.exe", ["query", ASTRO_STORAGE_REGISTRY_KEY]);
	if (result.status !== 0 || result.stdout.trim() === "") return void 0;
	return parseStorageRegistry(result.stdout, options.profile ?? "production");
}
/** Run one subprocess synchronously and capture its stdout. */
function defaultRun(command, args) {
	const result = spawnSync(command, [...args], {
		encoding: "utf8",
		timeout: 5e3,
		windowsHide: true
	});
	return {
		status: result.status,
		stdout: result.stdout ?? ""
	};
}
/** Whether a path exists, used as the default usability predicate. */
function exists(path) {
	return existsSync(path);
}
/** The registry record a discovery run works from, if any. */
function storageRecordFor(input) {
	if (input.registryRecord !== void 0) return input.registryRecord;
	if (input.registryOutput === void 0) return void 0;
	return parseStorageRegistry(input.registryOutput, DEFAULT_PROFILE);
}
/** Enumerate probe candidates, keeping each one's provenance. */
function probeCandidates(input = {}) {
	const platform = input.platform ?? process.platform;
	const env = input.env ?? process.env;
	if (input.explicit !== void 0 && input.explicit !== "") return [{
		home: input.explicit,
		source: "explicit"
	}];
	const fromEnv = env[ASTRO_HOME_ENV]?.trim();
	if (fromEnv !== void 0 && fromEnv !== "") return [{
		home: fromEnv,
		source: "env"
	}];
	if (platform !== "win32") return [];
	const candidates = [];
	const record = storageRecordFor(input);
	if (record !== void 0) candidates.push({
		home: record.dataRoot,
		source: "registry"
	});
	if (input.executablePath !== void 0 && input.executablePath !== "") candidates.push({
		home: installSiblingHome(input.executablePath, DEFAULT_PROFILE),
		source: "install-sibling"
	});
	const seen = /* @__PURE__ */ new Set();
	return candidates.filter((candidate) => {
		if (seen.has(candidate.home)) return false;
		seen.add(candidate.home);
		return true;
	});
}
/**
* Resolve the AStudio data root to the first readable candidate.
*
* Returns a diagnostic rather than throwing so the status card can explain an
* unresolved home instead of surfacing an opaque failure.
*/
function resolveAstudioHome(input = {}) {
	const isReadable = input.isReadable ?? exists;
	const platform = input.platform ?? process.platform;
	const candidates = probeCandidates(input);
	if (candidates.length === 0) return {
		ok: false,
		reason: platform === "win32" ? "No AStudio data directory was found. Start AStudio once, or set ASTUDIO_DATA_HOME." : `Automatic AStudio location discovery is only implemented for Windows (this platform is ${platform}). Set ASTUDIO_DATA_HOME.`,
		tried: []
	};
	for (const candidate of candidates) {
		if (!(candidate.source === "explicit" || candidate.source === "env") && !isReadable(candidate.home)) continue;
		const record = storageRecordFor(input);
		return {
			ok: true,
			home: candidate.home,
			source: candidate.source,
			...record === void 0 ? {} : { record }
		};
	}
	return {
		ok: false,
		reason: `AStudio data directory not found. Tried: ${candidates.map((candidate) => candidate.home).join(" or ")}. Start AStudio once, or set ${ASTRO_HOME_ENV}.`,
		tried: candidates.map((candidate) => candidate.home)
	};
}
/** Path to AStudio's runtime config.toml inside one data root. */
function configPathForHome(home) {
	return join(home, "runtime", "acode-home", "config.toml");
}
/** Path to AStudio's astron-session.json inside one data root. */
function sessionFilePathForHome(home) {
	return join(home, "userdata", "astron-session.json");
}
//#endregion
//#region src/auth.ts
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
/** Regex for the bearer-token field in config.toml. */
const TOKEN_PATTERN = /experimental_bearer_token\s*=\s*"([^"]+)"/;
/**
* Read the chat bearer token from a config.toml.
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
* Read the model-manager token from astron-session.json.
*
* AStudio issues this separately from the chat token; it authenticates the
* model-manager API that serves the authoritative roster. Returns undefined
* for a missing file, malformed JSON, an absent field, or a blank value.
*/
function readModelBearerToken(sessionPath) {
	if (!existsSync(sessionPath)) return void 0;
	let content;
	try {
		content = readFileSync(sessionPath, "utf8");
	} catch {
		return;
	}
	let parsed;
	try {
		parsed = JSON.parse(content);
	} catch {
		return;
	}
	if (typeof parsed !== "object" || parsed === null) return void 0;
	const value = parsed["modelBearerToken"];
	if (typeof value !== "string" || value.trim() === "") return void 0;
	return value.trim();
}
/**
* Resolve config.toml for a data root or an explicit override.
*
* Falls back to the discovered AStudio home, keeping the plugin usable with
* zero configuration on a machine where AStudio is installed normally.
*/
function resolveDefaultConfigPath(options = {}) {
	if (options.explicit !== void 0 && options.explicit !== "") return options.explicit;
	if (options.dataHome !== void 0 && options.dataHome !== "") return configPathForHome(options.dataHome);
	const resolved = resolveHomeForOptions(options);
	return resolved === void 0 ? "" : configPathForHome(resolved);
}
/** Resolve the AStudio data root from discovery, or undefined when unknown. */
function resolveHomeForOptions(options) {
	const registryRecord = readStorageRegistry({ ...options.platform === void 0 ? {} : { platform: options.platform } });
	const resolved = resolveAstudioHome({
		...options.platform === void 0 ? {} : { platform: options.platform },
		...options.env === void 0 ? {} : { env: options.env },
		...registryRecord === void 0 ? {} : { registryRecord }
	});
	return resolved.ok ? resolved.home : void 0;
}
/**
* Create a credential store that reads both AStudio files and caches the
* results in memory. Call `invalidate()` to force a re-read (e.g. after the
* user signs in again).
*/
function createAStudioAuth(options = {}) {
	const dataHome = options.dataHome;
	const explicitConfig = options.configPath;
	let cachedToken = null;
	let cachedModelToken = null;
	let cachedConfigPath;
	const configPath = () => {
		if (cachedConfigPath !== void 0) return cachedConfigPath;
		cachedConfigPath = resolveDefaultConfigPath({
			...explicitConfig === void 0 ? {} : { explicit: explicitConfig },
			...dataHome === void 0 ? {} : { dataHome }
		});
		return cachedConfigPath;
	};
	/** The astron-session.json beside the resolved config.toml. */
	const sessionPath = () => {
		if (dataHome !== void 0 && dataHome !== "") return sessionFilePathForHome(dataHome);
		const home = resolveHomeForOptions({});
		if (home !== void 0) return sessionFilePathForHome(home);
		return sessionFilePathForHome(resolvedHomeFromConfig(configPath()));
	};
	const current = () => {
		if (cachedToken !== null) return cachedToken;
		cachedToken = readTokenFromConfig(configPath());
		return cachedToken;
	};
	const currentModelToken = () => {
		if (cachedModelToken !== null) return cachedModelToken;
		cachedModelToken = readModelBearerToken(sessionPath());
		return cachedModelToken;
	};
	return {
		resolve() {
			return current();
		},
		modelBearerToken() {
			return currentModelToken();
		},
		/**
		* The `astron-session.json` this store reads its credentials from.
		*
		* The points client reads the account's `ssoSessionId` from the same file,
		* so it is resolved here — where AStudio's layout is already known — rather
		* than re-derived by the caller.
		*/
		sessionPath() {
			return sessionPath();
		},
		invalidate() {
			cachedToken = null;
			cachedModelToken = null;
		},
		async status() {
			const token = current();
			if (token === void 0) return {
				state: "signed-out",
				configPath: configPath(),
				hints: ["AStudio config.toml was not found or has no experimental_bearer_token. Open AStudio and sign in."]
			};
			const hasModelToken = currentModelToken() !== void 0;
			return {
				state: "signed-in",
				configPath: configPath(),
				tokenLength: token.length,
				hasModelToken,
				hints: hasModelToken ? [] : ["astron-session.json has no modelBearerToken; the model catalog will serve the built-in roster."]
			};
		},
		async logout() {
			cachedToken = null;
			cachedModelToken = null;
		}
	};
}
/** Walk back from a config.toml path to the data root that contains it. */
function resolvedHomeFromConfig(configPath) {
	const fromRuntime = configPath.replace(/[\\/]runtime[\\/]acode-home[\\/]config\.toml$/iu, "");
	return fromRuntime === configPath ? configPath : fromRuntime;
}
//#endregion
//#region src/identity.ts
/**
* Local identity for AStudio Connect.
*
* AStudio's config token does not carry a stable user id, so per-account
* catalog, visibility, and probe persistence collapses to one local identity.
*
* @module dsh-astudio-connect/identity
*/
/** Stable local identity used by all AStudio Connect persistence. */
const ASTRO_LOCAL_IDENTITY = "astudio-local";
/** Resolve the local identity used by catalog, visibility, and probe stores. */
function localIdentity() {
	return ASTRO_LOCAL_IDENTITY;
}
//#endregion
//#region src/catalog-store.ts
/**
* AStudio catalog persistence. One file under the DSH home keeps the last
* successful model snapshot per identity, so a restart or a failed fetch can
* serve the account's last good roster instead of the compiled-in fallback.
*
* @module dsh-astudio-connect/catalog-store
*/
/** Filename for the catalog snapshot file inside the DSH home. */
const ASTRO_CATALOG_FILENAME = ".astudio-connect/catalog.json";
/** File path for the catalog snapshot file. */
function astudioCatalogPath() {
	return join(resolveDshHome(), ASTRO_CATALOG_FILENAME);
}
/** Read a snapshot for one identity, or undefined when none is saved. */
async function readCatalogSnapshot(path, identity) {
	try {
		const file = JSON.parse(await readFile(path, "utf8"));
		if (file.version !== 1) return void 0;
		const snapshot = file.catalogs[identity];
		if (snapshot === void 0) return void 0;
		if (!Array.isArray(snapshot.models)) return void 0;
		return snapshot;
	} catch {
		return;
	}
}
/** Write a snapshot for one identity with a sibling temp file plus rename. */
async function writeCatalogSnapshot(path, identity, models, fetchedAtMs) {
	await mkdir(dirname(path), { recursive: true });
	const file = await readFile(path, "utf8").catch(() => "{}");
	const next = {
		version: 1,
		catalogs: {
			...JSON.parse(file).catalogs,
			[identity]: {
				fetchedAtMs,
				models: [...models]
			}
		}
	};
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
	await rename(tmp, path);
}
//#endregion
//#region src/model-manager.ts
/** Production model-manager API base. */
const DEFAULT_MODEL_MANAGER_BASE = "https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager";
/** Build the catalog URL from a model-manager base. */
function modelManagerUrl(base = DEFAULT_MODEL_MANAGER_BASE) {
	return `${base.replace(/\/+$/u, "")}/models`;
}
/** Thinking levels this plugin maps onto pi-ai's scale. */
const MAPPED_EFFORTS = /* @__PURE__ */ new Set([
	"low",
	"medium",
	"high",
	"max",
	"xhigh"
]);
function positiveInteger(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : void 0;
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
/** Extract the declared reasoning efforts a model actually supports. */
function reasoningFor(raw) {
	const levels = Array.isArray(raw.supported_reasoning_levels) ? raw.supported_reasoning_levels : [];
	const efforts = /* @__PURE__ */ new Set();
	let canDisableThinking = false;
	for (const level of levels) {
		const record = asRecord(level);
		const effort = typeof record?.["effort"] === "string" ? record["effort"] : void 0;
		if (effort === void 0) continue;
		if (effort === "none") {
			canDisableThinking = true;
			continue;
		}
		if (MAPPED_EFFORTS.has(effort)) efforts.add(effort);
	}
	if (efforts.size === 0 && !canDisableThinking) return { supports: false };
	return {
		supports: true,
		supportedEfforts: [...efforts],
		canDisableThinking
	};
}
/** Parse one raw model row, or undefined when it carries no usable budgets. */
function parseModel(raw) {
	const id = typeof raw.slug === "string" ? raw.slug : "";
	if (id === "") return void 0;
	if (raw.supported_in_api === false) return void 0;
	if (typeof raw.visibility === "string" && raw.visibility !== "list") return void 0;
	const contextWindow = positiveInteger(raw.context_window);
	const maxTokens = positiveInteger(raw.max_output_tokens);
	if (contextWindow === void 0 || maxTokens === void 0) return void 0;
	return {
		id,
		name: typeof raw.display_name === "string" && raw.display_name !== "" ? raw.display_name : id,
		supportsImages: false,
		reasoning: { ...reasoningFor(raw) },
		contextWindow,
		maxTokens
	};
}
/**
* Parse a model-manager payload into catalog entries.
*
* Throws when the envelope reports a failure or when no row survives, so a
* refresh cannot silently replace a good roster with an empty one.
*/
function parseModelManagerCatalog(payload) {
	const envelope = asRecord(payload);
	if (envelope === void 0) throw new Error("AStudio model catalog was not an object");
	const code = envelope["code"];
	if (code !== void 0 && code !== 0 && code !== "0") {
		const message = typeof envelope["message"] === "string" ? envelope["message"] : "unknown error";
		throw new Error(`AStudio model catalog request failed: ${message}`);
	}
	const data = asRecord(envelope["data"]);
	const rawModels = Array.isArray(data?.["models"]) ? data["models"] : [];
	const models = [];
	for (const rawModel of rawModels) {
		const record = asRecord(rawModel);
		if (record === void 0) continue;
		const model = parseModel(record);
		if (model !== void 0) models.push(model);
	}
	if (models.length === 0) throw new Error("AStudio model catalog resolved to an empty list");
	return models;
}
/**
* Merge live entries over a fallback roster.
*
* The fallback's order and metadata win for ids the live catalog also lists —
* the live document is the authority for budgets, but the compiled-in names
* keep the picker stable. Live-only ids are appended with a minimal name.
*/
function buildCatalogFromUpstream(live, fallback) {
	const byId = new Map(live.map((model) => [model.id, model]));
	const merged = [];
	for (const entry of fallback) {
		const override = byId.get(entry.id);
		merged.push(override === void 0 ? entry : override);
		byId.delete(entry.id);
	}
	for (const extra of byId.values()) merged.push(extra);
	return merged;
}
//#endregion
//#region src/catalog.ts
/** Default built-in catalog — used when the upstream /v1/models is unavailable. */
const DEFAULT_CATALOG = [
	{
		id: "spark-x2.5",
		name: "Spark X2.5",
		supportsImages: false,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			canDisableThinking: false
		},
		contextWindow: 262144,
		maxTokens: 1e5
	},
	{
		id: "spark-x2.5-4b",
		name: "Spark X2.5 4B",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 1048576,
		maxTokens: 11e4
	},
	{
		id: "spark-x2.6-preview",
		name: "Spark X2.6 Preview",
		supportsImages: false,
		reasoning: {
			supports: true,
			supportedEfforts: [
				"low",
				"high",
				"max"
			],
			canDisableThinking: false
		},
		contextWindow: 262144,
		maxTokens: 1e5
	},
	{
		id: "xopglm52",
		name: "GLM-5.2",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 1048576,
		maxTokens: 1e5
	},
	{
		id: "xopdeepseekv4pro",
		name: "DeepSeek V4 Pro",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 1048576,
		maxTokens: 1e5
	},
	{
		id: "xopdeepseekv4pro0813",
		name: "DeepSeek V4 Pro 0813",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 1048576,
		maxTokens: 1e5
	},
	{
		id: "xopdsv4flash0731in",
		name: "DeepSeek V4 Flash",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 1048576,
		maxTokens: 1e5
	},
	{
		id: "astronclaw-auto",
		name: "AstronClaw Auto",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 1048576,
		maxTokens: 1e5
	}
];
/**
* Create a catalog backed by the upstream /v1/models endpoint.
* Falls back to DEFAULT_CATALOG when the refresh fails.
*/
function createAStudioCatalog(options) {
	let cached = DEFAULT_CATALOG;
	let source = "fallback";
	let fetchedAtMs;
	const modelManagerBase = options.modelManagerBaseUrl ?? "https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager";
	const identity = options.identity ?? "astudio-local";
	const catalogPath = options.catalogPath ?? astudioCatalogPath();
	const visibility = options.visibility;
	async function loadSaved() {
		const snapshot = await readCatalogSnapshot(catalogPath, identity);
		if (snapshot === void 0) return;
		cached = snapshot.models;
		source = "saved";
		fetchedAtMs = snapshot.fetchedAtMs;
	}
	/**
	* Fetch the roster from AStudio's model-manager API.
	*
	* That document is what the AStudio UI itself renders, and it carries the
	* real per-model context and output budgets. The OpenAI-compatible
	* `/v1/models` endpoint is deliberately not used: it answers with a smaller,
	* stale subset, which would drop models that are in fact callable.
	*/
	async function fetchLive() {
		const modelToken = options.modelBearerToken?.();
		if (modelToken === void 0 || modelToken === "") return void 0;
		try {
			const res = await fetch(modelManagerUrl(modelManagerBase), { headers: {
				Authorization: `Bearer ${modelToken}`,
				Accept: "application/json"
			} });
			if (!res.ok) return void 0;
			return buildCatalogFromUpstream(parseModelManagerCatalog(await res.json()), DEFAULT_CATALOG);
		} catch {
			return;
		}
	}
	async function refresh() {
		const fetched = await fetchLive();
		if (fetched !== void 0) {
			await writeCatalogSnapshot(catalogPath, identity, fetched, Date.now());
			cached = fetched;
			source = "live";
			fetchedAtMs = Date.now();
			return;
		}
		const hadFallback = source === "fallback";
		await loadSaved();
		if (hadFallback) return;
	}
	return {
		current: () => cached,
		refresh,
		source: () => source,
		fetchedAtMs: () => fetchedAtMs,
		hiddenModelIds: () => visibility === void 0 ? [] : [...visibility.hidden(identity) ?? []]
	};
}
//#endregion
export { createAStudioAuth as a, localIdentity as i, createAStudioCatalog as n, readTokenFromConfig as o, ASTRO_LOCAL_IDENTITY as r, DEFAULT_CATALOG as t };
