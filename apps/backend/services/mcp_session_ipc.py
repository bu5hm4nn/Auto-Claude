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
    session_id_raw = data.get("session_id")  # Can be None or empty string
    error = data.get("error")  # Optional error message

    # Treat empty strings as None to avoid storing invalid session IDs
    session_id = session_id_raw if session_id_raw and session_id_raw.strip() else None

    # Get the session manager singleton
    manager = get_mcp_session_manager()

    try:
        # Special case: disconnected with no session ID means "clear the session record"
        if state == MCPSessionState.DISCONNECTED and session_id is None:
            manager.clear_session(server_url)
        # Set session with session_id if provided (and non-empty), otherwise just update state
        elif session_id is not None or state in (
            MCPSessionState.ACTIVE,
            MCPSessionState.INITIALIZING,
        ):
            # Use set_session for new sessions or state changes with ID
            manager.set_session(server_url, session_id, state)
        else:
            # Use update_state for state-only changes (error, reconnecting, etc.)
            manager.update_state(server_url, state, error)

        # Get the updated session to return (include session_id for frontend IPC)
        session = manager.get_session(server_url)
        session_dict = session.to_dict(include_session_id=True) if session else None

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


def handle_mcp_session_get(data: dict[str, Any]) -> dict[str, Any]:
    """
    Handle mcp:session:get message from frontend.

    Retrieves session state for a specific server URL from the backend
    MCPSessionManager.

    Args:
        data: Message data containing:
            - server_url (str): The URL of the MCP server

    Returns:
        Response dict with:
            - success (bool): Whether the operation succeeded
            - message (str): Description of the result
            - session (dict | None): Session data (masked) or None if not found

    Example:
        >>> handle_mcp_session_get({
        ...     "server_url": "http://localhost:3000/mcp"
        ... })
        {'success': True, 'message': 'Session retrieved', 'session': {...}}
    """
    # Validate required fields
    server_url = data.get("server_url")
    if not server_url:
        logger.warning("mcp:session:get missing server_url")
        return {
            "success": False,
            "message": "Missing required field: server_url",
            "session": None,
        }

    # Get the session manager singleton
    manager = get_mcp_session_manager()

    try:
        session = manager.get_session(server_url)
        # Include session_id for frontend IPC (needed for header injection)
        session_dict = session.to_dict(include_session_id=True) if session else None

        if session:
            logger.debug("mcp:session:get success for %s", server_url)
            return {
                "success": True,
                "message": "Session retrieved",
                "session": session_dict,
            }
        else:
            logger.debug("mcp:session:get no session for %s", server_url)
            return {
                "success": True,
                "message": "No session exists for this server",
                "session": None,
            }

    except Exception as e:
        logger.error(
            "mcp:session:get error for %s: %s",
            server_url,
            str(e),
            exc_info=True,
        )
        return {
            "success": False,
            "message": f"Failed to get session: {str(e)}",
            "session": None,
        }


def handle_mcp_session_get_all(data: dict[str, Any]) -> dict[str, Any]:
    """
    Handle mcp:session:getAll message from frontend.

    Retrieves all session states from the backend MCPSessionManager.

    Args:
        data: Message data (no required fields)

    Returns:
        Response dict with:
            - success (bool): Whether the operation succeeded
            - message (str): Description of the result
            - sessions (list[dict]): List of session data (masked)

    Example:
        >>> handle_mcp_session_get_all({})
        {'success': True, 'message': 'Retrieved 2 sessions', 'sessions': [...]}
    """
    # Get the session manager singleton
    manager = get_mcp_session_manager()

    try:
        sessions = manager.get_all_sessions()
        # Don't include session_id in bulk listing to avoid leaking session IDs.
        # The masked version (session_id_masked) is still included for display purposes.
        sessions_list = [session.to_dict() for session in sessions]

        logger.debug("mcp:session:getAll retrieved %d sessions", len(sessions_list))

        return {
            "success": True,
            "message": f"Retrieved {len(sessions_list)} sessions",
            "sessions": sessions_list,
        }

    except Exception as e:
        logger.error(
            "mcp:session:getAll error: %s",
            str(e),
            exc_info=True,
        )
        return {
            "success": False,
            "message": f"Failed to get sessions: {str(e)}",
            "sessions": [],
        }


