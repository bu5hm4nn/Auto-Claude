/**
 * MCP Server Health Check Handlers
 *
 * Handles IPC requests for checking MCP server health and connectivity.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/ipc';
import type {
  CustomMcpServer,
  McpHealthCheckResult,
  McpHealthStatus,
  McpSession,
  McpSessionState,
  McpSessionStatus,
  McpTestConnectionResult,
} from '../../shared/types/project';
import { spawn, execFile } from 'child_process';
import path from 'path';
import { existsSync } from 'fs';
import { app } from 'electron';
import { appLog } from '../app-logger';
import { isWindows } from '../platform';
import { parsePythonCommand } from '../python-detector';
import { getConfiguredPythonPath, pythonEnvManager } from '../python-env-manager';

/**
 * Defense-in-depth: Frontend-side command validation
 * Mirrors the backend SAFE_COMMANDS allowlist to prevent arbitrary command execution
 * even if malicious configs somehow bypass backend validation
 */
const SAFE_COMMANDS = new Set(['npx', 'npm', 'node', 'python', 'python3', 'uv', 'uvx']);

/**
 * Defense-in-depth: Dangerous interpreter flags that allow code execution
 * Mirrors backend DANGEROUS_FLAGS to prevent args-based code injection
 */
const DANGEROUS_FLAGS = new Set([
  '--eval', '-e', '-c', '--exec',
  '-m', '-p', '--print',
  '--input-type=module', '--experimental-loader',
  '--require', '-r'
]);

/**
 * Defense-in-depth: Shell metacharacters that could enable command injection
 * when shell: true is used on Windows
 */
const SHELL_METACHARACTERS = ['&', '|', '>', '<', '^', '%', ';', '$', '`', '\n', '\r'];

/**
 * Validate that a command is in the safe allowlist
 */
export function isCommandSafe(command: string | undefined): boolean {
  if (!command) return false;
  // Reject commands with paths (defense against path traversal)
  if (command.includes('/') || command.includes('\\')) return false;
  return SAFE_COMMANDS.has(command);
}

/**
 * Validate that args don't contain dangerous interpreter flags or shell metacharacters
 */
export function areArgsSafe(args: string[] | undefined): boolean {
  if (!args || args.length === 0) return true;

  // Check for dangerous interpreter flags
  if (args.some(arg => DANGEROUS_FLAGS.has(arg))) return false;

  // On Windows with shell: true, check for shell metacharacters that could enable injection
  if (isWindows()) {
    if (args.some(arg => SHELL_METACHARACTERS.some(char => arg.includes(char)))) {
      return false;
    }
  }

  return true;
}

/**
 * Map raw network error messages to user-friendly messages.
 * This prevents exposing internal error details to users.
 */
export function mapNetworkErrorToMessage(errorMessage: string): string {
  if (errorMessage.includes('abort') || errorMessage.includes('timeout')) {
    return 'Connection timed out';
  } else if (errorMessage.includes('ECONNREFUSED')) {
    return 'Connection refused - server may be down';
  } else if (errorMessage.includes('ENOTFOUND')) {
    return 'Server not found - check URL';
  }
  return 'Connection failed';
}

// ============================================================================
// Backend Session Communication Helpers
// ============================================================================

/**
 * Module-level cache for backend source path.
 * undefined = not yet computed, null = computed but not found, string = found path
 */
let cachedBackendPath: string | null | undefined;

/**
 * Get the path to the backend source directory.
 * Handles both development and packaged app scenarios.
 * Result is cached to avoid repeated filesystem lookups.
 *
 * @returns Path to backend source, or null if not found
 */
function getBackendSourcePath(): string | null {
  if (cachedBackendPath !== undefined) {
    return cachedBackendPath;
  }

  // Validate path - check if mcp_session_ipc.py exists
  const validatePath = (p: string): boolean => {
    return existsSync(p) && existsSync(path.join(p, 'services', 'mcp_session_ipc.py'));
  };

  const possiblePaths = [
    // Packaged app: backend is in extraResources (process.resourcesPath/backend)
    ...(app.isPackaged ? [path.join(process.resourcesPath, 'backend')] : []),
    // Dev mode: from dist/main -> ../../backend (apps/frontend/out/main -> apps/backend)
    path.resolve(__dirname, '..', '..', '..', 'backend'),
    // Alternative: from app root -> apps/backend
    path.resolve(app.getAppPath(), '..', 'backend'),
    // If running from repo root with apps structure
    path.resolve(process.cwd(), 'apps', 'backend'),
  ];

  for (const p of possiblePaths) {
    if (validatePath(p)) {
      cachedBackendPath = p;
      return cachedBackendPath;
    }
  }

  cachedBackendPath = null;
  return cachedBackendPath;
}

/**
 * Execute a backend MCP session IPC command via subprocess.
 * Communicates with the backend MCPSessionManager, which is the single source of truth
 * for session state.
 *
 * @param message - The IPC message to send (type + data fields)
 * @returns Promise resolving to the backend response
 */
