#!/usr/bin/env python3
"""
Tests for MCP Server Validation
===============================

Tests the _validate_custom_mcp_server() function in core/client.py
which validates custom MCP server configurations for security.
"""

import pytest


class TestValidateCustomMcpServer:
    """Tests for _validate_custom_mcp_server() function."""

    def test_valid_command_server(self):
        """Validates a properly configured command-type MCP server."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server-1",
            "name": "Test Server",
            "type": "command",
            "command": "npx",
            "args": ["-y", "my-mcp-server"],
        }
        assert _validate_custom_mcp_server(server) is True

    def test_valid_http_server(self):
        """Validates a properly configured HTTP-type MCP server."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server-2",
            "name": "HTTP Server",
            "type": "http",
            "url": "https://example.com/mcp",
        }
        assert _validate_custom_mcp_server(server) is True

    def test_valid_streamable_http_server(self):
        """Validates a properly configured streamable-http-type MCP server."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server-3",
            "name": "Streamable HTTP Server",
            "type": "streamable-http",
            "url": "https://example.com/mcp/stream",
        }
        assert _validate_custom_mcp_server(server) is True

    def test_streamable_http_with_headers(self):
        """Validates streamable-http server with custom headers."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server-4",
            "name": "Streamable HTTP with Auth",
            "type": "streamable-http",
            "url": "https://example.com/mcp",
            "headers": {"Authorization": "Bearer token123"},
        }
        assert _validate_custom_mcp_server(server) is True

    def test_invalid_type_rejected(self):
        """Rejects servers with invalid type."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "Bad Server",
            "type": "websocket",  # Invalid type
            "url": "wss://example.com",
        }
        assert _validate_custom_mcp_server(server) is False

    def test_http_missing_url_rejected(self):
        """Rejects HTTP server without URL."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "HTTP Server",
            "type": "http",
            # Missing url
        }
        assert _validate_custom_mcp_server(server) is False

    def test_streamable_http_missing_url_rejected(self):
        """Rejects streamable-http server without URL."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "Streamable HTTP Server",
            "type": "streamable-http",
            # Missing url
        }
        assert _validate_custom_mcp_server(server) is False

    def test_http_empty_url_rejected(self):
        """Rejects HTTP server with empty URL."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "HTTP Server",
            "type": "http",
            "url": "",
        }
        assert _validate_custom_mcp_server(server) is False

    def test_invalid_headers_type_rejected(self):
        """Rejects servers with non-dict headers."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "HTTP Server",
            "type": "streamable-http",
            "url": "https://example.com/mcp",
            "headers": ["Authorization: Bearer token"],  # Should be dict
        }
        assert _validate_custom_mcp_server(server) is False

    def test_invalid_header_value_type_rejected(self):
        """Rejects servers with non-string header values."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "HTTP Server",
            "type": "http",
            "url": "https://example.com/mcp",
            "headers": {"X-Count": 123},  # Value should be string
        }
        assert _validate_custom_mcp_server(server) is False

    def test_missing_required_fields_rejected(self):
        """Rejects servers missing required fields."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            # Missing 'name' and 'type'
        }
        assert _validate_custom_mcp_server(server) is False

    def test_dangerous_command_rejected(self):
        """Rejects command servers with dangerous shell commands."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "Dangerous Server",
            "type": "command",
            "command": "bash",
            "args": ["-c", "echo pwned"],
        }
        assert _validate_custom_mcp_server(server) is False

    def test_unknown_command_rejected(self):
        """Rejects command servers with unknown commands."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "Unknown Command Server",
            "type": "command",
            "command": "some-random-binary",
        }
        assert _validate_custom_mcp_server(server) is False

    def test_dangerous_flags_rejected(self):
        """Rejects command servers with dangerous interpreter flags."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "Dangerous Flags Server",
            "type": "command",
            "command": "node",
            "args": ["--eval", "process.exit(1)"],
        }
        assert _validate_custom_mcp_server(server) is False

    def test_command_with_path_rejected(self):
        """Rejects commands with path separators."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "Path Command Server",
            "type": "command",
            "command": "/usr/bin/npx",
        }
        assert _validate_custom_mcp_server(server) is False

    def test_unexpected_fields_rejected(self):
        """Rejects servers with unexpected fields."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "HTTP Server",
            "type": "http",
            "url": "https://example.com/mcp",
            "malicious_field": "exploit",
        }
        assert _validate_custom_mcp_server(server) is False

    def test_valid_server_with_description(self):
        """Validates server with optional description field."""
        from core.client import _validate_custom_mcp_server

        server = {
            "id": "test-server",
            "name": "Described Server",
            "type": "streamable-http",
            "url": "https://example.com/mcp",
            "description": "A test MCP server",
        }
        assert _validate_custom_mcp_server(server) is True

    def test_safe_commands_accepted(self):
        """Validates all safe commands are accepted."""
        from core.client import _validate_custom_mcp_server

        safe_commands = ["npx", "npm", "node", "python", "python3", "uv", "uvx"]
        for cmd in safe_commands:
            server = {
                "id": f"test-{cmd}",
                "name": f"Test {cmd}",
                "type": "command",
                "command": cmd,
            }
            assert _validate_custom_mcp_server(server) is True, f"Command {cmd} should be valid"


