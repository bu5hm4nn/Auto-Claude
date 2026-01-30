"""
End-to-End Tests for Streaming MCP Server
==========================================

Tests the full streaming HTTP MCP server flow with Claude SDK integration.
These tests validate that Claude can discover and use tools via streamable-http.
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Generator, Optional, Tuple

import pytest
import requests

# Add the backend directory to path
_backend_dir = Path(__file__).parent.parent / "apps" / "backend"
if str(_backend_dir) not in sys.path:
    sys.path.insert(0, str(_backend_dir))


# ============================================================================
# Helper Functions
# ============================================================================


def is_claude_cli_authenticated() -> bool:
    """
    Check if claude CLI is available and authenticated.

    Returns:
        bool: True if claude CLI is installed and appears functional
    """
    if not shutil.which("claude"):
        return False
    try:
        # Quick check - claude --version works without auth
        # Actual usage requires auth, but this is a reasonable proxy
        result = subprocess.run(
            ["claude", "--version"],
            capture_output=True,
            timeout=5,
            text=True,
        )
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def find_available_port() -> int:
    """
    Find an available port by binding to port 0.

    Returns:
        int: An available port number
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        s.listen(1)
        port = s.getsockname()[1]
    return port


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture
def mcp_test_server(tmp_path) -> Generator[Tuple[str, str, subprocess.Popen], None, None]:
    """
    Start the streaming HTTP MCP test server and wait for it to be ready.

    Yields:
        Tuple[str, str, subprocess.Popen]: (server_url, secret_token, process)

    The fixture handles:
    - Finding an available port
    - Starting the server subprocess
    - Waiting for server health check
    - Capturing the secret token from stdout
    - Cleanup: terminating the subprocess
    """
    # Find available port
    port = find_available_port()
    server_url = f"http://127.0.0.1:{port}"

    # Path to test server
    test_server_path = Path(__file__).parent / "fixtures" / "streamable_http_test_server.py"
    if not test_server_path.exists():
        pytest.fail(f"Test server not found at {test_server_path}")

    # Start server process
    process = subprocess.Popen(
        [sys.executable, str(test_server_path), "--port", str(port)],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,  # Line buffered
    )

    # Capture secret token from first line of output
    secret_token: Optional[str] = None
    try:
        # Read first line with timeout
        start_time = time.time()
        while time.time() - start_time < 10:
            if process.poll() is not None:
                # Process died
                stderr = process.stderr.read() if process.stderr else ""
                pytest.fail(f"Server process died during startup. stderr: {stderr}")

            # Try to read a line non-blocking style
            if process.stdout:
                line = process.stdout.readline()
                if line:
                    line = line.strip()
                    if line.startswith("SECRET_TOKEN="):
                        secret_token = line.split("=", 1)[1]
                        break

            time.sleep(0.1)

        if not secret_token:
            pytest.fail("Failed to capture SECRET_TOKEN from server output")

        # Wait for server to be ready (up to 10 seconds)
        # Check the MCP endpoint since FastMCP doesn't guarantee a /health endpoint
        mcp_url = f"{server_url}/mcp"
        start_time = time.time()
        server_ready = False

        while time.time() - start_time < 10:
            try:
                # Try to connect to the MCP endpoint
                # A 405 (Method Not Allowed) or 200 indicates server is running
                response = requests.get(mcp_url, timeout=2)
                if response.status_code in [200, 405]:
                    server_ready = True
                    break
            except requests.RequestException:
                pass

            time.sleep(0.5)

        if not server_ready:
            process.terminate()
            pytest.fail(f"Server failed to become ready at {mcp_url}")

        # Server is ready
        yield (server_url, secret_token, process)

    finally:
        # Cleanup: terminate server process
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


# ============================================================================
# E2E Test: Server Connectivity
# ============================================================================


class TestMCPServerHealth:
    """Test server connectivity and readiness."""

    def test_health_check(self, mcp_test_server):
        """Test that server is running and MCP endpoint is accessible."""
        server_url, secret_token, process = mcp_test_server

        # Verify MCP endpoint is accessible
        mcp_url = f"{server_url}/mcp"
        response = requests.get(mcp_url, timeout=5)

        # MCP endpoint should respond (200 or 405 are both valid)
        assert response.status_code in [200, 405], (
            f"MCP endpoint returned unexpected status: {response.status_code}"
        )

    def test_server_response_time(self, mcp_test_server):
        """Test that server responds quickly."""
        server_url, secret_token, process = mcp_test_server

        mcp_url = f"{server_url}/mcp"
        start_time = time.time()
        response = requests.get(mcp_url, timeout=5)
        response_time = time.time() - start_time

        assert response.status_code in [200, 405]
        assert response_time < 2.0, f"Server response took {response_time:.2f}s (expected <2s)"

    def test_server_process_running(self, mcp_test_server):
        """Test that the server process is still running."""
        server_url, secret_token, process = mcp_test_server

        # Verify process is still alive
        assert process.poll() is None, "Server process terminated unexpectedly"