async function executeBackendSessionIpc<T>(
  message: Record<string, unknown>
): Promise<{ success: boolean; data?: T; error?: string }> {
  const backendPath = getBackendSourcePath();
  if (!backendPath) {
    appLog.error('[MCP Session IPC] Backend source path not found');
    return {
      success: false,
      error: 'Backend source path not found',
    };
  }

  const pythonPath = getConfiguredPythonPath();
  const [pythonCommand, pythonBaseArgs] = parsePythonCommand(pythonPath);
  const moduleArgs = ['-m', 'services.mcp_session_ipc', JSON.stringify(message)];

  return new Promise((resolve) => {
    // Use async execFile to avoid blocking the Electron main process
    execFile(
      pythonCommand,
      [...pythonBaseArgs, ...moduleArgs],
      {
        cwd: backendPath,
        env: {
          ...pythonEnvManager.getPythonEnv(),
          PYTHONPATH: [
            backendPath,
            pythonEnvManager.getPythonEnv().PYTHONPATH,
            process.env.PYTHONPATH,
          ]
            .filter(Boolean)
            .join(path.delimiter),
        },
        timeout: 10000, // 10 second timeout
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024, // 1MB buffer
        windowsHide: true,
      },
      (execError, stdout, stderr) => {
        if (execError) {
          const errorMessage = execError.message || String(execError);
          appLog.error('[MCP Session IPC] Execution failed:', errorMessage);
          if (stderr) {
            appLog.debug('[MCP Session IPC] stderr:', stderr);
          }
          resolve({
            success: false,
            error: errorMessage,
          });
          return;
        }

        try {
          const response = JSON.parse(stdout.trim());
          resolve({
            success: response.success ?? false,
            data: response,
            error: response.error || response.message,
          });
        } catch {
          appLog.error('[MCP Session IPC] Failed to parse response:', stdout);
          resolve({
            success: false,
            error: 'Failed to parse backend response',
          });
        }
      }
    );
  });
}

/**
 * Raw backend session format with snake_case keys.
 * This is what the Python backend actually returns.
 */
interface BackendSession {
  server_url: string;
  session_id: string | null;
  state: string;
  established_at: string | null;
  last_activity_at: string | null;
  request_count: number;
  reinitialize_count: number;
  last_error?: string;
}

/**
 * Backend response for session set operation.
 */
interface BackendSessionSetResponse {
  success: boolean;
  message: string;
  session: BackendSession | null;
}

/**
 * Backend response for session get operation.
 */
interface BackendSessionGetResponse {
  success: boolean;
  message: string;
  session: BackendSession | null;
}

/**
 * Backend response for get all sessions operation.
 */
interface BackendSessionGetAllResponse {
  success: boolean;
  message: string;
  sessions: BackendSession[];
}

/**
 * Backend response for session terminate operation.
 */
interface BackendSessionTerminateResponse {
  success: boolean;
  message: string;
  result: {
    server_url: string;
    success: boolean;
    message: string;
  } | null;
}

/**
 * Sync session state to the backend MCPSessionManager.
 * Called by frontend when:
 * - A new session ID is captured from Mcp-Session-Id response header
 * - Session state changes (initializing, active, error, reconnecting, etc.)
 *
 * @param serverUrl - The URL of the MCP server
 * @param sessionId - The session ID (can be null)
 * @param state - Session lifecycle state
 * @param error - Optional error message if state is 'error'
 * @returns Promise resolving to the updated session data
 */
export async function syncSessionToBackend(
  serverUrl: string,
  sessionId: string | null,
  state: McpSessionState,
  error?: string
): Promise<{ success: boolean; session?: McpSession; error?: string }> {
  const message: Record<string, unknown> = {
    type: 'mcp:session:set',
    server_url: serverUrl,
    state,
  };

  if (sessionId !== null) {
    message.session_id = sessionId;
  }

  if (error) {
    message.error = error;
  }

  const result = await executeBackendSessionIpc<BackendSessionSetResponse>(message);

  if (result.success && result.data?.session) {
    // Convert snake_case keys to camelCase for frontend consumption
    const session = convertBackendSession(result.data.session);
    appLog.debug(`[MCP Session] Synced to backend: ${serverUrl} -> ${state}`);
    return { success: true, session };
  }

  return {
    success: false,
    error: result.error || 'Failed to sync session to backend',
  };
}

/**
 * Get session state from the backend MCPSessionManager.
 *
 * @param serverUrl - The URL of the MCP server
 * @returns Promise resolving to the session data, or undefined if not found
 */
export async function getSessionFromBackend(
  serverUrl: string
): Promise<{ success: boolean; session?: McpSession; error?: string }> {
  const result = await executeBackendSessionIpc<BackendSessionGetResponse>({
    type: 'mcp:session:get',
    server_url: serverUrl,
  });

  if (result.success) {
    const session = result.data?.session ? convertBackendSession(result.data.session) : undefined;
    return { success: true, session };
  }

  return {
    success: false,
    error: result.error || 'Failed to get session from backend',
  };
}