def handle_mcp_session_terminate(data: dict[str, Any]) -> dict[str, Any]:
    """
    Handle mcp:session:terminate message from frontend.

    Initiates session termination for a specific server URL. This marks the
    session as TERMINATING in the backend MCPSessionManager. The actual HTTP
    DELETE request to the server should be performed by the caller after
    receiving a successful response.

    Args:
        data: Message data containing:
            - server_url (str): The URL of the MCP server

    Returns:
        Response dict with:
            - success (bool): Whether the termination was initiated
            - message (str): Description of the result
            - result (dict | None): Termination result data

    Example:
        >>> handle_mcp_session_terminate({
        ...     "server_url": "http://localhost:3000/mcp"
        ... })
        {'success': True, 'message': 'Session termination initiated', 'result': {...}}
    """
    # Validate required fields
    server_url = data.get("server_url")
    if not server_url:
        logger.warning("mcp:session:terminate missing server_url")
        return {
            "success": False,
            "message": "Missing required field: server_url",
            "result": None,
        }

    # Get the session manager singleton
    manager = get_mcp_session_manager()

    try:
        result = manager.terminate_session(server_url)
        result_dict = result.to_dict()

        if result.success:
            logger.debug("mcp:session:terminate success for %s", server_url)
        else:
            logger.debug(
                "mcp:session:terminate failed for %s: %s",
                server_url,
                result.message,
            )

        return {
            "success": result.success,
            "message": result.message,
            "result": result_dict,
        }

    except Exception as e:
        logger.error(
            "mcp:session:terminate error for %s: %s",
            server_url,
            str(e),
            exc_info=True,
        )
        return {
            "success": False,
            "message": f"Failed to terminate session: {str(e)}",
            "result": None,
        }


# Handler registry for IPC message routing
MCP_SESSION_HANDLERS = {
    "mcp:session:set": handle_mcp_session_set,
    "mcp:session:get": handle_mcp_session_get,
    "mcp:session:getAll": handle_mcp_session_get_all,
    "mcp:session:terminate": handle_mcp_session_terminate,
}


def dispatch_mcp_session_message(message: dict[str, Any]) -> dict[str, Any]:
    """
    Dispatch an MCP session IPC message to the appropriate handler.

    This is the main entry point for subprocess IPC communication with the
    frontend. The frontend calls this module as a subprocess and passes
    JSON messages for processing.

    Args:
        message: IPC message dict containing:
            - type (str): Message type (e.g., "mcp:session:set")
            - ...additional fields depending on message type

    Returns:
        Response dict from the appropriate handler, or an error response
        if the message type is unknown.

    Example:
        >>> dispatch_mcp_session_message({
        ...     "type": "mcp:session:get",
        ...     "server_url": "http://localhost:3000/mcp"
        ... })
        {'success': True, 'message': 'Session retrieved', 'session': {...}}
    """
    message_type = message.get("type")

    if not message_type:
        return {
            "success": False,
            "message": "Missing required field: type",
            "error": "MISSING_TYPE",
        }

    handler = MCP_SESSION_HANDLERS.get(message_type)

    if not handler:
        valid_types = list(MCP_SESSION_HANDLERS.keys())
        return {
            "success": False,
            "message": f"Unknown message type: {message_type}. Valid types: {valid_types}",
            "error": "UNKNOWN_TYPE",
        }

    # Extract data (everything except 'type')
    data = {k: v for k, v in message.items() if k != "type"}

    try:
        return handler(data)
    except Exception as e:
        logger.error(
            "Error dispatching MCP session message %s: %s",
            message_type,
            str(e),
            exc_info=True,
        )
        return {
            "success": False,
            "message": f"Handler error: {str(e)}",
            "error": "HANDLER_ERROR",
        }


if __name__ == "__main__":
    """
    CLI entry point for subprocess IPC communication.

    Usage:
        # Single message via argument
        python -m services.mcp_session_ipc '{"type": "mcp:session:get", "server_url": "..."}'

        # Interactive mode via stdin (reads one JSON message per line)
        echo '{"type": "mcp:session:getAll"}' | python -m services.mcp_session_ipc

    Output:
        JSON response on stdout
    """
    import json
    import sys

    # Set up basic logging for CLI mode
    logging.basicConfig(
        level=logging.WARNING,
        format="%(levelname)s: %(message)s",
        stream=sys.stderr,
    )

    # Check for message in command line args
    if len(sys.argv) > 1:
        try:
            message = json.loads(sys.argv[1])
            result = dispatch_mcp_session_message(message)
            print(json.dumps(result))
            sys.exit(0 if result.get("success") else 1)
        except json.JSONDecodeError as e:
            error_response = {
                "success": False,
                "message": f"Invalid JSON: {str(e)}",
                "error": "INVALID_JSON",
            }
            print(json.dumps(error_response))
            sys.exit(1)
    else:
        # Read from stdin (non-interactive single message mode)
        # Use read() instead of readline() to support multi-line JSON
        try:
            input_data = sys.stdin.read().strip()
            if not input_data:
                error_response = {
                    "success": False,
                    "message": "No input received",
                    "error": "NO_INPUT",
                }
                print(json.dumps(error_response))
                sys.exit(1)

            message = json.loads(input_data)
            result = dispatch_mcp_session_message(message)
            print(json.dumps(result))
            sys.exit(0 if result.get("success") else 1)
        except json.JSONDecodeError as e:
            error_response = {
                "success": False,
                "message": f"Invalid JSON: {str(e)}",
                "error": "INVALID_JSON",
            }
            print(json.dumps(error_response))
            sys.exit(1)