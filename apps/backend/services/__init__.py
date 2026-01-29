"""
Services Module
===============

Background services and orchestration for Auto Claude.
"""

from .context import ServiceContext
from .mcp_session_ipc import (
    MCP_SESSION_HANDLERS,
    dispatch_mcp_session_message,
    handle_mcp_session_get,
    handle_mcp_session_get_all,
    handle_mcp_session_set,
    handle_mcp_session_terminate,
)
from .orchestrator import ServiceOrchestrator
from .recovery import RecoveryManager

__all__ = [
    "ServiceContext",
    "ServiceOrchestrator",
    "RecoveryManager",
    # MCP Session IPC handlers and dispatcher
    "handle_mcp_session_set",
    "handle_mcp_session_get",
    "handle_mcp_session_get_all",
    "handle_mcp_session_terminate",
    "dispatch_mcp_session_message",
    "MCP_SESSION_HANDLERS",
]