/**
 * Get all sessions from the backend MCPSessionManager.
 *
 * @returns Promise resolving to array of all sessions
 */
export async function getAllSessionsFromBackend(): Promise<{
  success: boolean;
  sessions?: McpSession[];
  error?: string;
}> {
  const result = await executeBackendSessionIpc<BackendSessionGetAllResponse>({
    type: 'mcp:session:getAll',
  });

  if (result.success && result.data?.sessions) {
    const sessions = result.data.sessions.map(convertBackendSession);
    return { success: true, sessions };
  }

  return {
    success: false,
    sessions: [],
    error: result.error || 'Failed to get sessions from backend',
  };
}

/**
 * Initiate session termination in the backend MCPSessionManager.
 * This marks the session as 'terminating' - the actual HTTP DELETE request
 * should be performed by the caller after receiving a successful response.
 *
 * @param serverUrl - The URL of the MCP server
 * @returns Promise resolving to the termination result
 */
export async function terminateSessionInBackend(serverUrl: string): Promise<{
  success: boolean;
  message: string;
  sessionId?: string | null;
}> {
  // First, get the session to retrieve the session ID for HTTP DELETE
  const getResult = await getSessionFromBackend(serverUrl);
  const sessionId = getResult.session?.sessionId ?? null;

  const result = await executeBackendSessionIpc<BackendSessionTerminateResponse>({
    type: 'mcp:session:terminate',
    server_url: serverUrl,
  });

  if (result.success && result.data?.result) {
    return {
      success: result.data.result.success,
      message: result.data.result.message,
      sessionId,
    };
  }

  return {
    success: false,
    message: result.error || 'Failed to terminate session in backend',
    sessionId,
  };
}

/**
 * Mark session termination as complete in the backend.
 * Called after the HTTP DELETE request completes.
 *
 * @param serverUrl - The URL of the MCP server
 * @param success - Whether the HTTP DELETE succeeded
 * @param statusCode - The HTTP status code from the DELETE request
 */
export async function notifyTerminationComplete(
  serverUrl: string,
  success: boolean,
  statusCode?: number
): Promise<void> {
  // Only clear session on success or expected status codes (204 No Content, 404 Not Found)
  // On failure, set to 'error' state so UI can show termination failed
  const shouldClear = success || statusCode === 204 || statusCode === 404;

  if (shouldClear) {
    const cleared = await syncSessionToBackend(serverUrl, null, 'disconnected');
    if (!cleared.success) {
      appLog.error('[MCP Session] Failed to clear session after termination:', cleared.error);
    }
  } else {
    const failed = await syncSessionToBackend(
      serverUrl,
      null,
      'error',
      `Session termination failed${statusCode ? ` (HTTP ${statusCode})` : ''}`
    );
    if (!failed.success) {
      appLog.error('[MCP Session] Failed to sync termination failure:', failed.error);
    }
  }

  appLog.debug(
    `[MCP Session] Termination complete for ${serverUrl} (success: ${success}, status: ${statusCode ?? 'n/a'})`
  );
}

/**
 * Get session status for display in UI.
 * Fetches from backend and converts to status format.
 *
 * @param serverUrl - The URL of the MCP server
 * @param serverName - Optional display name for the server
 * @returns Promise resolving to session status
 */
export async function getSessionStatusFromBackend(
  serverUrl: string,
  serverName?: string
): Promise<McpSessionStatus> {
  const result = await getSessionFromBackend(serverUrl);

  if (!result.success || !result.session) {
    return {
      serverUrl,
      serverName,
      isActive: false,
      state: 'disconnected',
      statusMessage: 'No session',
      requestCount: 0,
    };
  }

  const session = result.session;
  const isActive = session.state === 'active';
  let durationSeconds: number | undefined;

  if (isActive && session.establishedAt) {
    const established = new Date(session.establishedAt).getTime();
    durationSeconds = Math.floor((Date.now() - established) / 1000);
  }

  let statusMessage: string;
  switch (session.state) {
    case 'disconnected':
      statusMessage = 'Disconnected';
      break;
    case 'initializing':
      statusMessage = 'Connecting...';
      break;
    case 'active':
      statusMessage = `Active (${session.requestCount} requests)`;
      break;
    case 'reconnecting':
      // Use Math.max(1, ...) to handle edge case where reinitializeCount is 0
      // during the first reconnect attempt (count may not be incremented yet)
      statusMessage = `Reconnecting (attempt ${Math.max(1, session.reinitializeCount)})`;
      break;
    case 'terminating':
      statusMessage = 'Disconnecting...';
      break;
    case 'error':
      statusMessage = session.lastError || 'Error';
      break;
    default:
      statusMessage = 'Unknown';
  }

  return {
    serverUrl,
    serverName,
    isActive,
    state: session.state,
    statusMessage,
    durationSeconds,
    requestCount: session.requestCount,
  };
}

/**
 * Convert backend session object (snake_case) to frontend format (camelCase).
 * The backend uses Python naming conventions, while frontend uses JavaScript conventions.
 */
