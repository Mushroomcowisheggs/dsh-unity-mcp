interface LoggerLike {
    info(message: string): void;
    warn(message: string): void;
}
export interface UnityConnectionConfigResolutionOptions {
    cwd?: string;
    environment?: NodeJS.ProcessEnv;
    modulePath?: string;
}
export interface ResolvedUnityConnectionConfig {
    host: string;
    port: number;
    requestTimeout: number;
    settingsPath?: string;
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
