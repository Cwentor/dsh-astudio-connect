#!/usr/bin/env node
import { a as createAStudioAuth, n as createAStudioCatalog } from "./catalog-DcqKkLz1.js";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
//#region src/bin.ts
/**
* AStudio Connect CLI: secret-free status, doctor, and logout.
*
* The CLI is boot-free: it never reads the token into a shell prompt or writes
* the AStudio config.toml. `logout` clears only the plugin's in-memory cache.
*
* @module dsh-astudio-connect/bin
*/
/** The only provider this bundle serves. */
const ASTRO_PROVIDER = "astudio";
function printHelp() {
	process.stdout.write([
		"Usage: dsh-astudio-connect <doctor|status|logout> [--provider astudio] [--json]",
		"",
		"  doctor   secret-free sign-in and environment diagnostics",
		"  status   sign-in state, catalog source, and model count",
		"  logout   clear the plugin in-memory credential cache",
		"",
		"  --provider  which provider to inspect; defaults to astudio",
		`              one of: ${ASTRO_PROVIDER}`,
		"  --json      emit one secret-free JSON document (doctor/status only)",
		""
	].join("\n"));
}
function printJson(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}
/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, "[redacted token]").replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, "$1[redacted]");
}
function makeStore(options = {}) {
	return createAStudioAuth(options.configPath !== void 0 ? { configPath: options.configPath } : {});
}
function makeCatalog(store) {
	return createAStudioCatalog({
		upstream: { chat: async () => {
			throw new Error("not used");
		} },
		token: () => store.resolve()
	});
}
async function doctor(jsonOutput, options) {
	const status = await makeStore(options).status();
	const configPresent = existsSync(status.configPath);
	const report = {
		schemaVersion: 1,
		package: "dsh-astudio-connect",
		provider: ASTRO_PROVIDER,
		signIn: status.state,
		configFile: {
			path: status.configPath,
			present: configPresent
		},
		hints: [...status.state === "signed-out" ? ["Sign in once in the AStudio desktop app, then run status again."] : [], ...configPresent ? [] : [`No AStudio config.toml at ${status.configPath}.`]]
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`AStudio Connect on ${process.version}`,
		`Config file: ${configPresent ? "present" : "missing"} — ${status.configPath}`,
		`Sign-in state: ${report.signIn}`,
		...report.hints.map((hint) => `Hint: ${hint}`),
		""
	].join("\n"));
	return status.state === "signed-in" && configPresent ? 0 : 1;
}
async function status(jsonOutput, options) {
	const store = makeStore(options);
	const authStatus = await store.status();
	const catalog = makeCatalog(store);
	const report = {
		schemaVersion: 1,
		package: "dsh-astudio-connect",
		provider: ASTRO_PROVIDER,
		state: authStatus.state,
		source: catalog.source(),
		modelCount: catalog.current().length
	};
	if (jsonOutput) printJson(report);
	else process.stdout.write([
		`AStudio Connect: ${report.state}`,
		`Catalog source: ${report.source}`,
		`Models: ${report.modelCount}`,
		""
	].join("\n"));
	return authStatus.state === "signed-in" ? 0 : 1;
}
/** Execute one boot-free command; returns the process exit code. */
async function run(argv, options = {}) {
	if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
		printHelp();
		return 0;
	}
	const [rawAction, ...flags] = argv;
	if (![
		"doctor",
		"logout",
		"status"
	].includes(rawAction)) {
		process.stderr.write(`dsh-astudio-connect: expected doctor, logout, or status; got ${JSON.stringify(rawAction)}\n`);
		return 1;
	}
	const action = rawAction;
	const jsonOutput = flags.includes("--json");
	let providerId;
	const rest = [];
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index];
		if (flag === "--provider") {
			providerId = flags[index + 1];
			index += 1;
			continue;
		}
		if (flag.startsWith("--provider=")) {
			providerId = flag.slice(11);
			continue;
		}
		rest.push(flag);
	}
	if (providerId === void 0) providerId = ASTRO_PROVIDER;
	if (providerId !== ASTRO_PROVIDER) {
		process.stderr.write(`dsh-astudio-connect: unknown provider ${JSON.stringify(providerId)}; expected ${ASTRO_PROVIDER}\n`);
		return 1;
	}
	if (rest.filter((flag) => flag !== "--json").length > 0 || jsonOutput && action === "logout") {
		process.stderr.write(`dsh-astudio-connect: invalid options for ${action}: ${flags.join(" ")}\n`);
		return 1;
	}
	try {
		switch (action) {
			case "doctor": return await doctor(jsonOutput, options);
			case "status": return await status(jsonOutput, options);
			case "logout":
				await makeStore(options).logout();
				process.stdout.write("AStudio Connect: credential cache cleared\n");
				return 0;
		}
	} catch (error) {
		process.stderr.write(`dsh-astudio-connect: ${action} failed: ${safeMessage(error)}\n`);
		return 1;
	}
}
if (process.argv[1] !== void 0 && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) process.exitCode = await run(process.argv.slice(2));
//#endregion
export { run };
