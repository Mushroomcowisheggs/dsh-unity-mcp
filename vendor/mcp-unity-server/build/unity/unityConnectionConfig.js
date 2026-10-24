import { promises as fs } from 'fs';
import { readFileSync } from 'fs';
import path from 'path';
import { McpUnityError, ErrorType } from '../utils/errors.js';
const DEFAULT_PORT = 8090;
const DEFAULT_HOST = 'localhost';
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 10;
const SETTINGS_RELATIVE_PATH = path.join('ProjectSettings', 'McpUnitySettings.json');
const TOKEN_RELATIVE_PATH = path.join('Library', 'McpUnity', 'bridge-token');
const TOKEN_PATTERN = /^[0-9a-fA-F]{64}$/;
const NO_TOKEN_SOURCE = 'none';
/**
 * Resolves the bridge connection settings from explicit process configuration,
 * then the Unity project settings file, and finally safe defaults.
 *
 * A package-cache install keeps Server~ below the Unity project root, so
 * searching ancestors of the executing module works even when an MCP client
 * starts Node from an unrelated working directory.
 *
 * Authentication: Unity bridges shipped with mcp-unity authentication require
 * HTTP Basic credentials (`mcp-unity:<token>`), where the token lives in
 * `<Unity project>/Library/McpUnity/bridge-token`. The token is resolved from
 * `MCP_UNITY_AUTH_TOKEN`, then `MCP_UNITY_AUTH_TOKEN_PATH`, then the project
 * containing the discovered `McpUnitySettings.json`. Unlike upstream, a token
 * that simply cannot be found is not fatal here: bridges predating
 * authentication have no token file, so the resolver warns and connects
 * unauthenticated. A bridge that does require authentication then answers 401,
 * which `UnityConnection` reports as a terminal authentication error instead of
 * a reconnect storm.
 */
export async function resolveUnityConnectionConfig(logger, options = {}) {
    const cwd = path.resolve(options.cwd ?? process.cwd());
    const environment = options.environment ?? process.env;
    const modulePath = path.resolve(options.modulePath ?? process.argv[1] ?? cwd);
    const settingsFile = await findSettingsFile(logger, cwd, modulePath, environment);
    const settings = settingsFile?.settings ?? {};
    const settingsSource = settingsFile ? `McpUnitySettings.json (${settingsFile.path})` : 'default settings';
    const authentication = await resolveAuthenticationToken(logger, cwd, environment, settingsFile?.path);
    const port = resolveIntegerSetting({
        environment,
        environmentName: 'UNITY_PORT',
        configurationValue: settings.Port,
        configurationName: 'Port',
        configurationSource: settingsSource,
        defaultValue: DEFAULT_PORT,
        isValid: value => value >= 1 && value <= 65535,
        invalidDescription: 'an integer between 1 and 65535',
        logger
    });
    const host = resolveStringSetting({
        environment,
        environmentName: 'UNITY_HOST',
        configurationValue: settings.Host,
        configurationName: 'Host',
        configurationSource: settingsSource,
        defaultValue: DEFAULT_HOST,
        logger
    });
    const timeoutSeconds = resolveIntegerSetting({
        environment,
        environmentName: 'UNITY_REQUEST_TIMEOUT',
        configurationValue: settings.RequestTimeoutSeconds,
        configurationName: 'RequestTimeoutSeconds',
        configurationSource: settingsSource,
        defaultValue: DEFAULT_REQUEST_TIMEOUT_SECONDS,
        isValid: value => value >= DEFAULT_REQUEST_TIMEOUT_SECONDS,
        invalidDescription: `an integer of at least ${DEFAULT_REQUEST_TIMEOUT_SECONDS}`,
        logger
    });
    logger.info(`Using port: ${port.value} for Unity WebSocket connection (source: ${port.source})`);
    logger.info(`Using host: ${host.value} for Unity WebSocket connection (source: ${host.source})`);
    logger.info(`Using request timeout: ${timeoutSeconds.value} seconds (source: ${timeoutSeconds.source})`);
    if (authentication.source !== NO_TOKEN_SOURCE) {
        logger.info(`Using Unity bridge authentication token (source: ${authentication.source})`);
    }
    // Candidate projects (MCP_UNITY_PROJECT_PATHS) let the connection identify the
    // live Unity project by trial: one bridge serves one project, so the first
    // credentials the bridge accepts belong to the project the user is editing.
    const candidates = resolveProjectCandidates(logger, environment, cwd, {
        host: host.value,
        port: port.value,
        authToken: authentication.token,
        authTokenSource: authentication.source,
        settingsPath: settingsFile?.path
    });
    if (candidates.length > 1) {
        logger.info(`Unity bridge will try ${candidates.length} candidate project targets in order: ` +
            candidates.map(candidate => candidate.source).join(' -> '));
    }
    return {
        host: host.value,
        port: port.value,
        requestTimeout: timeoutSeconds.value * 1000,
        authToken: authentication.token,
        authTokenSource: authentication.source,
        settingsPath: settingsFile?.path,
        candidates
    };
}
/**
 * Builds the ordered list of connection candidates.
 *
 * `MCP_UNITY_PROJECT_PATHS` holds candidate Unity project roots (in priority
 * order) as discovered by the DSH plugin — the harness process runs outside any
 * Unity project, so its cwd cannot be used to find one. Each candidate carries
 * its own port (from that project's McpUnitySettings.json) and token (from that
 * project's Library/McpUnity/bridge-token), which is what makes "one bridge per
 * project, several projects on the machine" work without per-project config.
 *
 * The primary target resolved above is always tried first, so explicitly
 * configured credentials keep winning.
 */
