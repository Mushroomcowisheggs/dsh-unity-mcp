import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { McpUnityError, ErrorType } from '../utils/errors.js';
/**
 * Connection states for the Unity WebSocket connection
 */
export var ConnectionState;
(function (ConnectionState) {
    ConnectionState["Disconnected"] = "disconnected";
    ConnectionState["Connecting"] = "connecting";
    ConnectionState["Connected"] = "connected";
    ConnectionState["Reconnecting"] = "reconnecting";
})(ConnectionState || (ConnectionState = {}));
/**
 * Custom WebSocket close codes for Unity-specific events
 * Range 4000-4999 is reserved for application use
 */
export const UnityCloseCode = {
    /** Unity is entering Play mode - use fast polling instead of backoff */
    PLAY_MODE: 4001
};
/**
 * Default configuration values
 */
const DEFAULT_CONFIG = {
    connectTimeout: 5000,
    minReconnectDelay: 1000,
    maxReconnectDelay: 30000,
    reconnectBackoffMultiplier: 2,
    maxReconnectAttempts: 50, // Prevent unbounded file descriptor accumulation (see #110)
    heartbeatInterval: 30000,
    heartbeatTimeout: 5000,
    playModePollingInterval: 3000 // Fixed 3 second polling during Play mode
};
/** Per-candidate connect timeout while identifying the live project. */
const SWEEP_CONNECT_TIMEOUT = 2000;
/** Errors that mean "nothing is listening / unreachable" at this endpoint. */
const CONNECT_ERROR_CODES = new Set([
    'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET'
]);
/**
 * Extract the errno-style code from whatever ws hands to the `onerror` property.
 * ws passes an ErrorEvent there (code lives on `event.error`), while the
 * EventEmitter form `ws.on('error', ...)` passes the raw Error itself.
 */
function connectErrorCode(error) {
    const candidate = error?.code ?? error?.error?.code;
    return typeof candidate === 'string' ? candidate : null;
}
/**
 * UnityConnection manages the WebSocket connection to Unity Editor
 * with automatic reconnection, exponential backoff, and heartbeat monitoring.
 *
 * Events:
 * - 'stateChange': Emitted when connection state changes
 * - 'message': Emitted when a message is received from Unity
 * - 'error': Emitted when an error occurs
 */
