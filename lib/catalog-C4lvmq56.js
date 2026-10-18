import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
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
	const current = () => {
		if (cached !== null) return cached;
		cached = readTokenFromConfig(configPath);
		return cached;
	};
	return {
		resolve() {
			return current();
		},
		invalidate() {
			cached = null;
		},
		async status() {
			const token = current();
			if (token === void 0) return {
				state: "signed-out",
				configPath,
				hints: ["AStudio config.toml was not found or has no experimental_bearer_token. Open AStudio and sign in."]
			};
			return {
				state: "signed-in",
				configPath,
				tokenLength: token.length,
				hints: []
			};
		},
		async logout() {
			cached = null;
		}
	};
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
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "spark-x2.5-4b",
		name: "Spark X2.5 4B",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 131072,
		maxTokens: 8192
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
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "xopglm52",
		name: "GLM-5.2",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "xopdeepseekv4pro",
		name: "DeepSeek V4 Pro",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "xopdeepseekv4pro0813",
		name: "DeepSeek V4 Pro 0813",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "xopdsv4flash0731in",
		name: "DeepSeek V4 Flash",
		supportsImages: false,
		reasoning: { supports: false },
		contextWindow: 131072,
		maxTokens: 8192
	},
	{
		id: "astronclaw-auto",
		name: "AstronClaw Auto",
		supportsImages: false,
		reasoning: { supports: false },
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
	let source = "fallback";
	let fetchedAtMs;
	const baseUrl = options.baseUrl ?? "https://maas-api.cn-huabei-1.xf-yun.com/v1";
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
	async function refresh() {
		const token = options.token();
		if (token === void 0) return;
		let fetched;
		try {
			const res = await fetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${token}` } });
			if (res.ok) {
				const data = await res.json();
				if (data.data && data.data.length > 0) {
					const knownIds = new Set(DEFAULT_CATALOG.map((m) => m.id));
					const upstreamIds = new Set(data.data.map((d) => d.id));
					fetched = DEFAULT_CATALOG.filter((m) => upstreamIds.has(m.id));
					for (const up of data.data) if (!knownIds.has(up.id)) fetched = [...fetched, {
						id: up.id,
						name: up.id,
						supportsImages: false,
						reasoning: { supports: false },
						contextWindow: 131072,
						maxTokens: 8192
					}];
				}
			}
		} catch {}
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
export { readTokenFromConfig as a, createAStudioAuth as i, createAStudioCatalog as n, ASTRO_LOCAL_IDENTITY as r, DEFAULT_CATALOG as t };
