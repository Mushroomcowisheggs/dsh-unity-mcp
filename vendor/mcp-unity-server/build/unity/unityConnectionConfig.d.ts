interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
}
export interface UnityConnectionConfigResolutionOptions {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    modulePath?: string;
}
/** One candidate bridge target: a Unity project's endpoint plus its token. */
export interface ResolvedUnityConnectionCandidate {
    projectRoot?: string;
    host: string;
    port: number;
    authToken: string;
    /** Diagnostic label; never contains the token itself. */
    source: string;
}
export interface ResolvedUnityConnectionConfig {
    host: string;
    port: number;
    requestTimeout: number;
    /** Bridge authentication token (empty when the bridge does not use authentication). */
    authToken: string;
    /** Where the token came from: an env var, the Unity project, or `none`. */
    authTokenSource: string;
    settingsPath?: string;
    /**
     * Ordered connection targets (primary first, then `MCP_UNITY_PROJECT_PATHS`
     * candidates). The connection walks them to identify the live project, which
     * is what makes several Unity projects on one machine work without config.
     */
    candidates: ResolvedUnityConnectionCandidate[];
}
/**
 * Resolves the bridge connection settings from explicit process configuration,
 * then the Unity project settings file, and finally safe defaults.
 *
 * A package-cache install keeps Server~ below the Unity project root, so
 * searching ancestors of the executing module works even when an MCP client
 * starts Node from an unrelated working directory.
 */
export declare function resolveUnityConnectionConfig(logger: LoggerLike, options?: UnityConnectionConfigResolutionOptions): Promise<ResolvedUnityConnectionConfig>;
export {};