function convertBackendSession(backendSession: BackendSession): McpSession {
  return {
    serverUrl: backendSession.server_url || '',
    sessionId: backendSession.session_id ?? null,
    state: (backendSession.state as McpSessionState) || 'disconnected',
    establishedAt: backendSession.established_at ?? null,
    lastActivityAt: backendSession.last_activity_at ?? null,
    requestCount: backendSession.request_count || 0,
    reinitializeCount: backendSession.reinitialize_count || 0,
    lastError: backendSession.last_error,
  };
}

// ============================================================================
// End Backend Session Communication Helpers
// ============================================================================

/**
 * Quick health check for a custom MCP server.
 * For HTTP servers: makes a HEAD/GET request to check connectivity.
 * For Streamable HTTP servers: uses proper Accept header for MCP protocol.
 * For command servers: checks if the command exists.
 */
async function checkMcpHealth(server: CustomMcpServer): Promise<McpHealthCheckResult> {
  const startTime = Date.now();

  if (server.type === 'streamable-http') {
    return checkStreamableHttpHealth(server, startTime);
  } else if (server.type === 'http') {
    return checkHttpHealth(server, startTime);
  } else if (server.type === 'command') {
    return checkCommandHealth(server, startTime);
  } else {
    // Explicit handling for unknown types
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: `Unsupported server type: ${server.type}`,
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check HTTP server health by making a request.
 */
async function checkHttpHealth(server: CustomMcpServer, startTime: number): Promise<McpHealthCheckResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'No URL configured',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Add custom headers if configured
    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    const response = await fetch(server.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    let status: McpHealthStatus;
    let message: string;

    if (response.ok) {
      status = 'healthy';
      message = 'Server is responding';
    } else if (response.status === 401 || response.status === 403) {
      status = 'needs_auth';
      message = response.status === 401 ? 'Authentication required' : 'Access forbidden';
    } else {
      status = 'unhealthy';
      message = `HTTP ${response.status}: ${response.statusText}`;
    }

    return {
      serverId: server.id,
      status,
      statusCode: response.status,
      message,
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      serverId: server.id,
      status: 'unhealthy',
      message: mapNetworkErrorToMessage(errorMessage),
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check Streamable HTTP server health by making a request with proper MCP Accept header.
 * Streamable HTTP servers (MCP spec 2025-03-26) support both JSON and SSE responses.
 * Includes Mcp-Session-Id header when an active session exists for session continuity.
 *
 * Handles session-related errors:
 * - HTTP 400: Missing session - session ID required but not provided
 * - HTTP 404: Expired session - session ID no longer valid
 * In both cases, the stale session is cleared and re-initialization is triggered.
 */
async function checkStreamableHttpHealth(
  server: CustomMcpServer,
  startTime: number,
  isRetry: boolean = false
): Promise<McpHealthCheckResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'No URL configured',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    // Streamable HTTP requires Accept header with both JSON and SSE support
    const headers: Record<string, string> = {
      'Accept': 'application/json, text/event-stream',
    };

    // Inject session ID if an active session exists for this server (fetch from backend)
    const backendSession = await getSessionFromBackend(server.url);
    if (backendSession.session?.sessionId) {
      headers['Mcp-Session-Id'] = backendSession.session.sessionId;
    }

    // Add custom headers if configured
    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    const response = await fetch(server.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    let status: McpHealthStatus;
    let message: string;

    if (response.ok) {
      status = 'healthy';
      message = 'Streamable HTTP server is responding';
    } else if (response.status === 401 || response.status === 403) {
      status = 'needs_auth';
      message = response.status === 401 ? 'Authentication required' : 'Access forbidden';
    } else if ((response.status === 400 || response.status === 404) && !isRetry) {
      // HTTP 400: Missing session - session ID required but not provided
      // HTTP 404: Expired session - session ID no longer valid
      // Clear stale session and attempt re-initialization
      appLog.debug(
        `MCP session error for ${server.id}: HTTP ${response.status} - ${response.status === 400 ? 'missing' : 'expired'} session, re-initializing`
      );

      // Sync reconnecting state to backend (single source of truth)
      await syncSessionToBackend(server.url, null, 'reconnecting');

      // Attempt to re-initialize the session
      const reinitResult = await reinitializeStreamableHttpSession(server, startTime);
      if (reinitResult.success) {
        // Re-initialization succeeded, retry health check with new session
        return checkStreamableHttpHealth(server, startTime, true);
      }

      // Re-initialization failed - sync error state to backend
      syncSessionToBackend(
        server.url,
        null,
        'error',
        `Session ${response.status === 400 ? 'missing' : 'expired'}, re-initialization failed`
      ).catch((err) => {
        appLog.debug(`Failed to sync error state to backend for ${server.id}:`, err);
      });

      return {
        serverId: server.id,
        status: 'unhealthy',
        statusCode: response.status,
        message: `Session ${response.status === 400 ? 'missing' : 'expired'}, re-initialization failed`,
        responseTime: Date.now() - startTime,
        checkedAt: new Date().toISOString(),
      };
    } else {
      status = 'unhealthy';
      message = `HTTP ${response.status}: ${response.statusText}`;
    }

    return {
      serverId: server.id,
      status,
      statusCode: response.status,
      message,
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      serverId: server.id,
      status: 'unhealthy',
      message: mapNetworkErrorToMessage(errorMessage),
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Re-initialize a Streamable HTTP session after 400/404 errors.
 * Sends a fresh initialize request without session ID to establish a new session.
 */
async function reinitializeStreamableHttpSession(
  server: CustomMcpServer,
  startTime: number
): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  if (!server.url) {
    return { success: false, error: 'No URL configured' };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000); // 15 second timeout for initialization

    // Fresh initialization request - no session ID
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    // Add custom headers if configured
    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    // Send MCP initialize request with Streamable HTTP protocol version
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'auto-claude-health-check',
          version: '1.0.0',
        },
      },
    };

    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(initRequest),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorMsg = `Re-init failed: HTTP ${response.status}`;

      // Sync error state to backend (single source of truth)
      await syncSessionToBackend(server.url, null, 'error', errorMsg);

      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = await response.json();

    if (data.error) {
      const errorMsg = 'MCP protocol error during re-init';

      // Sync error state to backend (single source of truth)
      await syncSessionToBackend(server.url, null, 'error', errorMsg);

      return { success: false, error: 'MCP protocol error' };
    }

    // Capture new Mcp-Session-Id from response headers
    // Headers.get() is case-insensitive per HTTP spec
    const newSessionId = response.headers.get('Mcp-Session-Id');

    const responseTime = Date.now() - startTime;

    if (newSessionId) {
      appLog.debug(`MCP session re-initialized for ${server.id} in ${responseTime}ms (new session established)`);

      // Sync new active session to backend (single source of truth)
      await syncSessionToBackend(server.url, newSessionId, 'active');

      return { success: true, sessionId: newSessionId };
    } else {
      // Server didn't return a session ID - still mark as active
      appLog.debug(`MCP re-initialized for ${server.id} in ${responseTime}ms (no session ID returned)`);

      // Sync active state to backend (without session ID)
      await syncSessionToBackend(server.url, null, 'active');

      return { success: true };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Sync error state to backend (single source of truth)
    await syncSessionToBackend(server.url, null, 'error', errorMessage);

    return { success: false, error: errorMessage };
  }
}

/**
 * Check command-based server health by verifying the command exists.
 */
async function checkCommandHealth(server: CustomMcpServer, startTime: number): Promise<McpHealthCheckResult> {
  if (!server.command) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'No command configured',
      checkedAt: new Date().toISOString(),
    };
  }

  return new Promise((resolve) => {
    // Defense-in-depth: Validate command and args before spawn
    if (!isCommandSafe(server.command)) {
      return resolve({
        serverId: server.id,
        status: 'unhealthy',
        message: `Invalid command '${server.command}' - not in allowlist`,
        checkedAt: new Date().toISOString(),
      });
    }
    if (!areArgsSafe(server.args)) {
      return resolve({
        serverId: server.id,
        status: 'unhealthy',
        message: 'Args contain dangerous flags or shell metacharacters',
        checkedAt: new Date().toISOString(),
      });
    }

    const command = isWindows() ? 'where' : 'which';
    const proc = spawn(command, [server.command!], {
      timeout: 5000,
    });

    let found = false;

    proc.on('close', (code) => {
      const responseTime = Date.now() - startTime;

      if (code === 0 || found) {
        resolve({
          serverId: server.id,
          status: 'healthy',
          message: `Command '${server.command}' found`,
          responseTime,
          checkedAt: new Date().toISOString(),
        });
      } else {
        resolve({
          serverId: server.id,
          status: 'unhealthy',
          message: `Command '${server.command}' not found in PATH`,
          responseTime,
          checkedAt: new Date().toISOString(),
        });
      }
    });

    proc.stdout.on('data', () => {
      found = true;
    });

    proc.on('error', () => {
      const responseTime = Date.now() - startTime;
      resolve({
        serverId: server.id,
        status: 'unhealthy',
        message: `Failed to check command '${server.command}'`,
        responseTime,
        checkedAt: new Date().toISOString(),
      });
    });
  });
}

