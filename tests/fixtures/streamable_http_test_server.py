#!/usr/bin/env python3
"""
Streaming HTTP MCP Test Server
===============================

A FastMCP-based test server for E2E testing of streamable-http MCP integration.

This server implements the MCP protocol 2025-03-26 with streamable-http transport
and provides two tools for testing:
- get_secret_token: Returns a unique UUID to verify connectivity
- mark_test_complete: Accepts the token to mark test completion

Usage:
    python streamable_http_test_server.py --port 8765
"""

import argparse
import sys
import uuid
from threading import Lock

try:
    from mcp.server.fastmcp import FastMCP
except ImportError:
    print(
        "ERROR: mcp package not installed. Install with: pip install mcp",
        file=sys.stderr,
    )
    sys.exit(1)

# =============================================================================
# SERVER STATE
# =============================================================================

# Unique token generated on each server start
SECRET_TOKEN = str(uuid.uuid4())

# Thread-safe flag for test completion
test_complete_lock = Lock()
TEST_COMPLETE_FLAG = False

# =============================================================================
# MCP SERVER SETUP
# =============================================================================

mcp = FastMCP("e2e-test-server")


@mcp.tool()
def get_secret_token() -> str:
    """
    Returns a unique token that proves connectivity.

    This tool is used by the E2E test to verify that Claude can successfully
    discover and call tools on this MCP server.

    Returns:
        str: A unique UUID token
    """
    return SECRET_TOKEN


@mcp.tool()
def mark_test_complete(confirmation: str) -> str:
    """
    Call this with the secret token to complete the test.

    This tool verifies that Claude can both retrieve the token via
    get_secret_token() and successfully use it as a parameter in another
    tool call.

    Args:
        confirmation: The secret token received from get_secret_token()

    Returns:
        str: Success or failure message
    """
    global TEST_COMPLETE_FLAG

    with test_complete_lock:
        if confirmation == SECRET_TOKEN:
            TEST_COMPLETE_FLAG = True
            return "Test marked complete"

    return "Invalid confirmation token"


# =============================================================================
# MAIN ENTRY POINT
# =============================================================================

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Streamable HTTP MCP test server for E2E testing"
    )
    parser.add_argument(
        "--port",
        type=int,
        default=8000,
        help="Port to run the server on (default: 8000)",
    )
    args = parser.parse_args()

    # Print token for test fixture to capture
    # This allows the test to verify Claude received the correct token
    print(f"SECRET_TOKEN={SECRET_TOKEN}")
    sys.stdout.flush()

    # Start the MCP server with streamable-http transport
    mcp.run(transport="streamable-http", port=args.port)
