import type {
  McpSession,
  McpSessionState,
  McpSessionStatus,
  McpSessionTerminateResult,
} from '../../shared/types/project';

/**
 * MCP Session Store
 *
 * In-memory session storage for Streamable HTTP MCP servers.
 * Sessions are ephemeral and NOT persisted to disk.
 *
 * Key behaviors:
 * - Stores session IDs per server URL
 * - Sessions are globally unique ASCII strings (0x21-0x7E)
 * - Session IDs are NOT logged in plaintext for security
 * - Sessions are cleared on app shutdown
 */

/**
 * Create a new empty session for a server URL
 */
function createEmptySession(serverUrl: string): McpSession {
  return {
    serverUrl,
    sessionId: null,
    state: 'disconnected',
    establishedAt: null,
    lastActivityAt: null,
    requestCount: 0,
    reinitializeCount: 0,
  };
}

/**
 * Mask a session ID for safe logging (show first 4 chars only)
 */
function maskSessionId(sessionId: string | null): string {
  if (!sessionId) return '<none>';
  if (sessionId.length <= 4) return '****';
  return `${sessionId.substring(0, 4)}****`;
}

/**
 * MCP Session Store class for managing Streamable HTTP server sessions.
 *
 * Sessions are stored in memory and associated by server URL.
 * This is used by the frontend to track session state for health checks
 * and UI display. The backend manages its own session state.
 */
export class McpSessionStore {
  /** Map of server URL to session data */
  private sessions: Map<string, McpSession> = new Map();

  /** Listeners for session state changes */
  private listeners: Array<(serverUrl: string, session: McpSession) => void> = [];

  /**
   * Get session for a server URL.
   * Returns undefined if no session exists for the URL.
   */
  getSession(serverUrl: string): McpSession | undefined {
    return this.sessions.get(serverUrl);
  }

