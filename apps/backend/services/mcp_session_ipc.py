"""
MCP Session IPC Handlers for Auto Claude.

Provides IPC message handlers for MCP session operations, allowing the
frontend to communicate session state changes to the backend. The backend
MCPSessionManager is the single source of truth for session state.

Message Types:
- mcp:session:set - Set session state from frontend
- mcp:session:get - Get session for a server URL
- mcp:session:getAll - Get all sessions
- mcp:session:terminate - Terminate a session
"""

from __future__ import annotations

import logging
from typing import Any

from core.mcp_session import (
    MCPSessionState,
    get_mcp_session_manager,
    mask_session_id,
)

logger = logging.getLogger(__name__)


def handle_mcp_session_set(data: dict[str, Any]) -> dict[str, Any]:
    """
    Handle mcp:session:set message from frontend.

    Sets or updates session state in the backend MCPSessionManager.
    Called by frontend when:
    - A new session ID is captured from Mcp-Session-Id response header
    - Session state changes (initializing, active, error, etc.)

    Args:
        data: Message data containing:
            - server_url (str): The URL of the MCP server
            - session_id (str | None): The session ID (can be None)
            - state (str): Session state name (e.g., "active", "error")
            - error (str | None): Optional error message if state is "error"

    Returns:
        Response dict with:
            - success (bool): Whether the operation succeeded
            - message (str): Description of the result
            - session (dict | None): Updated session data (masked)

    Example:
        >>> handle_mcp_session_set({
        ...     "server_url": "http://localhost:3000/mcp",
        ...     "session_id": "abc123xyz",
        ...     "state": "active"
        ... })
        {'success': True, 'message': 'Session state updated', 'session': {...}}
    """
    # Validate required fields
    server_url = data.get("server_url")
    if not server_url:
        logger.warning("mcp:session:set missing server_url")
        return {
            "success": False,
            "message": "Missing required field: server_url",
            "session": None,
        }

    state_str = data.get("state")
    if not state_str:
        logger.warning("mcp:session:set missing state for %s", server_url)
        return {
            "success": False,
            "message": "Missing required field: state",
            "session": None,
        }

    # Parse session state
    try:
        state = MCPSessionState(state_str)
    except ValueError:
        valid_states = [s.value for s in MCPSessionState]
        logger.warning(
            "mcp:session:set invalid state '%s' for %s (valid: %s)",
            state_str,
            server_url,
            valid_states,
        )
        return {
            "success": False,
            "message": f"Invalid state: {state_str}. Valid states: {valid_states}",
            "session": None,
        }

    # Get optional fields
    session_id = data.get("session_id")  # Can be None
    error = data.get("error")  # Optional error message

    # Get the session manager singleton
    manager = get_mcp_session_manager()

    try:
        # Set session with session_id if provided, otherwise just update state
        if session_id is not None or state in (
            MCPSessionState.ACTIVE,
            MCPSessionState.INITIALIZING,
        ):
            # Use set_session for new sessions or state changes with ID
            manager.set_session(server_url, session_id, state)
        else:
            # Use update_state for state-only changes (error, reconnecting, etc.)
            manager.update_state(server_url, state, error)

        # Get the updated session to return
        session = manager.get_session(server_url)
        session_dict = session.to_dict() if session else None

        logger.debug(
            "mcp:session:set success for %s (state: %s, id: %s)",
            server_url,
            state.value,
            mask_session_id(session_id),
        )

        return {
            "success": True,
            "message": "Session state updated",
            "session": session_dict,
        }

    except Exception as e:
        logger.error(
            "mcp:session:set error for %s: %s",
            server_url,
            str(e),
            exc_info=True,
        )
        return {
            "success": False,
            "message": f"Failed to update session: {str(e)}",
            "session": None,
        }
