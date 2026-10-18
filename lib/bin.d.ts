//#region src/bin.d.ts
/**
 * AStudio Connect CLI: secret-free status, doctor, and logout.
 *
 * The CLI is boot-free: it never reads the token into a shell prompt or writes
 * the AStudio config.toml. `logout` clears only the plugin's in-memory cache.
 *
 * @module dsh-astudio-connect/bin
 */
/** Options shared by the run entry point and its command handlers. */
interface RunOptions {
  /** Override the AStudio config.toml path (used by tests). */
  configPath?: string;
}
/** Execute one boot-free command; returns the process exit code. */
declare function run(argv: readonly string[], options?: RunOptions): Promise<number>;
//#endregion
export { RunOptions, run };