  /**
   * Get all active sessions.
   * Returns a copy of the sessions map as an array.
   */
  getAllSessions(): McpSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session status for display in UI.
   * Returns a simplified status object for a server URL.
   */
  getSessionStatus(serverUrl: string, serverName?: string): McpSessionStatus {
    const session = this.sessions.get(serverUrl);

    if (!session) {
      return {
        serverUrl,
        serverName,
        isActive: false,
        state: 'disconnected',
        statusMessage: 'No session',
        requestCount: 0,
      };
    }

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
        statusMessage = `Reconnecting (attempt ${session.reinitializeCount + 1})`;
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
   * Set or update session for a server URL.
   * Creates a new session if one doesn't exist.
   */
  setSession(serverUrl: string, sessionId: string | null, state: McpSessionState): void {
    const existing = this.sessions.get(serverUrl);
    const now = new Date().toISOString();

    const session: McpSession = {
      serverUrl,
      sessionId,
      state,
      establishedAt: state === 'active' && !existing?.establishedAt ? now : existing?.establishedAt ?? null,
      lastActivityAt: now,
      requestCount: existing?.requestCount ?? 0,
      reinitializeCount: existing?.reinitializeCount ?? 0,
    };

    // Track re-initialization attempts
    if (state === 'reconnecting') {
      session.reinitializeCount = (existing?.reinitializeCount ?? 0) + 1;
    }

    // Reset counts on new session
    if (state === 'active' && sessionId && sessionId !== existing?.sessionId) {
      session.establishedAt = now;
      session.requestCount = 0;
      // Don't reset reinitializeCount - it's cumulative for observability
    }

    this.sessions.set(serverUrl, session);
    this.notifyListeners(serverUrl, session);

    // Log state change without exposing session ID
    if (process.env.NODE_ENV === 'development') {
      console.warn(
        `[McpSessionStore] Session state: ${serverUrl} -> ${state} (id: ${maskSessionId(sessionId)})`
      );
    }
  }

  /**
   * Update session state without changing session ID.
   */
  updateState(serverUrl: string, state: McpSessionState, error?: string): void {
    const existing = this.sessions.get(serverUrl);

    if (!existing) {
      // Create new session with the state
      const session = createEmptySession(serverUrl);
      session.state = state;
      session.lastActivityAt = new Date().toISOString();
      if (error) session.lastError = error;
      this.sessions.set(serverUrl, session);
      this.notifyListeners(serverUrl, session);
      return;
    }

    const updated: McpSession = {
      ...existing,
      state,
      lastActivityAt: new Date().toISOString(),
    };

    if (error) {
      updated.lastError = error;
    }

    if (state === 'reconnecting') {
      updated.reinitializeCount = existing.reinitializeCount + 1;
    }

    this.sessions.set(serverUrl, updated);
    this.notifyListeners(serverUrl, updated);
  }

  /**
   * Increment request count for a session.
   * Called when a successful request is made with the session.
   */
  incrementRequestCount(serverUrl: string): void {
    const existing = this.sessions.get(serverUrl);
    if (!existing) return;

    const updated: McpSession = {
      ...existing,
      requestCount: existing.requestCount + 1,
      lastActivityAt: new Date().toISOString(),
    };

    this.sessions.set(serverUrl, updated);
    // Don't notify for request count increments - too noisy
  }

  /**
   * Clear session for a server URL.
   * Used when server is removed or session is manually cleared.
   */
  clearSession(serverUrl: string): void {
    const existing = this.sessions.get(serverUrl);
    if (!existing) return;

    this.sessions.delete(serverUrl);

    // Notify with disconnected state
    const cleared = createEmptySession(serverUrl);
    this.notifyListeners(serverUrl, cleared);

    if (process.env.NODE_ENV === 'development') {
      console.warn(`[McpSessionStore] Session cleared: ${serverUrl}`);
    }
  }

  /**
   * Clear all sessions.
   * Used on app shutdown or when switching projects.
   */
  clearAllSessions(): void {
    const serverUrls = Array.from(this.sessions.keys());

    this.sessions.clear();

    // Notify for each cleared session
    for (const serverUrl of serverUrls) {
      const cleared = createEmptySession(serverUrl);
      this.notifyListeners(serverUrl, cleared);
    }

    if (process.env.NODE_ENV === 'development') {
      console.warn(`[McpSessionStore] All sessions cleared (${serverUrls.length} sessions)`);
    }
  }

  /**
   * Terminate a session by URL.
   * This marks the session as terminating - actual HTTP DELETE is done by caller.
   * Returns result indicating if termination can proceed.
   */
  terminateSession(serverUrl: string): McpSessionTerminateResult {
    const existing = this.sessions.get(serverUrl);

    if (!existing) {
      return {
        serverUrl,
        success: false,
        message: 'No session exists for this server',
      };
    }

    if (!existing.sessionId) {
      // No session ID to terminate, just clear
      this.clearSession(serverUrl);
      return {
        serverUrl,
        success: true,
        message: 'Session cleared (no session ID)',
      };
    }

    // Mark as terminating - caller will send DELETE request
    this.updateState(serverUrl, 'terminating');

    return {
      serverUrl,
      success: true,
      message: 'Session termination initiated',
    };
  }

  /**
   * Mark session termination as complete (after HTTP DELETE).
   */
  terminationComplete(serverUrl: string, success: boolean, statusCode?: number): void {
    this.clearSession(serverUrl);

    if (process.env.NODE_ENV === 'development') {
      console.warn(
        `[McpSessionStore] Termination complete: ${serverUrl} (success: ${success}, status: ${statusCode ?? 'n/a'})`
      );
    }
  }

  /**
   * Add listener for session state changes.
   * Returns unsubscribe function.
   */
  addListener(listener: (serverUrl: string, session: McpSession) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Notify all listeners of session state change.
   */
  private notifyListeners(serverUrl: string, session: McpSession): void {
    for (const listener of this.listeners) {
      try {
        listener(serverUrl, session);
      } catch (error) {
        console.error('[McpSessionStore] Listener error:', error);
      }
    }
  }

  /**
   * Check if a session is active for a server URL.
   */
  isSessionActive(serverUrl: string): boolean {
    const session = this.sessions.get(serverUrl);
    return session?.state === 'active' && session?.sessionId !== null;
  }

  /**
   * Get session ID for a server URL (for header injection).
   * Returns null if no active session.
   * IMPORTANT: Do not log the returned value - session IDs are sensitive.
   */
  getSessionId(serverUrl: string): string | null {
    const session = this.sessions.get(serverUrl);
    if (session?.state === 'active') {
      return session.sessionId;
    }
    return null;
  }

  /**
   * Get count of active sessions.
   */
  getActiveSessionCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.state === 'active' && session.sessionId !== null) {
        count++;
      }
    }
    return count;
  }
}

// Singleton instance
let instance: McpSessionStore | null = null;

/**
 * Get the singleton MCP session store instance.
 */
export function getMcpSessionStore(): McpSessionStore {
  if (!instance) {
    instance = new McpSessionStore();
  }
  return instance;
}

/**
 * Reset the singleton instance (for testing).
 */
export function resetMcpSessionStore(): void {
  if (instance) {
    instance.clearAllSessions();
  }
  instance = null;
}
