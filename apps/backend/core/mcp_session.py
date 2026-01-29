"""
MCP Session Manager for Auto Claude.

Provides in-memory session state management for Streamable HTTP MCP servers.
Sessions are ephemeral and NOT persisted to disk.

Key behaviors:
- Stores session IDs per server URL
- Sessions are globally unique ASCII strings (0x21-0x7E)
- Session IDs are NOT logged in plaintext for security
- Sessions are cleared when the manager is destroyed
"""

from __future__ import annotations

import logging
import threading
from datetime import datetime, timezone
from enum import Enum
from typing import Callable

logger = logging.getLogger(__name__)


class MCPSessionState(Enum):
    """Possible states for an MCP session."""

    DISCONNECTED = "disconnected"  # No session established
    INITIALIZING = "initializing"  # Initialization in progress
    ACTIVE = "active"  # Session established and active
    RECONNECTING = "reconnecting"  # Re-initializing after error
    TERMINATING = "terminating"  # Termination in progress
    ERROR = "error"  # Session encountered an error


class MCPSession:
    """
    Represents a single MCP session with a server.

    Attributes:
        server_url: Unique server URL (used as key in session store)
        session_id: Session ID from Mcp-Session-Id response header
        state: Current session state
        established_at: When session was established (ISO 8601)
        last_activity_at: Last activity timestamp (ISO 8601)
        request_count: Number of successful requests made with this session
        reinitialize_count: Number of times session was re-initialized
        last_error: Last error message (if state is ERROR)
    """

    def __init__(self, server_url: str) -> None:
        """Create a new empty session for a server URL."""
        self.server_url = server_url
        self.session_id: str | None = None
        self.state = MCPSessionState.DISCONNECTED
        self.established_at: str | None = None
        self.last_activity_at: str | None = None
        self.request_count = 0
        self.reinitialize_count = 0
        self.last_error: str | None = None

    def copy(self) -> "MCPSession":
        """
        Create a shallow copy of this session.

        Returns a new MCPSession with the same attribute values.
        This is used to return safe copies from MCPSessionManager
        that won't affect internal state if modified externally.

        Returns:
            A new MCPSession instance with copied attributes
        """
        session = MCPSession(self.server_url)
        session.session_id = self.session_id
        session.state = self.state
        session.established_at = self.established_at
        session.last_activity_at = self.last_activity_at
        session.request_count = self.request_count
        session.reinitialize_count = self.reinitialize_count
        session.last_error = self.last_error
        return session

    def to_dict(self) -> dict:
        """Convert session to dictionary for serialization."""
        return {
            "server_url": self.server_url,
            "session_id_masked": mask_session_id(self.session_id),
            "state": self.state.value,
            "established_at": self.established_at,
            "last_activity_at": self.last_activity_at,
            "request_count": self.request_count,
            "reinitialize_count": self.reinitialize_count,
            "last_error": self.last_error,
        }


class MCPSessionTerminateResult:
    """Result of a session termination attempt."""

    def __init__(self, server_url: str, success: bool, message: str) -> None:
        self.server_url = server_url
        self.success = success
        self.message = message

    def to_dict(self) -> dict:
        """Convert result to dictionary for serialization."""
        return {
            "server_url": self.server_url,
            "success": self.success,
            "message": self.message,
        }


def mask_session_id(session_id: str | None) -> str:
    """
    Mask a session ID for safe logging (show first 4 chars only).

    IMPORTANT: Session IDs should NEVER be logged in plaintext.
    Always use this function when logging or displaying session IDs.

    Args:
        session_id: The session ID to mask (can be None)

    Returns:
        Masked string like "abc1****" or "<none>" if no session ID
    """
    if not session_id:
        return "<none>"
    if len(session_id) <= 4:
        return "****"
    return f"{session_id[:4]}****"


def _now_iso() -> str:
    """Get current timestamp in ISO 8601 format."""
    return datetime.now(timezone.utc).isoformat()


# Type alias for session state change listeners
SessionListener = Callable[[str, MCPSession], None]