/**
 * Full MCP connection test - actually connects to the server and tries to list tools.
 * This is more thorough but slower than the health check.
 */
async function testMcpConnection(server: CustomMcpServer): Promise<McpTestConnectionResult> {
  const startTime = Date.now();

  if (server.type === 'streamable-http') {
    return testStreamableHttpConnection(server, startTime);
  } else if (server.type === 'http') {
    return testHttpConnection(server, startTime);
  } else if (server.type === 'command') {
    return testCommandConnection(server, startTime);
  } else {
    // Explicit handling for unknown types
    return {
      serverId: server.id,
      success: false,
      message: `Unsupported server type: ${server.type}`,
    };
  }
}

/**
 * Test HTTP MCP server connection by sending an MCP initialize request.
 */
async function testHttpConnection(server: CustomMcpServer, startTime: number): Promise<McpTestConnectionResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      success: false,
      message: 'No URL configured',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    // Send MCP initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'auto-claude-health-check',
          version: '1.0.0',
        },
      },
    };

    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(initRequest),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          serverId: server.id,
          success: false,
          message: 'Authentication failed',
          responseTime,
        };
      }
      return {
        serverId: server.id,
        success: false,
        message: `Server returned HTTP ${response.status}`,
        responseTime,
      };
    }

    const data = await response.json();

    if (data.error) {
      return {
        serverId: server.id,
        success: false,
        message: 'MCP protocol error',
        responseTime,
      };
    }

    // Now try to list tools (with separate timeout)
    const toolsController = new AbortController();
    const toolsTimeout = setTimeout(() => toolsController.abort(), 10000);

    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    let tools: string[] = [];
    try {
      const toolsResponse = await fetch(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(toolsRequest),
        signal: toolsController.signal,
      });

      clearTimeout(toolsTimeout);

      if (toolsResponse.ok) {
        const toolsData = await toolsResponse.json();
        if (toolsData.result?.tools) {
          tools = toolsData.result.tools.map((t: { name: string }) => t.name);
        }
      }
    } catch (toolsError) {
      // Tools listing is optional - don't fail the connection test
      clearTimeout(toolsTimeout);
      appLog.debug(`MCP tools/list request failed for ${server.id}:`, toolsError);
    }

    return {
      serverId: server.id,
      success: true,
      message: tools.length > 0 ? `Connected successfully, ${tools.length} tools available` : 'Connected successfully',
      tools,
      responseTime,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      serverId: server.id,
      success: false,
      message: mapNetworkErrorToMessage(errorMessage),
      responseTime,
    };
  }
}

