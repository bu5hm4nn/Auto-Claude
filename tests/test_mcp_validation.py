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