function resolveProjectCandidates(logger, environment, cwd, primary) {
    const candidates = [];
    const seen = new Set();
    const add = (candidate) => {
        if (!candidate.token && candidate.source === NO_TOKEN_SOURCE && !candidate.projectRoot) {
            return;
        }
        const key = `${candidate.host}:${candidate.port}:${candidate.token ? candidate.token : 'anonymous'}`;
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        candidates.push(candidate);
    };
    const primaryProjectRoot = primary.settingsPath
        ? path.dirname(path.dirname(primary.settingsPath))
        : undefined;
    // Label honestly: an explicitly configured token is not "the project's token",
    // even when the project path is also known.
    const tokenConfiguredExplicitly = primary.authTokenSource === 'MCP_UNITY_AUTH_TOKEN' ||
        primary.authTokenSource.startsWith('MCP_UNITY_AUTH_TOKEN_PATH');
    add({
        projectRoot: primaryProjectRoot,
        host: primary.host,
        port: primary.port,
        authToken: primary.authToken,
        token: primary.authToken,
        source: tokenConfiguredExplicitly
            ? `configured token (${primary.authTokenSource})`
            : (primaryProjectRoot ?? 'primary target')
    });
    const configured = environment.MCP_UNITY_PROJECT_PATHS;
    if (!configured || !configured.trim()) {
        return candidates;
    }
    for (const entry of configured.split(path.delimiter)) {
        const projectRoot = entry.trim();
        if (!projectRoot) {
            continue;
        }
        const resolvedRoot = path.resolve(cwd, projectRoot);
        const settingsPath = path.join(resolvedRoot, SETTINGS_RELATIVE_PATH);
        const settings = readSettingsFileSync(settingsPath);
        const tokenPath = path.join(resolvedRoot, TOKEN_RELATIVE_PATH);
        const token = readOptionalToken(tokenPath);
        if (!settings && !token) {
            continue;
        }
        add({
            projectRoot: resolvedRoot,
            host: normalizeString(settings?.Host) ?? primary.host,
            port: parseInteger(settings?.Port) ?? primary.port,
            authToken: token,
            token,
            source: token ? `${resolvedRoot}` : `${resolvedRoot} (no token file)`
        });
    }
    if (candidates.length > 1) {
        logger.info(`Candidate project targets: ${candidates.map(candidate => candidate.source).join(' -> ')}`);
    }
    return candidates;
}
function readSettingsFileSync(settingsPath) {
    try {
        const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * Reads a candidate project token. A missing or malformed file simply means the
 * candidate is tried unauthenticated (bridges predating authentication have no
 * token file at all); it is never fatal, because another candidate may be the
 * live project.
 */
function readOptionalToken(tokenPath) {
    try {
        const token = readFileSync(tokenPath, 'utf-8').trim();
        return TOKEN_PATTERN.test(token) ? token : '';
    }
    catch {
        return '';
    }
}
/**
 * Resolves the bridge authentication token.
 *
 * An explicitly configured token (value or path) must be valid, otherwise the
 * configuration itself is wrong and failing loudly beats a puzzling 401 later.
 * A token that only project discovery could have supplied is optional.
 */
async function resolveAuthenticationToken(logger, cwd, environment, settingsPath) {
    const explicitToken = environment.MCP_UNITY_AUTH_TOKEN;
    if (explicitToken !== undefined) {
        const token = explicitToken.trim();
        validateAuthenticationToken(token, 'MCP_UNITY_AUTH_TOKEN');
        return { token, source: 'MCP_UNITY_AUTH_TOKEN' };
    }
    const explicitPath = environment.MCP_UNITY_AUTH_TOKEN_PATH;
    if (explicitPath !== undefined) {
        const configuredPath = explicitPath.trim();
        if (!configuredPath) {
            throw new McpUnityError(ErrorType.AUTHENTICATION, 'MCP_UNITY_AUTH_TOKEN_PATH must be a non-empty file path.');
        }
        const tokenPath = path.resolve(cwd, configuredPath);
        const token = await readAuthenticationToken(tokenPath, 'MCP_UNITY_AUTH_TOKEN_PATH');
        return { token, source: `MCP_UNITY_AUTH_TOKEN_PATH (${tokenPath})` };
    }
    if (!settingsPath) {
        logger.warn('Unity bridge authentication token was not configured and no Unity project could be discovered. ' +
            'Bridges without authentication still connect; a bridge that requires one answers 401 until ' +
            'MCP_UNITY_AUTH_TOKEN or MCP_UNITY_AUTH_TOKEN_PATH is set (both are generated by ' +
            'Tools > MCP Unity > Server Window in Unity).');
        return { token: '', source: NO_TOKEN_SOURCE };
    }
    const projectRoot = path.dirname(path.dirname(settingsPath));
    const tokenPath = path.join(projectRoot, TOKEN_RELATIVE_PATH);
    return readDiscoveredAuthenticationToken(logger, tokenPath);
}
/**
 * Reads the token of a discovered Unity project. A missing file is not an
 * error: it only means the project never generated one (bridge without
 * authentication, or the server window was never opened).
 */
async function readDiscoveredAuthenticationToken(logger, tokenPath) {
    let content;
    try {
        content = await fs.readFile(tokenPath, 'utf-8');
    }
    catch (error) {
        logger.warn(`No Unity bridge authentication token was found at ${tokenPath}; connecting without authentication. ` +
            'If Unity rejects the connection with HTTP 401, set MCP_UNITY_AUTH_TOKEN_PATH to that file.');
        return { token: '', source: NO_TOKEN_SOURCE };
    }
    const token = content.trim();
    if (!TOKEN_PATTERN.test(token)) {
        logger.warn(`Ignoring the malformed Unity bridge authentication token at ${tokenPath}: ` +
            'the token must be exactly 64 hexadecimal characters. Regenerate it from Tools > MCP Unity > Server Window.');
        return { token: '', source: NO_TOKEN_SOURCE };
    }
    return { token, source: `Unity project (${tokenPath})` };
}
async function readAuthenticationToken(tokenPath, source) {
    let token;
    try {
        token = (await fs.readFile(tokenPath, 'utf-8')).trim();
    }
    catch (error) {
        throw new McpUnityError(ErrorType.AUTHENTICATION, `Could not read the Unity bridge authentication token from ${source} at ${tokenPath}. ` +
            'Open Tools > MCP Unity > Server Window in Unity to copy or regenerate the token. ' +
            `(${error instanceof Error ? error.message : String(error)})`);
    }
    validateAuthenticationToken(token, `${source} at ${tokenPath}`);
    return token;
}
function validateAuthenticationToken(token, source) {
    if (!TOKEN_PATTERN.test(token)) {
        throw new McpUnityError(ErrorType.AUTHENTICATION, `The Unity bridge authentication token from ${source} must contain exactly 64 hexadecimal characters.`);
    }
}
async function findSettingsFile(logger, cwd, modulePath, environment) {
    const attemptedPaths = new Set();
    const explicitPath = environment.MCP_UNITY_SETTINGS_PATH;
    if (explicitPath && explicitPath.trim()) {
        const resolvedExplicitPath = path.resolve(cwd, explicitPath);
        attemptedPaths.add(resolvedExplicitPath);
        const settings = await readSettingsFile(resolvedExplicitPath, logger, 'MCP_UNITY_SETTINGS_PATH');
        if (settings) {
            return { path: resolvedExplicitPath, settings };
        }
    }
    const searchRoots = [path.dirname(modulePath), cwd];
    for (const root of searchRoots) {
        const candidatePath = await findSettingsPathFromAncestor(root, attemptedPaths);
        if (!candidatePath) {
            continue;
        }
        attemptedPaths.add(candidatePath);
        const settings = await readSettingsFile(candidatePath, logger, 'project discovery');
        if (settings) {
            return { path: candidatePath, settings };
        }
    }
    const searchLocations = Array.from(new Set(searchRoots)).join(', ');
    logger.warn(`McpUnitySettings.json was not found or could not be read. Searched from: ${searchLocations}. ` +
        'Using environment overrides and/or default connection settings.');
    return undefined;
}
async function findSettingsPathFromAncestor(startDirectory, excludedPaths) {
    let directory = path.resolve(startDirectory);
    while (true) {
        const candidatePath = path.join(directory, SETTINGS_RELATIVE_PATH);
        if (!excludedPaths.has(candidatePath) && await pathExists(candidatePath)) {
            return candidatePath;
        }
        const parent = path.dirname(directory);
        if (parent === directory) {
            return undefined;
        }
        directory = parent;
    }
}
async function pathExists(candidatePath) {
    try {
        await fs.access(candidatePath);
        return true;
    }
    catch {
        return false;
    }
}
async function readSettingsFile(settingsPath, logger, source) {
    try {
        const content = await fs.readFile(settingsPath, 'utf-8');
        const parsed = JSON.parse(content);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            logger.warn(`Could not use McpUnitySettings.json from ${source} at ${settingsPath}: the root JSON value must be an object.`);
            return undefined;
        }
        return parsed;
    }
    catch (error) {
        logger.warn(`Could not read McpUnitySettings.json from ${source} at ${settingsPath}: ` +
            `${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}
function resolveIntegerSetting(options) {
    const environmentValue = options.environment[options.environmentName];
    const parsedEnvironmentValue = parseInteger(environmentValue);
    if (environmentValue !== undefined) {
        if (parsedEnvironmentValue !== undefined && options.isValid(parsedEnvironmentValue)) {
            return { value: parsedEnvironmentValue, source: options.environmentName };
        }
        options.logger.warn(`${options.environmentName} must be ${options.invalidDescription}; ignoring '${environmentValue}'.`);
    }
    const parsedConfigurationValue = parseInteger(options.configurationValue);
    if (options.configurationValue !== undefined) {
        if (parsedConfigurationValue !== undefined && options.isValid(parsedConfigurationValue)) {
            return { value: parsedConfigurationValue, source: options.configurationSource };
        }
        options.logger.warn(`${options.configurationName} in ${options.configurationSource} must be ${options.invalidDescription}; ` +
            `ignoring '${String(options.configurationValue)}'.`);
    }
    return { value: options.defaultValue, source: 'default' };
}
function resolveStringSetting(options) {
    const environmentValue = normalizeString(options.environment[options.environmentName]);
    if (options.environment[options.environmentName] !== undefined) {
        if (environmentValue) {
            return { value: environmentValue, source: options.environmentName };
        }
        options.logger.warn(`${options.environmentName} must be a non-empty string; ignoring it.`);
    }
    const configurationValue = normalizeString(options.configurationValue);
    if (options.configurationValue !== undefined) {
        if (configurationValue) {
            return { value: configurationValue, source: options.configurationSource };
        }
        options.logger.warn(`${options.configurationName} in ${options.configurationSource} must be a non-empty string; ignoring it.`);
    }
    return { value: options.defaultValue, source: 'default' };
}
function parseInteger(value) {
    if (typeof value === 'number') {
        return Number.isSafeInteger(value) ? value : undefined;
    }
    if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
        return undefined;
    }
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}
function normalizeString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