/**
 * Test Streamable HTTP MCP server connection by sending an MCP initialize request.
 * Uses MCP protocol version 2025-03-26 and proper Accept header for streaming support.
 * Captures Mcp-Session-Id from initialize response headers for session management.
 */
async function testStreamableHttpConnection(server: CustomMcpServer, startTime: number): Promise<McpTestConnectionResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      success: false,
      message: 'No URL configured',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    // Sync initializing state to backend (single source of truth)
    await syncSessionToBackend(server.url, null, 'initializing');

    // Streamable HTTP requires Accept header with both JSON and SSE support
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    // Send MCP initialize request with Streamable HTTP protocol version
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'auto-claude-health-check',
          version: '1.0.0',
        },
      },
    };

    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(initRequest),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      const errorMsg = `HTTP ${response.status}`;

      // Sync error state to backend (single source of truth)
      await syncSessionToBackend(server.url, null, 'error', errorMsg);

      if (response.status === 401 || response.status === 403) {
        return {
          serverId: server.id,
          success: false,
          message: 'Authentication failed',
          responseTime,
        };
      }
      return {
        serverId: server.id,
        success: false,
        message: `Server returned HTTP ${response.status}`,
        responseTime,
      };
    }

    const data = await response.json();

    if (data.error) {
      // Sync error state to backend (single source of truth)
      await syncSessionToBackend(server.url, null, 'error', 'MCP protocol error');

      return {
        serverId: server.id,
        success: false,
        message: 'MCP protocol error',
        responseTime,
      };
    }

    // Capture Mcp-Session-Id from response headers
    // Headers.get() is case-insensitive per HTTP spec
    const sessionId = response.headers.get('Mcp-Session-Id');

    // Store session ID if present - this establishes an active session
    if (sessionId) {
      appLog.debug(`MCP session established for ${server.id} (session ID captured)`);

      // Sync active session to backend (single source of truth)
      await syncSessionToBackend(server.url, sessionId, 'active');
    } else {
      // Server didn't return a session ID - still mark as active but without session
      appLog.debug(`MCP connection established for ${server.id} (no session ID returned)`);

      // Sync active state to backend (without session ID)
      await syncSessionToBackend(server.url, null, 'active');
    }

    // Now try to list tools (with separate timeout)
    const toolsController = new AbortController();
    const toolsTimeout = setTimeout(() => toolsController.abort(), 10000);

    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    // Include session ID in subsequent requests if available
    const toolsHeaders: Record<string, string> = { ...headers };
    if (sessionId) {
      toolsHeaders['Mcp-Session-Id'] = sessionId;
    }

    let tools: string[] = [];
    try {
      const toolsResponse = await fetch(server.url, {
        method: 'POST',
        headers: toolsHeaders,
        body: JSON.stringify(toolsRequest),
        signal: toolsController.signal,
      });

      clearTimeout(toolsTimeout);

      if (toolsResponse.ok) {
        const toolsData = await toolsResponse.json();
        if (toolsData.result?.tools) {
          tools = toolsData.result.tools.map((t: { name: string }) => t.name);
        }
        // Note: Request count is tracked by backend MCPSessionManager
      } else if (toolsResponse.status === 400 || toolsResponse.status === 404) {
        // HTTP 400: Missing session - session ID required but not provided
        // HTTP 404: Expired session - session ID no longer valid
        // This shouldn't happen right after initialization, but handle it gracefully
        appLog.debug(
          `MCP tools/list got ${toolsResponse.status} for ${server.id} - session may have expired immediately, clearing`
        );

        // Sync reconnecting state to backend (single source of truth)
        await syncSessionToBackend(server.url, null, 'reconnecting');

        // Re-initialize and retry tools/list once
        const reinitResult = await reinitializeStreamableHttpSession(server, startTime);
        if (reinitResult.success && reinitResult.sessionId) {
          // Retry tools/list with new session
          const retryController = new AbortController();
          const retryTimeout = setTimeout(() => retryController.abort(), 10000);

          const retryHeaders: Record<string, string> = { ...headers };
          retryHeaders['Mcp-Session-Id'] = reinitResult.sessionId;

          try {
            const retryResponse = await fetch(server.url, {
              method: 'POST',
              headers: retryHeaders,
              body: JSON.stringify(toolsRequest),
              signal: retryController.signal,
            });

            clearTimeout(retryTimeout);

            if (retryResponse.ok) {
              const retryData = await retryResponse.json();
              if (retryData.result?.tools) {
                tools = retryData.result.tools.map((t: { name: string }) => t.name);
              }
              // Note: Request count is tracked by backend MCPSessionManager
            }
          } catch (retryError) {
            clearTimeout(retryTimeout);
            appLog.debug(`MCP tools/list retry failed for ${server.id}:`, retryError);
          }
        }
      }
    } catch (toolsError) {
      // Tools listing is optional - don't fail the connection test
      clearTimeout(toolsTimeout);
      appLog.debug(`MCP tools/list request failed for ${server.id}:`, toolsError);
    }

    const message = tools.length > 0
      ? `Connected successfully, ${tools.length} tools available`
      : 'Connected successfully (Streamable HTTP)';

    return {
      serverId: server.id,
      success: true,
      message: sessionId ? `${message} [session active]` : message,
      tools,
      responseTime,
      sessionId: sessionId ?? undefined,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Sync error state to backend (single source of truth)
    await syncSessionToBackend(server.url, null, 'error', errorMessage);

    return {
      serverId: server.id,
      success: false,
      message: mapNetworkErrorToMessage(errorMessage),
      responseTime,
    };
  }
}