# ============================================================================
# E2E Test: Claude Integration
# ============================================================================


@pytest.mark.skipif(
    not is_claude_cli_authenticated(),
    reason="Requires authenticated claude CLI"
)
@pytest.mark.slow
class TestClaudeStreamingMCP:
    """Test Claude integration with streaming MCP server."""

    def test_streaming_mcp_e2e(self, mcp_test_server, tmp_path):
        """
        Full E2E test: Claude discovers tools, calls them, and completes test.

        This test verifies:
        1. Claude can discover the MCP server's tools
        2. Claude can call get_secret_token and receive the correct value
        3. Claude can call mark_test_complete with the token
        4. The test completion flag is set server-side
        """
        server_url, secret_token, process = mcp_test_server

        # Create temporary MCP config
        mcp_config = {
            "mcpServers": {
                "e2e-test-server": {
                    "type": "streamable-http",
                    "url": f"{server_url}/mcp",
                    "name": "E2E Test Server",
                }
            }
        }

        mcp_config_file = tmp_path / "mcp_config.json"
        with open(mcp_config_file, "w") as f:
            json.dump(mcp_config, f)

        # Set environment variable for Claude SDK
        env = os.environ.copy()
        env["CUSTOM_MCP_SERVERS"] = str(mcp_config_file)

        # Create prompt for Claude
        prompt = """You have access to an MCP server called "e2e-test-server".

1. First, call the get_secret_token tool to retrieve a unique token
2. Then, call the mark_test_complete tool with that token as the confirmation parameter
3. Report back the token value you received

This is a validation test - complete both steps."""

        # Call Claude via CLI
        result = subprocess.run(
            ["claude", "--no-stream", prompt],
            capture_output=True,
            text=True,
            timeout=120,
            env=env,
        )

        # Verify Claude executed successfully
        assert result.returncode == 0, f"Claude CLI failed: {result.stderr}"

        # Verify the response contains the secret token
        output = result.stdout
        assert secret_token in output, (
            f"Expected token '{secret_token}' not found in Claude's response.\n"
            f"Output: {output}"
        )

        # Verify server-side completion flag via /test-status endpoint
        test_status_url = f"{server_url}/test-status"
        status_response = requests.get(test_status_url, timeout=5)
        assert status_response.status_code == 200, (
            f"/test-status endpoint returned {status_response.status_code}"
        )

        status_data = status_response.json()
        assert status_data.get("complete") is True, (
            f"Test completion flag not set. Response: {status_data}"
        )
        assert status_data.get("token_matched") is True, (
            f"Token did not match. Response: {status_data}"
        )

    def test_mcp_tool_discovery(self, mcp_test_server, tmp_path):
        """Test that Claude can discover the MCP server's tools."""
        server_url, secret_token, process = mcp_test_server

        # Create MCP config
        mcp_config = {
            "mcpServers": {
                "e2e-test-server": {
                    "type": "streamable-http",
                    "url": f"{server_url}/mcp",
                    "name": "E2E Test Server",
                }
            }
        }

        mcp_config_file = tmp_path / "mcp_config.json"
        with open(mcp_config_file, "w") as f:
            json.dump(mcp_config, f)

        env = os.environ.copy()
        env["CUSTOM_MCP_SERVERS"] = str(mcp_config_file)

        # Ask Claude to list available tools
        prompt = "List all the MCP tools available to you from the e2e-test-server."

        result = subprocess.run(
            ["claude", "--no-stream", prompt],
            capture_output=True,
            text=True,
            timeout=60,
            env=env,
        )

        assert result.returncode == 0, f"Claude CLI failed: {result.stderr}"

        output = result.stdout.lower()

        # Verify both tools are mentioned
        assert "get_secret_token" in output or "get-secret-token" in output, (
            "get_secret_token tool not discovered"
        )
        assert "mark_test_complete" in output or "mark-test-complete" in output, (
            "mark_test_complete tool not discovered"
        )