class MCPSessionManager:
    """
    MCP Session Manager for storing and managing session IDs.

    This class provides thread-safe in-memory session storage for
    Streamable HTTP MCP servers. Sessions are ephemeral and NOT
    persisted to disk.

    Thread Safety:
        All methods are thread-safe and can be called from multiple threads.

    Security:
        Session IDs are never logged in plaintext. Use mask_session_id()
        when logging or displaying session information.

    Usage:
        manager = MCPSessionManager()

        # Set session after receiving Mcp-Session-Id from initialize response
        manager.set_session(server_url, session_id, MCPSessionState.ACTIVE)

        # Get session ID for header injection
        session_id = manager.get_session_id(server_url)
        if session_id:
            headers["Mcp-Session-Id"] = session_id

        # Handle session errors (400/404 responses)
        manager.update_state(server_url, MCPSessionState.RECONNECTING)

        # Terminate session
        result = manager.terminate_session(server_url)
    """

    def __init__(self) -> None:
        """Initialize the session manager."""
        self._sessions: dict[str, MCPSession] = {}
        self._lock = threading.RLock()
        self._listeners: list[SessionListener] = []

    def get_session(self, server_url: str) -> MCPSession | None:
        """
        Get session for a server URL.

        Returns a copy of the session to ensure thread safety.
        Modifications to the returned session will not affect the manager's state.

        Args:
            server_url: The URL of the MCP server

        Returns:
            MCPSession copy if one exists for the URL, None otherwise
        """
        with self._lock:
            session = self._sessions.get(server_url)
            return session.copy() if session else None

    def get_all_sessions(self) -> list[MCPSession]:
        """
        Get all sessions.

        Returns copies of all sessions to ensure thread safety.
        Modifications to the returned sessions will not affect the manager's state.

        Returns:
            List of MCPSession copies (safe to iterate and modify)
        """
        with self._lock:
            return [session.copy() for session in self._sessions.values()]

    def get_session_id(self, server_url: str) -> str | None:
        """
        Get session ID for a server URL (for header injection).

        IMPORTANT: Do not log the returned value - session IDs are sensitive.

        Args:
            server_url: The URL of the MCP server

        Returns:
            Session ID string if an active session exists, None otherwise
        """
        with self._lock:
            session = self._sessions.get(server_url)
            if session and session.state == MCPSessionState.ACTIVE:
                return session.session_id
            return None

    def set_session(
        self,
        server_url: str,
        session_id: str | None,
        state: MCPSessionState,
    ) -> None:
        """
        Set or update session for a server URL.

        Creates a new session if one doesn't exist.

        Args:
            server_url: The URL of the MCP server
            session_id: The session ID from Mcp-Session-Id header (or None)
            state: The new session state
        """
        with self._lock:
            existing = self._sessions.get(server_url)
            now = _now_iso()

            # Store old session ID BEFORE updating to detect new sessions
            old_session_id = existing.session_id if existing else None

            if existing:
                session = existing
                session.session_id = session_id
                session.state = state
                session.last_activity_at = now
            else:
                session = MCPSession(server_url)
                session.session_id = session_id
                session.state = state
                session.last_activity_at = now
                self._sessions[server_url] = session

            # Track re-initialization attempts
            if state == MCPSessionState.RECONNECTING:
                session.reinitialize_count += 1

            # Reset counts on new session (compare against old ID, not current)
            if (
                state == MCPSessionState.ACTIVE
                and session_id
                and session_id != old_session_id
            ):
                session.established_at = now
                session.request_count = 0
                # Don't reset reinitialize_count - it's cumulative for observability

            self._notify_listeners(server_url, session)

            # Log state change without exposing session ID
            logger.debug(
                "MCP session state: %s -> %s (id: %s)",
                server_url,
                state.value,
                mask_session_id(session_id),
            )

    def update_state(
        self,
        server_url: str,
        state: MCPSessionState,
        error: str | None = None,
    ) -> None:
        """
        Update session state without changing session ID.

        Args:
            server_url: The URL of the MCP server
            state: The new session state
            error: Optional error message (used when state is ERROR)
        """
        with self._lock:
            existing = self._sessions.get(server_url)

            if not existing:
                # Create new session with the state
                session = MCPSession(server_url)
                session.state = state
                session.last_activity_at = _now_iso()
                if error:
                    session.last_error = error
                self._sessions[server_url] = session
                self._notify_listeners(server_url, session)
                return

            existing.state = state
            existing.last_activity_at = _now_iso()

            if error:
                existing.last_error = error

            if state == MCPSessionState.RECONNECTING:
                existing.reinitialize_count += 1

            self._notify_listeners(server_url, existing)

    def increment_request_count(self, server_url: str) -> None:
        """
        Increment request count for a session.

        Called when a successful request is made with the session.

        Args:
            server_url: The URL of the MCP server
        """
        with self._lock:
            existing = self._sessions.get(server_url)
            if not existing:
                return

            existing.request_count += 1
            existing.last_activity_at = _now_iso()
            # Don't notify for request count increments - too noisy

    def clear_session(self, server_url: str) -> None:
        """
        Clear session for a server URL.

        Used when server is removed or session is manually cleared.

        Args:
            server_url: The URL of the MCP server
        """
        with self._lock:
            if server_url not in self._sessions:
                return

            del self._sessions[server_url]

            # Notify with disconnected state
            cleared = MCPSession(server_url)
            self._notify_listeners(server_url, cleared)

            logger.debug("MCP session cleared: %s", server_url)

    def clear_all_sessions(self) -> None:
        """
        Clear all sessions.

        Used on app shutdown or when switching projects.
        """
        with self._lock:
            server_urls = list(self._sessions.keys())

            self._sessions.clear()

            # Notify for each cleared session
            for server_url in server_urls:
                cleared = MCPSession(server_url)
                self._notify_listeners(server_url, cleared)

            logger.debug("All MCP sessions cleared (%d sessions)", len(server_urls))

    def terminate_session(self, server_url: str) -> MCPSessionTerminateResult:
        """
        Terminate a session by URL.

        This marks the session as terminating - actual HTTP DELETE is done by caller.

        Args:
            server_url: The URL of the MCP server

        Returns:
            MCPSessionTerminateResult indicating if termination can proceed
        """
        with self._lock:
            existing = self._sessions.get(server_url)

            if not existing:
                return MCPSessionTerminateResult(
                    server_url=server_url,
                    success=False,
                    message="No session exists for this server",
                )

            if not existing.session_id:
                # No session ID to terminate, just clear
                self.clear_session(server_url)
                return MCPSessionTerminateResult(
                    server_url=server_url,
                    success=True,
                    message="Session cleared (no session ID)",
                )

            # Mark as terminating - caller will send DELETE request
            self.update_state(server_url, MCPSessionState.TERMINATING)

            return MCPSessionTerminateResult(
                server_url=server_url,
                success=True,
                message="Session termination initiated",
            )

    def termination_complete(
        self,
        server_url: str,
        success: bool,
        status_code: int | None = None,
    ) -> None:
        """
        Mark session termination as complete (after HTTP DELETE).

        Args:
            server_url: The URL of the MCP server
            success: Whether the termination was successful
            status_code: HTTP status code from DELETE response (optional)
        """
        self.clear_session(server_url)

        logger.debug(
            "MCP termination complete: %s (success: %s, status: %s)",
            server_url,
            success,
            status_code or "n/a",
        )

    def is_session_active(self, server_url: str) -> bool:
        """
        Check if a session is active for a server URL.

        Args:
            server_url: The URL of the MCP server

        Returns:
            True if an active session with a session ID exists
        """
        with self._lock:
            session = self._sessions.get(server_url)
            return (
                session is not None
                and session.state == MCPSessionState.ACTIVE
                and session.session_id is not None
            )

    def get_active_session_count(self) -> int:
        """
        Get count of active sessions.

        Returns:
            Number of sessions in ACTIVE state with a session ID
        """
        with self._lock:
            count = 0
            for session in self._sessions.values():
                if (
                    session.state == MCPSessionState.ACTIVE
                    and session.session_id is not None
                ):
                    count += 1
            return count

    def add_listener(self, listener: SessionListener) -> Callable[[], None]:
        """
        Add listener for session state changes.

        Args:
            listener: Callback function(server_url, session) to be notified

        Returns:
            Unsubscribe function - call it to remove the listener
        """
        with self._lock:
            self._listeners.append(listener)

        def unsubscribe() -> None:
            with self._lock:
                if listener in self._listeners:
                    self._listeners.remove(listener)

        return unsubscribe

    def _notify_listeners(self, server_url: str, session: MCPSession) -> None:
        """
        Notify all listeners of session state change.

        Passes a copy of the session to each listener to ensure thread safety.
        Listeners cannot modify the manager's internal state through the session.

        Args:
            server_url: The URL of the MCP server
            session: The updated session
        """
        # Copy listeners to avoid holding lock during callbacks
        with self._lock:
            listeners = self._listeners.copy()

        # Create a copy of the session to pass to listeners
        # This prevents listeners from modifying internal state
        session_copy = session.copy()

        for listener in listeners:
            try:
                listener(server_url, session_copy)
            except Exception as e:
                logger.error("MCP session listener error: %s", e)


# Singleton instance
_instance: MCPSessionManager | None = None
_instance_lock = threading.Lock()


def get_mcp_session_manager() -> MCPSessionManager:
    """
    Get the singleton MCP session manager instance.

    Returns:
        The global MCPSessionManager instance
    """
    global _instance
    with _instance_lock:
        if _instance is None:
            _instance = MCPSessionManager()
        return _instance


def reset_mcp_session_manager() -> None:
    """
    Reset the singleton instance (for testing).

    Clears all sessions and creates a fresh instance.
    """
    global _instance
    with _instance_lock:
        if _instance:
            _instance.clear_all_sessions()
        _instance = None