/**
 * Test command-based MCP server connection by spawning the process and trying to communicate.
 */
async function testCommandConnection(server: CustomMcpServer, startTime: number): Promise<McpTestConnectionResult> {
  if (!server.command) {
    return {
      serverId: server.id,
      success: false,
      message: 'No command configured',
    };
  }

  return new Promise((resolve) => {
    // Defense-in-depth: Validate command and args before spawn
    if (!isCommandSafe(server.command)) {
      return resolve({
        serverId: server.id,
        success: false,
        message: `Invalid command '${server.command}' - not in allowlist`,
      });
    }
    if (!areArgsSafe(server.args)) {
      return resolve({
        serverId: server.id,
        success: false,
        message: 'Args contain dangerous flags or shell metacharacters',
      });
    }

    const args = server.args || [];

    // On Windows, use shell: true to properly handle .cmd/.bat scripts like npx
    const proc = spawn(server.command!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000, // OS-level timeout for reliable process termination
      shell: isWindows(), // Required for Windows to run npx.cmd
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        const responseTime = Date.now() - startTime;
        resolve({
          serverId: server.id,
          success: false,
          message: 'Connection timed out',
          responseTime,
        });
      }
    }, 15000); // 15 second timeout (matches spawn timeout)

    // Send MCP initialize request
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'auto-claude-health-check',
          version: '1.0.0',
        },
      },
    }) + '\n';

    proc.stdin.write(initRequest);

    proc.stdout.on('data', (data) => {
      stdout += data.toString('utf-8');

      // Try to parse JSON response
      try {
        const lines = stdout.split('\n').filter(l => l.trim());
        for (const line of lines) {
          const response = JSON.parse(line);
          if (response.id === 1 && response.result) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeoutId);
              proc.kill();
              const responseTime = Date.now() - startTime;
              resolve({
                serverId: server.id,
                success: true,
                message: 'MCP server started successfully',
                responseTime,
              });
            }
            return;
          }
        }
      } catch {
        // Not valid JSON yet, keep waiting
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString('utf-8');
    });

    proc.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const responseTime = Date.now() - startTime;
        resolve({
          serverId: server.id,
          success: false,
          message: 'Failed to start server',
          error: error.message,
          responseTime,
        });
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const responseTime = Date.now() - startTime;
        if (code === 0) {
          resolve({
            serverId: server.id,
            success: true,
            message: 'Server process started',
            responseTime,
          });
        } else {
          resolve({
            serverId: server.id,
            success: false,
            message: `Server exited with code ${code}`,
            error: stderr || undefined,
            responseTime,
          });
        }
      }
    });
  });
}