export class UnityConnection extends EventEmitter {
    logger;
    config;
    ws = null;
    state = ConnectionState.Disconnected;
    // Reconnection state
    reconnectAttempt = 0;
    reconnectTimer = null;
    connectionTimeoutTimer = null;
    isManualDisconnect = false;
    isPlayModeReconnect = false; // True when reconnecting due to Unity Play mode
    // Candidate targets (one bridge serves one project): the connection walks
    // them until one accepts the handshake, which identifies the live project.
    candidateIndex = 0;
    pinnedCandidate = null;
    sweepExhausted = false;
    lastConnectErrorCode = null;
    suppressCloseHandling = false;
    inCloseHandler = false;
    /** Set while a connect() call is still being satisfied (possibly by a later candidate). */
    connectDeferred = null;
    // Heartbeat state
    heartbeatTimer = null;
    heartbeatTimeoutTimer = null;
    lastPongTime = 0;
    awaitingPong = false;
    constructor(logger, config) {
        super();
        this.logger = logger;
        this.config = {
            ...DEFAULT_CONFIG,
            ...config
        };
    }
    /**
     * Get the current connection state
     */
    get connectionState() {
        return this.state;
    }
    /**
     * Check if currently connected
     */
    get isConnected() {
        return this.state === ConnectionState.Connected &&
            this.ws !== null &&
            this.ws.readyState === WebSocket.OPEN;
    }
    /**
     * Check if currently connecting or reconnecting
     */
    get isConnecting() {
        return this.state === ConnectionState.Connecting ||
            this.state === ConnectionState.Reconnecting;
    }
    /**
     * Get time since last successful heartbeat response (pong)
     */
    get timeSinceLastPong() {
        if (this.lastPongTime === 0)
            return -1;
        return Date.now() - this.lastPongTime;
    }
    /**
     * Update configuration dynamically
     */
    updateConfig(config) {
        this.config = { ...this.config, ...config };
    }
    /**
     * Connect to Unity WebSocket server
     *
     * While the candidate sweep is running, one connect() call covers the whole
     * sweep: it settles when a candidate project accepts the handshake, or when
     * every candidate has failed. Intermediate candidates do not surface as
     * failures to the caller.
     */
    async connect() {
        if (this.isConnected) {
            this.logger.debug('Already connected to Unity');
            return;
        }
        if (this.connectDeferred) {
            this.logger.debug('Connection already in progress');
            return this.connectDeferred.promise;
        }
        this.isManualDisconnect = false;
        const deferred = this.createConnectDeferred();
        // The attempt settles the deferred from its own event handlers, because
        // one attempt may hand over to the next candidate without settling.
        this.doConnect().catch((error) => {
            this.logger.debug(`Connection attempt ended: ${error?.message}`);
        });
        return deferred.promise;
    }
    /** Deferred shared by every candidate attempt of one connect() call. */
    createConnectDeferred() {
        const deferred = { settled: false };
        deferred.promise = new Promise((resolve, reject) => {
            deferred.resolve = resolve;
            deferred.reject = reject;
        });
        // Attach a no-op handler so a rejection nobody awaits cannot crash the process.
        deferred.promise.catch(() => { });
        deferred.resolveOnce = () => {
            if (deferred.settled) {
                return;
            }
            deferred.settled = true;
            if (this.connectDeferred === deferred) {
                this.connectDeferred = null;
            }
            deferred.resolve();
        };
        deferred.rejectOnce = (error) => {
            if (deferred.settled) {
                return;
            }
            deferred.settled = true;
            if (this.connectDeferred === deferred) {
                this.connectDeferred = null;
            }
            deferred.reject(error);
        };
        this.connectDeferred = deferred;
        return deferred;
    }
    /**
     * Disconnect from Unity WebSocket server
     */
    disconnect(reason) {
        this.isManualDisconnect = true;
        this.stopReconnectTimer();
        this.stopHeartbeat();
        this.closeWebSocket(reason || 'Manual disconnect');
        if (this.connectDeferred) {
            this.connectDeferred.rejectOnce(new McpUnityError(ErrorType.CONNECTION, reason || 'Manual disconnect'));
        }
        this.setState(ConnectionState.Disconnected, reason || 'Manual disconnect');
    }
    /**
     * Send a message to Unity
     */
    send(message) {
        if (!this.isConnected || !this.ws) {
            throw new McpUnityError(ErrorType.CONNECTION, 'Not connected to Unity');
        }
        try {
            this.ws.send(message);
        }
        catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            throw new McpUnityError(ErrorType.CONNECTION, `Send failed: ${errorMessage}`);
        }
    }
    /**
     * Get WebSocket instance (for advanced use)
     */
    get webSocket() {
        return this.ws;
    }
    /**
     * Internal: Perform the actual connection
     */
    async doConnect() {
        const isReconnecting = this.reconnectAttempt > 0;
        this.setState(isReconnecting ? ConnectionState.Reconnecting : ConnectionState.Connecting, isReconnecting ? `Reconnection attempt ${this.reconnectAttempt}` : 'Connecting');
        // Each attempt starts with a clean slate: the previous socket's close was
        // either handled by its own attempt or superseded by a candidate retry.
        this.suppressCloseHandling = false;
        return new Promise((resolve, reject) => {
            let terminalAuthenticationFailure = null;
            const target = this.currentTarget();
            const wsUrl = `ws://${target.host}:${target.port}/McpUnity`;
            this.logger.debug(`Connecting to ${wsUrl}...`);
            // Create connection options with headers for client identification
            const headers = {
                'X-Client-Name': this.config.clientName || ''
            };
            // Unity bridges with authentication expect HTTP Basic credentials:
            // username "mcp-unity" and the per-project token. Never log the header.
            if (target.authToken) {
                headers['Authorization'] =
                    `Basic ${Buffer.from(`mcp-unity:${target.authToken}`, 'utf8').toString('base64')}`;
            }
            const options = { headers };
            // Clean up existing socket first
            this.closeWebSocket('Preparing new connection');
            // Create new WebSocket
            this.ws = new WebSocket(wsUrl, options);
            // Connection timeout (shortened while the candidate sweep is running,
            // so a machine with several known projects still fails fast).
            this.clearConnectionTimeout();
            const connectTimeout = this.isSweeping()
                ? Math.min(this.config.connectTimeout, SWEEP_CONNECT_TIMEOUT)
                : this.config.connectTimeout;
            this.connectionTimeoutTimer = setTimeout(() => {
                if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
                    this.logger.warn('Connection timeout');
                    this.closeWebSocket('Connection timeout');
                    // A hanging endpoint is as useless as a refused one: let the
                    // sweep move on to the next candidate project.
                    this.lastConnectErrorCode = 'ETIMEDOUT';
                    const error = new McpUnityError(ErrorType.CONNECTION, 'Connection timeout');
                    this.handleConnectionFailure(error);
                    reject(error);
                }
            }, connectTimeout);
            this.ws.onopen = () => {
                this.clearConnectionTimeout();
                this.lastConnectErrorCode = null;
                // This candidate answered, so it is the live project: pin it and
                // stop walking candidates on later reconnects.
                this.pinnedCandidate = target;
                this.candidateIndex = 0;
                this.sweepExhausted = false;
                this.logger.info(`WebSocket connected to Unity${target.source ? ` (project: ${target.source})` : ''}`);
                // Reset reconnection state on successful connection
                this.reconnectAttempt = 0;
                this.isPlayModeReconnect = false; // Clear Play mode flag
                this.lastPongTime = Date.now();
                this.setState(ConnectionState.Connected, 'Connection established');
                this.startHeartbeat();
                if (this.connectDeferred) {
                    this.connectDeferred.resolveOnce();
                }
                resolve();
            };
            this.ws.onerror = (err) => {
                if (terminalAuthenticationFailure) {
                    return;
                }
                this.lastConnectErrorCode = connectErrorCode(err);
                this.clearConnectionTimeout();
                const errorMessage = err.message || 'Unknown error';
                this.logger.error(`WebSocket error: ${errorMessage}`);
                const error = new McpUnityError(ErrorType.CONNECTION, `Connection failed: ${errorMessage}`);
                this.emit('error', error);
                // Don't reject here - let onclose handle cleanup and reconnection
            };
            this.ws.onmessage = (event) => {
                this.emit('message', event.data.toString());
            };
            this.ws.onclose = (event) => {
                this.clearConnectionTimeout();
                this.stopHeartbeat();
                const reason = event.reason || `Code: ${event.code}`;
                this.logger.debug(`WebSocket closed: ${reason}`);
                // Check if Unity is entering Play mode (custom close code 4001)
                if (event.code === UnityCloseCode.PLAY_MODE) {
                    this.logger.info('Unity entering Play mode - using fast polling for reconnection');
                    this.isPlayModeReconnect = true;
                }
                // Clear WebSocket reference
                this.ws = null;
                // This close was already handled by whoever scheduled the retry.
                if (this.suppressCloseHandling) {
                    this.suppressCloseHandling = false;
                    return;
                }
                // An authentication rejection is terminal: the token will not
                // become valid by retrying, so never start a reconnect storm.
                if (terminalAuthenticationFailure) {
                    return;
                }
                // Handle reconnection if not manual disconnect
                if (!this.isManualDisconnect) {
                    this.inCloseHandler = true;
                    try {
                        this.handleConnectionFailure(new McpUnityError(ErrorType.CONNECTION, reason));
                    }
                    finally {
                        this.inCloseHandler = false;
                    }
                }
                else {
                    this.setState(ConnectionState.Disconnected, reason);
                    if (this.connectDeferred && !this.connectDeferred.settled) {
                        this.connectDeferred.rejectOnce(new McpUnityError(ErrorType.CONNECTION, reason));
                    }
                }
                // Nothing left to try: settle the caller's connect() promise.
                if (this.connectDeferred && !this.connectDeferred.settled && !this.isSweeping()) {
                    this.connectDeferred.rejectOnce(new McpUnityError(ErrorType.CONNECTION, reason));
                }
            };
            // Handle WebSocket ping/pong for heartbeat
            this.ws.on('pong', () => {
                this.handlePong();
            });
            // A rejected Basic handshake answers 401/403 instead of upgrading.
            // With several known projects the next candidate token is tried
            // right away; only when candidates are exhausted is this terminal.
            this.ws.on('unexpected-response', (_request, response) => {
                if (response.statusCode !== 401 && response.statusCode !== 403) {
                    return;
                }
                this.clearConnectionTimeout();
                this.stopHeartbeat();
                this.ws?.terminate();
                // The project that answered before may have been closed in favour
                // of another one, so a rejection also unpins the identified target.
                if (this.pinnedCandidate) {
                    this.restartCandidateSweep(target);
                }
                if (this.tryNextCandidate(`HTTP ${response.statusCode} from ${target.source || 'the bridge'}`)) {
                    reject(new McpUnityError(ErrorType.CONNECTION, 'Authentication rejected; trying the next candidate project'));
                    return;
                }
                const error = new McpUnityError(ErrorType.AUTHENTICATION, `Unity rejected the bridge authentication (HTTP ${response.statusCode}). ` +
                    `No candidate project token was accepted${this.describeTriedCandidates()}. ` +
                    'Check the project token (Tools > MCP Unity > Server Window) and set unityProjectPath, ' +
                    'MCP_UNITY_PROJECT_PATHS or MCP_UNITY_AUTH_TOKEN_PATH, then restart the MCP client.');
                terminalAuthenticationFailure = error;
                this.handleConnectionFailure(error);
                reject(error);
            });
        });
    }
    /**
     * The connection target to use right now: the pinned (identified) project if
     * the connection already succeeded once, otherwise the candidate being tried.
     */
    currentTarget() {
        if (this.pinnedCandidate) {
            return this.pinnedCandidate;
        }
        const candidates = this.config.candidates ?? [];
        return candidates[this.candidateIndex] ?? {
            host: this.config.host,
            port: this.config.port,
            authToken: this.config.authToken,
            source: undefined
        };
    }
    /** True while walking candidates for the first time (no project identified yet). */
    isSweeping() {
        return !this.pinnedCandidate && !this.sweepExhausted && (this.config.candidates?.length ?? 0) > 1;
    }
    /** Candidate sources tried so far, for diagnostics (never includes tokens). */
    describeTriedCandidates() {
        const candidates = this.config.candidates ?? [];
        const attempted = this.sweepExhausted ? candidates : candidates.slice(0, this.candidateIndex + 1);
        const tried = attempted
            .map(candidate => candidate.source)
            .filter(Boolean);
        return tried.length > 0 ? ` (tried: ${tried.join(', ')})` : '';
    }
    /** Forget the identified project so the next attempt walks all candidates again. */
    restartCandidateSweep(failedTarget) {
        const candidates = this.config.candidates ?? [];
        const index = candidates.indexOf(failedTarget);
        this.pinnedCandidate = null;
        this.sweepExhausted = false;
        this.candidateIndex = index >= 0 ? index : 0;
    }
    /**
     * Move to the next candidate target and reconnect immediately.
     * Returns false when there is nothing left to try, in which case the caller
     * falls back to the normal (terminal or backoff) failure handling.
     */
    tryNextCandidate(reason) {
        if (this.pinnedCandidate || this.sweepExhausted) {
            return false;
        }
        const candidates = this.config.candidates ?? [];
        if (candidates.length <= 1) {
            return false;
        }
        while (this.candidateIndex + 1 < candidates.length) {
            this.candidateIndex++;
            const next = candidates[this.candidateIndex];
            const current = this.config.candidates[this.candidateIndex - 1];
            // A refused/unreachable endpoint means nothing is listening there, so
            // retrying a different token against the same dead host:port is
            // pointless unless the endpoint actually differs.
            if (this.lastConnectErrorCode && current && next.host === current.host && next.port === current.port) {
                continue;
            }
            this.logger.info(`Trying candidate project ${this.candidateIndex + 1}/${candidates.length}` +
                `${next.source ? `: ${next.source}` : ''} (${reason})`);
            this.stopReconnectTimer();
            this.setState(ConnectionState.Reconnecting, `Trying candidate ${this.candidateIndex + 1}/${candidates.length}${next.source ? ` (${next.source})` : ''}`);
            // The socket that just failed is already accounted for; its close event
            // must not start a second (backoff) reconnect behind this retry.
            if (!this.inCloseHandler) {
                this.suppressCloseHandling = true;
            }
            this.reconnectTimer = setTimeout(() => {
                this.reconnectTimer = null;
                this.doConnect().catch((err) => {
                    this.logger.warn(`Candidate connection failed: ${err.message}`);
                });
            }, 0);
            return true;
        }
        this.sweepExhausted = true;
        this.candidateIndex = 0;
        this.lastConnectErrorCode = null;
        this.logger.warn('No candidate Unity project accepted the connection');
        return false;
    }
    /**
     * Handle connection failure and schedule reconnection
     */
    handleConnectionFailure(error) {
        this.logger.debug(`Connection failure: ${error.message} (last error code: ${this.lastConnectErrorCode ?? 'none'}, ` +
            `candidates: ${this.config.candidates?.length ?? 0}, index: ${this.candidateIndex}, pinned: ${this.pinnedCandidate ? 'yes' : 'no'})`);
        // Authentication failures are terminal: retrying with the same
        // credentials cannot succeed, so stop reconnecting and let the caller
        // surface the real cause instead of a reconnect/timeout symptom.
        if (error.type === ErrorType.AUTHENTICATION) {
            this.isManualDisconnect = true;
            this.stopReconnectTimer();
            this.setState(ConnectionState.Disconnected, error.message);
            this.emit('error', error);
            if (this.connectDeferred && !this.connectDeferred.settled) {
                this.connectDeferred.rejectOnce(error);
            }
            return;
        }
        if (this.isManualDisconnect) {
            this.setState(ConnectionState.Disconnected, 'Manual disconnect');
            return;
        }
        // A dead candidate endpoint (nothing listening / unreachable) may simply
        // mean the live project is another candidate: walk on once.
        if (CONNECT_ERROR_CODES.has(this.lastConnectErrorCode) &&
            this.tryNextCandidate(`connection failed (${this.lastConnectErrorCode})`)) {
            return;
        }
        // Check max reconnect attempts (skip for Play mode - unlimited retries)
        if (!this.isPlayModeReconnect &&
            this.config.maxReconnectAttempts !== -1 &&
            this.reconnectAttempt >= this.config.maxReconnectAttempts) {
            this.logger.error(`Max reconnection attempts (${this.config.maxReconnectAttempts}) reached`);
            this.setState(ConnectionState.Disconnected, 'Max reconnection attempts reached');
            const maxAttemptsError = new McpUnityError(ErrorType.CONNECTION, 'Max reconnection attempts reached');
            this.emit('error', maxAttemptsError);
            if (this.connectDeferred && !this.connectDeferred.settled) {
                this.connectDeferred.rejectOnce(maxAttemptsError);
            }
            return;
        }
        // Use fixed polling interval for Play mode, exponential backoff otherwise
        const delay = this.isPlayModeReconnect
            ? this.config.playModePollingInterval
            : this.calculateBackoffDelay();
        this.reconnectAttempt++;
        const modeInfo = this.isPlayModeReconnect ? ' (Play mode polling)' : '';
        this.logger.info(`Scheduling reconnection attempt ${this.reconnectAttempt} in ${delay}ms${modeInfo}`);
        this.setState(ConnectionState.Reconnecting, `Waiting ${delay}ms before attempt ${this.reconnectAttempt}${modeInfo}`);
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.doConnect().catch((err) => {
                this.logger.warn(`Reconnection attempt ${this.reconnectAttempt} failed: ${err.message}`);
            });
        }, delay);
        // No candidate retry is pending, so the caller's connect() must fail now
        // rather than hang until some later reconnection succeeds.
        if (this.connectDeferred && !this.connectDeferred.settled) {
            this.connectDeferred.rejectOnce(error);
        }
    }
    /**
     * Calculate exponential backoff delay
     */
    calculateBackoffDelay() {
        const baseDelay = this.config.minReconnectDelay;
        const multiplier = this.config.reconnectBackoffMultiplier;
        const maxDelay = this.config.maxReconnectDelay;
        // Exponential backoff: base * multiplier^attempt
        const delay = baseDelay * Math.pow(multiplier, this.reconnectAttempt);
        // Add jitter (0-20% random variation) to prevent thundering herd
        const jitter = delay * 0.2 * Math.random();
        return Math.min(delay + jitter, maxDelay);
    }
    /**
     * Stop reconnection timer
     */
    stopReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnectAttempt = 0;
    }
    /**
     * Start heartbeat monitoring
     */
    startHeartbeat() {
        this.stopHeartbeat();
        if (this.config.heartbeatInterval <= 0) {
            this.logger.debug('Heartbeat disabled');
            return;
        }
        this.logger.debug(`Starting heartbeat with ${this.config.heartbeatInterval}ms interval`);
        this.heartbeatTimer = setInterval(() => {
            this.sendHeartbeat();
        }, this.config.heartbeatInterval);
    }
    /**
     * Stop heartbeat monitoring
     */
    stopHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        if (this.heartbeatTimeoutTimer) {
            clearTimeout(this.heartbeatTimeoutTimer);
            this.heartbeatTimeoutTimer = null;
        }
        this.awaitingPong = false;
    }
    /**
     * Send heartbeat ping
     */
    sendHeartbeat() {
        if (!this.isConnected || !this.ws) {
            return;
        }
        // If we're still waiting for a pong from the last ping, connection may be stale
        if (this.awaitingPong) {
            this.logger.warn('No pong received for previous ping, connection may be stale');
            this.handleStaleConnection();
            return;
        }
        try {
            this.awaitingPong = true;
            this.ws.ping();
            this.logger.debug('Heartbeat ping sent');
            // Set timeout for pong response
            this.heartbeatTimeoutTimer = setTimeout(() => {
                if (this.awaitingPong) {
                    this.logger.warn('Heartbeat timeout - no pong received');
                    this.handleStaleConnection();
                }
            }, this.config.heartbeatTimeout);
        }
        catch (err) {
            this.logger.error(`Failed to send heartbeat: ${err instanceof Error ? err.message : String(err)}`);
            this.awaitingPong = false;
        }
    }
    /**
     * Handle pong response
     */
    handlePong() {
        this.awaitingPong = false;
        this.lastPongTime = Date.now();
        if (this.heartbeatTimeoutTimer) {
            clearTimeout(this.heartbeatTimeoutTimer);
            this.heartbeatTimeoutTimer = null;
        }
        this.logger.debug('Heartbeat pong received');
    }
    /**
     * Handle stale connection detected by heartbeat
     */
    handleStaleConnection() {
        this.logger.warn('Stale connection detected, forcing reconnection');
        this.awaitingPong = false;
        // Force close and trigger reconnection
        this.closeWebSocket('Stale connection detected');
        this.handleConnectionFailure(new McpUnityError(ErrorType.CONNECTION, 'Stale connection detected'));
    }
    /**
     * Close WebSocket immediately
     *
     * Always uses terminate() instead of close() to prevent file descriptor
     * accumulation. A graceful close (ws.close()) leaves the socket alive
     * during the TCP close handshake, which can overlap with the next
     * connection attempt and accumulate file descriptors on the Unity side.
     * websocket-sharp uses Mono's IOSelector/select(), which crashes when
     * file descriptor values exceed ~1024 (POSIX FD_SETSIZE limit).
     * See: https://github.com/CoderGamester/mcp-unity/issues/110
     */
    closeWebSocket(reason) {
        if (!this.ws)
            return;
        this.logger.debug(`Closing WebSocket: ${reason || 'No reason'}`);
        this.clearConnectionTimeout();
        // Capture reference and null the field first to prevent any
        // event handler from seeing a stale socket during teardown
        const socket = this.ws;
        this.ws = null;
        // Remove all event handlers before terminating
        socket.onopen = null;
        socket.onmessage = null;
        socket.onclose = null;
        socket.removeAllListeners('pong');
        // Keep a no-op 'error' listener attached across terminate().
        //
        // ws@8 terminate() on a socket still in CONNECTING state calls abortHandshake(),
        // which builds the Error synchronously but emits it on process.nextTick - i.e.
        // OUTSIDE the try/catch below. With no 'error' listener the EventEmitter rethrows,
        // index.ts's uncaughtException handler does not match EPIPE/EOF/ERR_USE_AFTER_CLOSE
        // (the error has no .code at all), and the process exits 1 - killing the server on
        // the very first connect timeout, before any reconnect attempt can run.
        socket.onerror = () => { };
        try {
            // Always terminate immediately — no graceful close handshake.
            // This ensures the underlying socket FD is released right away.
            socket.terminate();
        }
        catch (err) {
            this.logger.error(`Error closing WebSocket: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    clearConnectionTimeout() {
        if (this.connectionTimeoutTimer) {
            clearTimeout(this.connectionTimeoutTimer);
            this.connectionTimeoutTimer = null;
        }
    }
    /**
     * Set connection state and emit event
     */
    setState(newState, reason) {
        if (this.state === newState)
            return;
        const previousState = this.state;
        this.state = newState;
        const change = {
            previousState,
            currentState: newState,
            reason,
            attemptNumber: this.reconnectAttempt > 0 ? this.reconnectAttempt : undefined
        };
        this.logger.debug(`Connection state: ${previousState} -> ${newState} (${reason || 'no reason'})`);
        this.emit('stateChange', change);
    }
    /**
     * Force a reconnection (useful after Unity domain reload)
     */
    forceReconnect() {
        this.logger.info('Forcing reconnection...');
        this.isManualDisconnect = false;
        this.stopReconnectTimer();
        this.closeWebSocket('Force reconnect');
        this.reconnectAttempt = 0; // Reset attempts for fresh reconnect
        // Unity may have reloaded with a different project open, so re-identify.
        this.pinnedCandidate = null;
        this.candidateIndex = 0;
        this.sweepExhausted = false;
        this.lastConnectErrorCode = null;
        if (this.connectDeferred) {
            this.connectDeferred.rejectOnce(new McpUnityError(ErrorType.CONNECTION, 'Forced reconnection'));
        }
        this.doConnect().catch((err) => {
            this.logger.warn(`Force reconnect failed: ${err.message}`);
        });
    }
    /**
     * Get connection statistics
     */
    getStats() {
        return {
            state: this.state,
            reconnectAttempt: this.reconnectAttempt,
            timeSinceLastPong: this.timeSinceLastPong,
            isAwaitingPong: this.awaitingPong,
            identifiedProject: this.pinnedCandidate?.source
        };
    }
}