class TestCustomMcpServerBuilding:
    """Tests for building MCP server configs from CUSTOM_MCP_SERVERS.

    These tests verify that custom MCP servers defined in .auto-claude/.env
    are correctly converted to the mcp_servers dict format used by the SDK.
    """

    def test_command_type_server_added(self):
        """Command-type custom MCP servers are added to mcp_servers."""
        from core.client import build_custom_mcp_servers

        custom_servers = [{
            "id": "my-command-server",
            "name": "My Command Server",
            "type": "command",
            "command": "npx",
            "args": ["-y", "my-mcp-server"],
        }]

        result = build_custom_mcp_servers(
            custom_servers,
            required_servers=["my-command-server"]
        )

        assert "my-command-server" in result
        assert result["my-command-server"]["command"] == "npx"
        assert result["my-command-server"]["args"] == ["-y", "my-mcp-server"]

    def test_http_type_server_added(self):
        """HTTP-type custom MCP servers are added to mcp_servers."""
        from core.client import build_custom_mcp_servers

        custom_servers = [{
            "id": "my-http-server",
            "name": "My HTTP Server",
            "type": "http",
            "url": "https://example.com/mcp",
        }]

        result = build_custom_mcp_servers(
            custom_servers,
            required_servers=["my-http-server"]
        )

        assert "my-http-server" in result
        assert result["my-http-server"]["type"] == "http"
        assert result["my-http-server"]["url"] == "https://example.com/mcp"

    def test_streamable_http_type_server_added(self):
        """Streamable-http-type custom MCP servers are added to mcp_servers.

        This is a regression test for the bug where streamable-http servers
        were validated but then silently dropped when building mcp_servers.
        """
        from core.client import build_custom_mcp_servers

        custom_servers = [{
            "id": "docker-mcp",
            "name": "Docker MCP",
            "type": "streamable-http",
            "url": "http://localhost:30000/mcp",
            "headers": {"Authorization": "Bearer test-token"},
        }]

        result = build_custom_mcp_servers(
            custom_servers,
            required_servers=["docker-mcp"]
        )

        assert "docker-mcp" in result, "streamable-http server should be added to mcp_servers"
        assert result["docker-mcp"]["type"] == "streamable-http"
        assert result["docker-mcp"]["url"] == "http://localhost:30000/mcp"
        assert result["docker-mcp"]["headers"] == {"Authorization": "Bearer test-token"}

    def test_http_server_with_headers(self):
        """HTTP servers with custom headers have headers preserved."""
        from core.client import build_custom_mcp_servers

        custom_servers = [{
            "id": "auth-http-server",
            "name": "Auth HTTP Server",
            "type": "http",
            "url": "https://api.example.com/mcp",
            "headers": {
                "Authorization": "Bearer my-token",
                "X-Custom-Header": "custom-value",
            },
        }]

        result = build_custom_mcp_servers(
            custom_servers,
            required_servers=["auth-http-server"]
        )

        assert result["auth-http-server"]["headers"]["Authorization"] == "Bearer my-token"
        assert result["auth-http-server"]["headers"]["X-Custom-Header"] == "custom-value"

    def test_server_not_in_required_servers_not_added(self):
        """Custom servers not in required_servers list are not added."""
        from core.client import build_custom_mcp_servers

        custom_servers = [{
            "id": "my-server",
            "name": "My Server",
            "type": "streamable-http",
            "url": "http://localhost:8000/mcp",
        }]

        # Server is defined but not in required_servers
        result = build_custom_mcp_servers(
            custom_servers,
            required_servers=["other-server"]  # my-server not included
        )

        assert "my-server" not in result

    def test_multiple_custom_servers(self):
        """Multiple custom servers of different types are all added."""
        from core.client import build_custom_mcp_servers

        custom_servers = [
            {
                "id": "command-server",
                "name": "Command Server",
                "type": "command",
                "command": "node",
                "args": ["server.js"],
            },
            {
                "id": "http-server",
                "name": "HTTP Server",
                "type": "http",
                "url": "https://api.example.com/mcp",
            },
            {
                "id": "streamable-server",
                "name": "Streamable Server",
                "type": "streamable-http",
                "url": "http://localhost:3000/mcp",
            },
        ]

        result = build_custom_mcp_servers(
            custom_servers,
            required_servers=["command-server", "http-server", "streamable-server"]
        )

        assert len(result) == 3
        assert "command-server" in result
        assert "http-server" in result
        assert "streamable-server" in result

        # Verify each type is correct
        assert "command" in result["command-server"]
        assert result["http-server"]["type"] == "http"
        assert result["streamable-server"]["type"] == "streamable-http"

    def test_server_without_id_skipped(self):
        """Servers without an id field are skipped."""
        from core.client import build_custom_mcp_servers

        custom_servers = [{
            "name": "No ID Server",
            "type": "http",
            "url": "https://example.com/mcp",
        }]

        result = build_custom_mcp_servers(
            custom_servers,
            required_servers=[]
        )

        assert len(result) == 0