/**
 * Terminate a Streamable HTTP session by sending HTTP DELETE with Mcp-Session-Id header.
 * Per MCP spec 2025-03-26: clients SHOULD send HTTP DELETE to explicitly terminate sessions.
 *
 * This function coordinates with the backend MCPSessionManager:
 * 1. Gets session ID from backend (single source of truth)
 * 2. Sends HTTP DELETE to the server
 * 3. Notifies backend of termination result
 *
 * @param serverUrl - The server URL with an active session
 * @param headers - Optional custom headers to include in the request
 * @returns Result indicating success/failure of termination
 */
async function terminateMcpSession(
  serverUrl: string,
  headers?: Record<string, string>
): Promise<{ success: boolean; message: string; statusCode?: number }> {
  // Get session ID from backend (single source of truth) and mark as terminating
  const backendResult = await terminateSessionInBackend(serverUrl);

  if (!backendResult.success) {
    return {
      success: false,
      message: backendResult.message || 'No session exists for this server',
    };
  }

  const sessionId = backendResult.sessionId;
  if (!sessionId) {
    // No session ID - backend has already cleared the session
    // Notify backend termination is complete (no HTTP request needed)
    await notifyTerminationComplete(serverUrl, true);

    return {
      success: true,
      message: 'Session cleared (no session ID to terminate)',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const requestHeaders: Record<string, string> = {
      'Mcp-Session-Id': sessionId,
    };

    // Add custom headers if provided
    if (headers) {
      Object.assign(requestHeaders, headers);
    }

    // Send HTTP DELETE to terminate session
    const response = await fetch(serverUrl, {
      method: 'DELETE',
      headers: requestHeaders,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Notify backend of termination result
    await notifyTerminationComplete(serverUrl, response.ok || response.status === 204 || response.status === 404, response.status);

    if (response.ok || response.status === 204) {
      // 200 or 204 indicates successful termination
      appLog.debug(`MCP session terminated successfully for ${serverUrl}`);
      return {
        success: true,
        message: 'Session terminated successfully',
        statusCode: response.status,
      };
    } else if (response.status === 404) {
      // 404 likely means session already expired - still consider it terminated
      appLog.debug(`MCP session already expired for ${serverUrl} (404)`);
      return {
        success: true,
        message: 'Session already expired or terminated',
        statusCode: response.status,
      };
    } else {
      appLog.debug(`MCP session termination returned HTTP ${response.status} for ${serverUrl}`);
      return {
        success: false,
        message: `Server returned HTTP ${response.status}`,
        statusCode: response.status,
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // Notify backend of termination failure
    await notifyTerminationComplete(serverUrl, false);

    return {
      success: false,
      message: mapNetworkErrorToMessage(errorMessage),
    };
  }
}

/**
 * Register MCP IPC handlers.
 */
export function registerMcpHandlers(): void {
  // Quick health check
  ipcMain.handle(IPC_CHANNELS.MCP_CHECK_HEALTH, async (_event, server: CustomMcpServer) => {
    try {
      const result = await checkMcpHealth(server);
      return { success: true, data: result };
    } catch (error) {
      appLog.error('MCP health check error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Health check failed',
      };
    }
  });

  // Full connection test
  ipcMain.handle(IPC_CHANNELS.MCP_TEST_CONNECTION, async (_event, server: CustomMcpServer) => {
    try {
      const result = await testMcpConnection(server);
      return { success: true, data: result };
    } catch (error) {
      appLog.error('MCP connection test error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection test failed',
      };
    }
  });

  // Terminate MCP session (HTTP DELETE with Mcp-Session-Id)
  // Note: terminateMcpSession handles all errors internally and returns success/failure
  ipcMain.handle(
    IPC_CHANNELS.MCP_SESSION_TERMINATE,
    async (_event, serverUrl: string, headers?: Record<string, string>) => {
      const result = await terminateMcpSession(serverUrl, headers);
      return { success: result.success, data: result };
    }
  );

  // Get session status for a server (queries backend as single source of truth)
  ipcMain.handle(
    IPC_CHANNELS.MCP_SESSION_GET_STATUS,
    async (_event, serverUrl: string, serverName?: string) => {
      try {
        // Fetch session status from backend MCPSessionManager
        const status = await getSessionStatusFromBackend(serverUrl, serverName);
        return { success: true, data: status };
      } catch (error) {
        appLog.error('MCP session status error:', error);
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Failed to get session status',
        };
      }
    }
  );

  // Get all active sessions (queries backend as single source of truth)
  ipcMain.handle(IPC_CHANNELS.MCP_SESSION_GET_ALL, async () => {
    try {
      // Fetch all sessions from backend MCPSessionManager
      const result = await getAllSessionsFromBackend();
      if (result.success) {
        return { success: true, data: result.sessions };
      }
      return {
        success: false,
        error: result.error || 'Failed to get sessions from backend',
      };
    } catch (error) {
      appLog.error('MCP get all sessions error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to get sessions',
      };
    }
  });
}
