#!/usr/bin/env python3
"""
Tests for MCP Session Manager
=============================

Tests the MCPSessionManager class and related utilities in core/mcp_session.py
which manages session state for Streamable HTTP MCP servers.
"""

import pytest
import threading
import time


class TestMaskSessionId:
    """Tests for mask_session_id() function."""

    def test_masks_normal_session_id(self):
        """Masks session ID showing only first 4 characters."""
        from core.mcp_session import mask_session_id

        result = mask_session_id("abc123xyz789")
        assert result == "abc1****"

    def test_masks_short_session_id(self):
        """Masks short session IDs completely."""
        from core.mcp_session import mask_session_id

        result = mask_session_id("abc")
        assert result == "****"

    def test_masks_exactly_four_chars(self):
        """Masks session IDs with exactly 4 characters completely."""
        from core.mcp_session import mask_session_id

        result = mask_session_id("abcd")
        assert result == "****"

    def test_masks_five_chars(self):
        """Shows first 4 chars for 5+ character IDs."""
        from core.mcp_session import mask_session_id

        result = mask_session_id("abcde")
        assert result == "abcd****"

    def test_handles_none(self):
        """Returns <none> for None input."""
        from core.mcp_session import mask_session_id

        result = mask_session_id(None)
        assert result == "<none>"

    def test_handles_empty_string(self):
        """Returns <none> for empty string."""
        from core.mcp_session import mask_session_id

        result = mask_session_id("")
        assert result == "<none>"


class TestMCPSessionState:
    """Tests for MCPSessionState enum."""

    def test_all_states_defined(self):
        """Verifies all expected session states are defined."""
        from core.mcp_session import MCPSessionState

        assert MCPSessionState.DISCONNECTED.value == "disconnected"
        assert MCPSessionState.INITIALIZING.value == "initializing"
        assert MCPSessionState.ACTIVE.value == "active"
        assert MCPSessionState.RECONNECTING.value == "reconnecting"
        assert MCPSessionState.TERMINATING.value == "terminating"
        assert MCPSessionState.ERROR.value == "error"


class TestMCPSession:
    """Tests for MCPSession class."""

    def test_init_creates_disconnected_session(self):
        """Creates a new session in disconnected state."""
        from core.mcp_session import MCPSession, MCPSessionState

        session = MCPSession("https://example.com/mcp")
        assert session.server_url == "https://example.com/mcp"
        assert session.session_id is None
        assert session.state == MCPSessionState.DISCONNECTED
        assert session.established_at is None
        assert session.last_activity_at is None
        assert session.request_count == 0
        assert session.reinitialize_count == 0
        assert session.last_error is None

    def test_to_dict_serializes_session(self):
        """Serializes session to dictionary with both session_id and masked ID."""
        from core.mcp_session import MCPSession, MCPSessionState

        session = MCPSession("https://example.com/mcp")
        session.session_id = "test-session-12345"
        session.state = MCPSessionState.ACTIVE
        session.established_at = "2024-01-01T00:00:00Z"
        session.last_activity_at = "2024-01-01T01:00:00Z"
        session.request_count = 5
        session.reinitialize_count = 2
        session.last_error = "Connection lost"

        result = session.to_dict()

        assert result["server_url"] == "https://example.com/mcp"
        assert result["session_id"] == "test-session-12345"  # Actual ID for IPC
        assert result["session_id_masked"] == "test****"  # Masked ID for logging
        assert result["state"] == "active"
        assert result["established_at"] == "2024-01-01T00:00:00Z"
        assert result["last_activity_at"] == "2024-01-01T01:00:00Z"
        assert result["request_count"] == 5
        assert result["reinitialize_count"] == 2
        assert result["last_error"] == "Connection lost"

    def test_to_dict_masks_none_session_id(self):
        """Serializes session with None session ID."""
        from core.mcp_session import MCPSession

        session = MCPSession("https://example.com/mcp")
        result = session.to_dict()
        assert result["session_id"] is None  # Actual ID is None
        assert result["session_id_masked"] == "<none>"  # Masked representation

    def test_copy_creates_independent_session(self):
        """copy() creates an independent session with same values."""
        from core.mcp_session import MCPSession, MCPSessionState

        original = MCPSession("https://example.com/mcp")
        original.session_id = "test-session-12345"
        original.state = MCPSessionState.ACTIVE
        original.established_at = "2024-01-01T00:00:00Z"
        original.last_activity_at = "2024-01-01T01:00:00Z"
        original.request_count = 5
        original.reinitialize_count = 2
        original.last_error = "Connection lost"

        copied = original.copy()

        # Verify values are copied
        assert copied.server_url == original.server_url
        assert copied.session_id == original.session_id
        assert copied.state == original.state
        assert copied.established_at == original.established_at
        assert copied.last_activity_at == original.last_activity_at
        assert copied.request_count == original.request_count
        assert copied.reinitialize_count == original.reinitialize_count
        assert copied.last_error == original.last_error

        # Verify it's a different object
        assert copied is not original

    def test_copy_is_independent_from_original(self):
        """Modifying copy does not affect original."""
        from core.mcp_session import MCPSession, MCPSessionState

        original = MCPSession("https://example.com/mcp")
        original.session_id = "original-id"
        original.state = MCPSessionState.ACTIVE
        original.request_count = 5

        copied = original.copy()

        # Modify the copy
        copied.session_id = "modified-id"
        copied.state = MCPSessionState.ERROR
        copied.request_count = 100

        # Original should be unchanged
        assert original.session_id == "original-id"
        assert original.state == MCPSessionState.ACTIVE
        assert original.request_count == 5


class TestMCPSessionTerminateResult:
    """Tests for MCPSessionTerminateResult class."""

    def test_init_creates_result(self):
        """Creates termination result with correct attributes."""
        from core.mcp_session import MCPSessionTerminateResult

        result = MCPSessionTerminateResult(
            server_url="https://example.com/mcp",
            success=True,
            message="Terminated successfully",
        )
        assert result.server_url == "https://example.com/mcp"
        assert result.success is True
        assert result.message == "Terminated successfully"

    def test_to_dict_serializes_result(self):
        """Serializes termination result to dictionary."""
        from core.mcp_session import MCPSessionTerminateResult

        result = MCPSessionTerminateResult(
            server_url="https://example.com/mcp",
            success=False,
            message="No session exists",
        )
        data = result.to_dict()

        assert data["server_url"] == "https://example.com/mcp"
        assert data["success"] is False
        assert data["message"] == "No session exists"


class TestMCPSessionManager:
    """Tests for MCPSessionManager class."""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """Reset singleton before and after each test."""
        from core.mcp_session import reset_mcp_session_manager

        reset_mcp_session_manager()
        yield
        reset_mcp_session_manager()

    def test_get_session_returns_none_for_unknown_url(self):
        """Returns None when no session exists for URL."""
        from core.mcp_session import MCPSessionManager

        manager = MCPSessionManager()
        result = manager.get_session("https://unknown.com/mcp")
        assert result is None

    def test_get_session_returns_independent_copy(self):
        """get_session() returns a copy that doesn't affect manager state."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.ACTIVE,
        )

        # Get session and modify it
        session = manager.get_session("https://example.com/mcp")
        session.session_id = "modified-id"
        session.state = MCPSessionState.ERROR
        session.request_count = 999

        # Get fresh session - should have original values
        fresh_session = manager.get_session("https://example.com/mcp")
        assert fresh_session.session_id == "session-123"
        assert fresh_session.state == MCPSessionState.ACTIVE
        assert fresh_session.request_count == 0

    def test_set_session_creates_new_session(self):
        """Creates new session when none exists."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-12345",
            MCPSessionState.ACTIVE,
        )

        session = manager.get_session("https://example.com/mcp")
        assert session is not None
        assert session.session_id == "session-12345"
        assert session.state == MCPSessionState.ACTIVE
        assert session.established_at is not None
        assert session.last_activity_at is not None

    def test_set_session_updates_existing_session(self):
        """Updates existing session when one exists."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-old",
            MCPSessionState.ACTIVE,
        )

        # Update with new session ID
        manager.set_session(
            "https://example.com/mcp",
            "session-new",
            MCPSessionState.ACTIVE,
        )

        session = manager.get_session("https://example.com/mcp")
        assert session.session_id == "session-new"

    def test_set_session_tracks_reinitialize_count(self):
        """Increments reinitialize count when state is RECONNECTING."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.ACTIVE,
        )

        # Trigger reconnection
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.RECONNECTING,
        )

        session = manager.get_session("https://example.com/mcp")
        assert session.reinitialize_count == 1

    def test_set_session_resets_request_count_on_new_session_id(self):
        """Request count is reset when session ID changes.

        When a new session ID is provided for an ACTIVE session,
        request_count is reset to 0 since it's a fresh session.
        """
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-old",
            MCPSessionState.ACTIVE,
        )
        manager.increment_request_count("https://example.com/mcp")
        manager.increment_request_count("https://example.com/mcp")

        session = manager.get_session("https://example.com/mcp")
        assert session.request_count == 2

        # Updating with new session ID resets request count
        manager.set_session(
            "https://example.com/mcp",
            "session-new",
            MCPSessionState.ACTIVE,
        )

        session = manager.get_session("https://example.com/mcp")
        assert session.request_count == 0  # Count reset for new session

    def test_new_session_starts_with_zero_request_count(self):
        """New sessions start with request count of zero."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.ACTIVE,
        )

        session = manager.get_session("https://example.com/mcp")
        assert session.request_count == 0
        assert session.established_at is not None

    def test_get_session_id_returns_id_for_active_session(self):
        """Returns session ID for active sessions."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.ACTIVE,
        )

        result = manager.get_session_id("https://example.com/mcp")
        assert result == "session-123"

    def test_get_session_id_returns_none_for_inactive_session(self):
        """Returns None when session is not active."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.INITIALIZING,
        )

        result = manager.get_session_id("https://example.com/mcp")
        assert result is None

    def test_get_session_id_returns_none_for_unknown_url(self):
        """Returns None when no session exists."""
        from core.mcp_session import MCPSessionManager

        manager = MCPSessionManager()
        result = manager.get_session_id("https://unknown.com/mcp")
        assert result is None

    def test_get_all_sessions_returns_copy_of_list(self):
        """Returns a copy of the sessions list."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session("https://server1.com/mcp", "s1", MCPSessionState.ACTIVE)
        manager.set_session("https://server2.com/mcp", "s2", MCPSessionState.ACTIVE)

        sessions = manager.get_all_sessions()
        assert len(sessions) == 2

        # Verify it's a copy (modifying list doesn't affect manager)
        sessions.clear()
        assert len(manager.get_all_sessions()) == 2

    def test_get_all_sessions_returns_independent_session_copies(self):
        """Returned sessions are independent copies that don't affect manager state."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session("https://server1.com/mcp", "s1", MCPSessionState.ACTIVE)

        # Get sessions and modify them
        sessions = manager.get_all_sessions()
        sessions[0].session_id = "modified-id"
        sessions[0].state = MCPSessionState.ERROR

        # Fresh fetch should have original values
        fresh_sessions = manager.get_all_sessions()
        assert fresh_sessions[0].session_id == "s1"
        assert fresh_sessions[0].state == MCPSessionState.ACTIVE

    def test_update_state_changes_state(self):
        """Updates session state without changing session ID."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.ACTIVE,
        )

        manager.update_state("https://example.com/mcp", MCPSessionState.ERROR, "Connection failed")

        session = manager.get_session("https://example.com/mcp")
        assert session.state == MCPSessionState.ERROR
        assert session.session_id == "session-123"  # ID unchanged
        assert session.last_error == "Connection failed"

    def test_update_state_creates_new_session_if_needed(self):
        """Creates new session when updating state for unknown URL."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.update_state("https://new.com/mcp", MCPSessionState.ERROR, "Init failed")

        session = manager.get_session("https://new.com/mcp")
        assert session is not None
        assert session.state == MCPSessionState.ERROR
        assert session.last_error == "Init failed"

    def test_update_state_tracks_reinitialize_count(self):
        """Increments reinitialize count on RECONNECTING state."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.ACTIVE,
        )

        manager.update_state("https://example.com/mcp", MCPSessionState.RECONNECTING)
        manager.update_state("https://example.com/mcp", MCPSessionState.RECONNECTING)

        session = manager.get_session("https://example.com/mcp")
        assert session.reinitialize_count == 2

    def test_increment_request_count(self):
        """Increments request count and updates last activity."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.ACTIVE,
        )

        initial_activity = manager.get_session("https://example.com/mcp").last_activity_at

        # Small delay to ensure timestamp changes
        time.sleep(0.01)
        manager.increment_request_count("https://example.com/mcp")

        session = manager.get_session("https://example.com/mcp")
        assert session.request_count == 1
        assert session.last_activity_at >= initial_activity

    def test_increment_request_count_ignores_unknown_url(self):
        """Does nothing when incrementing for unknown URL."""
        from core.mcp_session import MCPSessionManager

        manager = MCPSessionManager()
        # Should not raise
        manager.increment_request_count("https://unknown.com/mcp")

    def test_clear_session(self):
        """Clears a single session."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.ACTIVE,
        )

        manager.clear_session("https://example.com/mcp")

        assert manager.get_session("https://example.com/mcp") is None

    def test_clear_session_ignores_unknown_url(self):
        """Does nothing when clearing unknown URL."""
        from core.mcp_session import MCPSessionManager

        manager = MCPSessionManager()
        # Should not raise
        manager.clear_session("https://unknown.com/mcp")

    def test_clear_all_sessions(self):
        """Clears all sessions."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session("https://server1.com/mcp", "s1", MCPSessionState.ACTIVE)
        manager.set_session("https://server2.com/mcp", "s2", MCPSessionState.ACTIVE)

        manager.clear_all_sessions()

        assert len(manager.get_all_sessions()) == 0

    def test_terminate_session_no_session(self):
        """Returns failure when no session exists."""
        from core.mcp_session import MCPSessionManager

        manager = MCPSessionManager()
        result = manager.terminate_session("https://unknown.com/mcp")

        assert result.success is False
        assert "No session exists" in result.message

    def test_terminate_session_no_session_id(self):
        """Clears session when no session ID exists."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            None,  # No session ID
            MCPSessionState.INITIALIZING,
        )

        result = manager.terminate_session("https://example.com/mcp")

        assert result.success is True
        assert "no session ID" in result.message
        assert manager.get_session("https://example.com/mcp") is None

    def test_terminate_session_marks_terminating(self):
        """Marks session as terminating when session ID exists."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.ACTIVE,
        )

        result = manager.terminate_session("https://example.com/mcp")

        assert result.success is True
        assert "termination initiated" in result.message
        session = manager.get_session("https://example.com/mcp")
        assert session.state == MCPSessionState.TERMINATING

    def test_termination_complete_clears_session(self):
        """Clears session after termination is complete."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session(
            "https://example.com/mcp",
            "session-123",
            MCPSessionState.TERMINATING,
        )

        manager.termination_complete("https://example.com/mcp", success=True, status_code=200)

        assert manager.get_session("https://example.com/mcp") is None

    def test_is_session_active(self):
        """Checks if session is active with session ID."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()

        # No session
        assert manager.is_session_active("https://example.com/mcp") is False

        # Session without ID
        manager.set_session("https://example.com/mcp", None, MCPSessionState.ACTIVE)
        assert manager.is_session_active("https://example.com/mcp") is False

        # Active session with ID
        manager.set_session("https://example.com/mcp", "session-123", MCPSessionState.ACTIVE)
        assert manager.is_session_active("https://example.com/mcp") is True

        # Non-active state
        manager.update_state("https://example.com/mcp", MCPSessionState.ERROR)
        assert manager.is_session_active("https://example.com/mcp") is False

    def test_get_active_session_count(self):
        """Counts only active sessions with session IDs."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()

        assert manager.get_active_session_count() == 0

        # Add active session
        manager.set_session("https://server1.com/mcp", "s1", MCPSessionState.ACTIVE)
        assert manager.get_active_session_count() == 1

        # Add another active session
        manager.set_session("https://server2.com/mcp", "s2", MCPSessionState.ACTIVE)
        assert manager.get_active_session_count() == 2

        # Add non-active session
        manager.set_session("https://server3.com/mcp", "s3", MCPSessionState.INITIALIZING)
        assert manager.get_active_session_count() == 2

        # Add session without ID
        manager.set_session("https://server4.com/mcp", None, MCPSessionState.ACTIVE)
        assert manager.get_active_session_count() == 2


class TestMCPSessionManagerListeners:
    """Tests for MCPSessionManager listener functionality."""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """Reset singleton before and after each test."""
        from core.mcp_session import reset_mcp_session_manager

        reset_mcp_session_manager()
        yield
        reset_mcp_session_manager()

    def test_add_listener_receives_notifications(self):
        """Listeners are notified of session state changes."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        notifications = []

        def listener(server_url, session):
            notifications.append((server_url, session.state))

        manager.add_listener(listener)
        manager.set_session("https://example.com/mcp", "s1", MCPSessionState.ACTIVE)

        assert len(notifications) == 1
        assert notifications[0] == ("https://example.com/mcp", MCPSessionState.ACTIVE)

    def test_unsubscribe_stops_notifications(self):
        """Unsubscribing stops listener from receiving notifications."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        notifications = []

        def listener(server_url, session):
            notifications.append(server_url)

        unsubscribe = manager.add_listener(listener)
        manager.set_session("https://server1.com/mcp", "s1", MCPSessionState.ACTIVE)

        unsubscribe()
        manager.set_session("https://server2.com/mcp", "s2", MCPSessionState.ACTIVE)

        assert len(notifications) == 1
        assert notifications[0] == "https://server1.com/mcp"

    def test_listener_exception_does_not_break_manager(self):
        """Manager continues working if listener raises exception."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        calls = []

        def bad_listener(server_url, session):
            raise RuntimeError("Listener error")

        def good_listener(server_url, session):
            calls.append(server_url)

        manager.add_listener(bad_listener)
        manager.add_listener(good_listener)

        # Should not raise, and good_listener should still be called
        manager.set_session("https://example.com/mcp", "s1", MCPSessionState.ACTIVE)

        assert len(calls) == 1

    def test_clear_session_notifies_listeners(self):
        """Listeners are notified when session is cleared."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session("https://example.com/mcp", "s1", MCPSessionState.ACTIVE)

        notifications = []

        def listener(server_url, session):
            notifications.append((server_url, session.state))

        manager.add_listener(listener)
        manager.clear_session("https://example.com/mcp")

        assert len(notifications) == 1
        assert notifications[0][1] == MCPSessionState.DISCONNECTED

    def test_clear_all_sessions_notifies_for_each(self):
        """Listeners are notified for each session when clearing all."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        manager.set_session("https://server1.com/mcp", "s1", MCPSessionState.ACTIVE)
        manager.set_session("https://server2.com/mcp", "s2", MCPSessionState.ACTIVE)

        notifications = []

        def listener(server_url, session):
            notifications.append(server_url)

        manager.add_listener(listener)
        manager.clear_all_sessions()

        assert len(notifications) == 2

    def test_listener_receives_copy_not_internal_reference(self):
        """Listeners receive a copy of the session, not the internal reference."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        received_sessions = []

        def listener(server_url, session):
            # Attempt to modify the session
            session.session_id = "listener-modified-id"
            session.state = MCPSessionState.ERROR
            received_sessions.append(session)

        manager.add_listener(listener)
        manager.set_session("https://example.com/mcp", "original-id", MCPSessionState.ACTIVE)

        # Verify listener received the session
        assert len(received_sessions) == 1
        assert received_sessions[0].session_id == "listener-modified-id"  # Listener modified it

        # Get fresh session from manager - should have original values
        session = manager.get_session("https://example.com/mcp")
        assert session.session_id == "original-id"
        assert session.state == MCPSessionState.ACTIVE


class TestMCPSessionManagerThreadSafety:
    """Tests for MCPSessionManager thread safety."""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """Reset singleton before and after each test."""
        from core.mcp_session import reset_mcp_session_manager

        reset_mcp_session_manager()
        yield
        reset_mcp_session_manager()

    def test_concurrent_set_sessions(self):
        """Handles concurrent session setting from multiple threads."""
        from core.mcp_session import MCPSessionManager, MCPSessionState

        manager = MCPSessionManager()
        errors = []

        def set_session(url, session_id):
            try:
                for _ in range(100):
                    manager.set_session(url, session_id, MCPSessionState.ACTIVE)
                    manager.get_session(url)
                    manager.increment_request_count(url)
            except Exception as e:
                errors.append(e)

        threads = [
            threading.Thread(target=set_session, args=(f"https://server{i}.com/mcp", f"s{i}"))
            for i in range(5)
        ]

        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(errors) == 0
        assert len(manager.get_all_sessions()) == 5


class TestSingletonFunctions:
    """Tests for singleton accessor functions."""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """Reset singleton before and after each test."""
        from core.mcp_session import reset_mcp_session_manager

        reset_mcp_session_manager()
        yield
        reset_mcp_session_manager()

    def test_get_mcp_session_manager_returns_same_instance(self):
        """get_mcp_session_manager returns the same instance."""
        from core.mcp_session import get_mcp_session_manager

        manager1 = get_mcp_session_manager()
        manager2 = get_mcp_session_manager()

        assert manager1 is manager2

    def test_reset_mcp_session_manager_creates_new_instance(self):
        """reset_mcp_session_manager creates a fresh instance."""
        from core.mcp_session import (
            get_mcp_session_manager,
            reset_mcp_session_manager,
            MCPSessionState,
        )

        manager1 = get_mcp_session_manager()
        manager1.set_session("https://example.com/mcp", "s1", MCPSessionState.ACTIVE)

        reset_mcp_session_manager()

        manager2 = get_mcp_session_manager()

        # Should be different instance
        assert manager1 is not manager2
        # New instance should have no sessions
        assert len(manager2.get_all_sessions()) == 0

    def test_reset_clears_sessions_before_destroying(self):
        """reset_mcp_session_manager clears sessions before creating new instance."""
        from core.mcp_session import (
            get_mcp_session_manager,
            reset_mcp_session_manager,
            MCPSessionState,
        )

        manager = get_mcp_session_manager()
        notifications = []

        def listener(server_url, session):
            notifications.append(server_url)

        manager.add_listener(listener)
        manager.set_session("https://example.com/mcp", "s1", MCPSessionState.ACTIVE)

        notifications.clear()
        reset_mcp_session_manager()

        # Listener should have been notified of clear
        assert len(notifications) == 1


# =============================================================================
# Tests for MCP Session IPC Handlers (services/mcp_session_ipc.py)
# =============================================================================


class TestHandleMCPSessionSet:
    """Tests for handle_mcp_session_set() IPC handler."""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """Reset singleton before and after each test."""
        from core.mcp_session import reset_mcp_session_manager

        reset_mcp_session_manager()
        yield
        reset_mcp_session_manager()

    def test_missing_server_url_returns_error(self):
        """Returns error when server_url is missing."""
        from services.mcp_session_ipc import handle_mcp_session_set

        result = handle_mcp_session_set({"state": "active"})

        assert result["success"] is False
        assert "server_url" in result["message"]
        assert result["session"] is None

    def test_missing_state_returns_error(self):
        """Returns error when state is missing."""
        from services.mcp_session_ipc import handle_mcp_session_set

        result = handle_mcp_session_set({"server_url": "https://example.com/mcp"})

        assert result["success"] is False
        assert "state" in result["message"]
        assert result["session"] is None

    def test_invalid_state_returns_error(self):
        """Returns error for invalid state value."""
        from services.mcp_session_ipc import handle_mcp_session_set

        result = handle_mcp_session_set({
            "server_url": "https://example.com/mcp",
            "state": "invalid_state",
        })

        assert result["success"] is False
        assert "Invalid state" in result["message"]
        assert "invalid_state" in result["message"]
        assert result["session"] is None

    def test_sets_session_with_session_id(self):
        """Successfully sets session with session_id."""
        from services.mcp_session_ipc import handle_mcp_session_set
        from core.mcp_session import get_mcp_session_manager

        result = handle_mcp_session_set({
            "server_url": "https://example.com/mcp",
            "session_id": "test-session-12345",
            "state": "active",
        })

        assert result["success"] is True
        assert result["message"] == "Session state updated"
        assert result["session"] is not None
        assert result["session"]["server_url"] == "https://example.com/mcp"
        assert result["session"]["state"] == "active"
        assert result["session"]["session_id"] == "test-session-12345"  # Actual ID for IPC
        assert result["session"]["session_id_masked"] == "test****"  # Masked ID for logging

        # Verify session was actually stored
        manager = get_mcp_session_manager()
        session = manager.get_session("https://example.com/mcp")
        assert session is not None
        assert session.session_id == "test-session-12345"

    def test_sets_session_without_session_id_for_initializing(self):
        """Sets session without session_id when state is initializing."""
        from services.mcp_session_ipc import handle_mcp_session_set
        from core.mcp_session import get_mcp_session_manager, MCPSessionState

        result = handle_mcp_session_set({
            "server_url": "https://example.com/mcp",
            "state": "initializing",
        })

        assert result["success"] is True
        assert result["session"] is not None
        assert result["session"]["state"] == "initializing"

        manager = get_mcp_session_manager()
        session = manager.get_session("https://example.com/mcp")
        assert session.state == MCPSessionState.INITIALIZING

    def test_updates_state_with_error_message(self):
        """Updates session state with error message."""
        from services.mcp_session_ipc import handle_mcp_session_set
        from core.mcp_session import get_mcp_session_manager, MCPSessionState

        # First create an active session
        handle_mcp_session_set({
            "server_url": "https://example.com/mcp",
            "session_id": "test-session-12345",
            "state": "active",
        })

        # Then update to error state
        result = handle_mcp_session_set({
            "server_url": "https://example.com/mcp",
            "state": "error",
            "error": "Connection failed",
        })

        assert result["success"] is True
        assert result["session"]["state"] == "error"
        assert result["session"]["last_error"] == "Connection failed"

        manager = get_mcp_session_manager()
        session = manager.get_session("https://example.com/mcp")
        assert session.state == MCPSessionState.ERROR
        assert session.last_error == "Connection failed"

    def test_handles_all_valid_states(self):
        """Successfully handles all valid session states."""
        from services.mcp_session_ipc import handle_mcp_session_set
        from core.mcp_session import MCPSessionState

        valid_states = [s.value for s in MCPSessionState]

        for state in valid_states:
            result = handle_mcp_session_set({
                "server_url": f"https://{state}.example.com/mcp",
                "session_id": f"session-{state}",
                "state": state,
            })
            assert result["success"] is True, f"Failed for state: {state}"
            assert result["session"]["state"] == state


class TestHandleMCPSessionGet:
    """Tests for handle_mcp_session_get() IPC handler."""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """Reset singleton before and after each test."""
        from core.mcp_session import reset_mcp_session_manager

        reset_mcp_session_manager()
        yield
        reset_mcp_session_manager()

    def test_missing_server_url_returns_error(self):
        """Returns error when server_url is missing."""
        from services.mcp_session_ipc import handle_mcp_session_get

        result = handle_mcp_session_get({})

        assert result["success"] is False
        assert "server_url" in result["message"]
        assert result["session"] is None

    def test_returns_none_for_unknown_server(self):
        """Returns None session for unknown server URL."""
        from services.mcp_session_ipc import handle_mcp_session_get

        result = handle_mcp_session_get({
            "server_url": "https://unknown.example.com/mcp",
        })

        assert result["success"] is True
        assert "No session exists" in result["message"]
        assert result["session"] is None

    def test_returns_existing_session(self):
        """Returns existing session data."""
        from services.mcp_session_ipc import handle_mcp_session_get, handle_mcp_session_set

        # First create a session
        handle_mcp_session_set({
            "server_url": "https://example.com/mcp",
            "session_id": "test-session-12345",
            "state": "active",
        })

        # Then retrieve it
        result = handle_mcp_session_get({
            "server_url": "https://example.com/mcp",
        })

        assert result["success"] is True
        assert result["message"] == "Session retrieved"
        assert result["session"] is not None
        assert result["session"]["server_url"] == "https://example.com/mcp"
        assert result["session"]["session_id"] == "test-session-12345"  # Actual ID for IPC
        assert result["session"]["session_id_masked"] == "test****"  # Masked ID for logging
        assert result["session"]["state"] == "active"


class TestHandleMCPSessionGetAll:
    """Tests for handle_mcp_session_get_all() IPC handler."""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """Reset singleton before and after each test."""
        from core.mcp_session import reset_mcp_session_manager

        reset_mcp_session_manager()
        yield
        reset_mcp_session_manager()

    def test_returns_empty_list_when_no_sessions(self):
        """Returns empty list when no sessions exist."""
        from services.mcp_session_ipc import handle_mcp_session_get_all

        result = handle_mcp_session_get_all({})

        assert result["success"] is True
        assert "Retrieved 0 sessions" in result["message"]
        assert result["sessions"] == []

    def test_returns_all_sessions(self):
        """Returns all existing sessions."""
        from services.mcp_session_ipc import handle_mcp_session_get_all, handle_mcp_session_set

        # Create multiple sessions
        handle_mcp_session_set({
            "server_url": "https://server1.example.com/mcp",
            "session_id": "session-1",
            "state": "active",
        })
        handle_mcp_session_set({
            "server_url": "https://server2.example.com/mcp",
            "session_id": "session-2",
            "state": "active",
        })
        handle_mcp_session_set({
            "server_url": "https://server3.example.com/mcp",
            "session_id": "session-3",
            "state": "initializing",
        })

        result = handle_mcp_session_get_all({})

        assert result["success"] is True
        assert "Retrieved 3 sessions" in result["message"]
        assert len(result["sessions"]) == 3

        # Verify session URLs are present
        urls = [s["server_url"] for s in result["sessions"]]
        assert "https://server1.example.com/mcp" in urls
        assert "https://server2.example.com/mcp" in urls
        assert "https://server3.example.com/mcp" in urls

    def test_sessions_have_masked_ids(self):
        """Returned sessions have masked session IDs."""
        from services.mcp_session_ipc import handle_mcp_session_get_all, handle_mcp_session_set

        handle_mcp_session_set({
            "server_url": "https://example.com/mcp",
            "session_id": "secret-session-id-12345",
            "state": "active",
        })

        result = handle_mcp_session_get_all({})

        assert result["sessions"][0]["session_id_masked"] == "secr****"
        assert "secret-session-id-12345" not in str(result)


class TestHandleMCPSessionTerminate:
    """Tests for handle_mcp_session_terminate() IPC handler."""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """Reset singleton before and after each test."""
        from core.mcp_session import reset_mcp_session_manager

        reset_mcp_session_manager()
        yield
        reset_mcp_session_manager()

    def test_missing_server_url_returns_error(self):
        """Returns error when server_url is missing."""
        from services.mcp_session_ipc import handle_mcp_session_terminate

        result = handle_mcp_session_terminate({})

        assert result["success"] is False
        assert "server_url" in result["message"]
        assert result["result"] is None

    def test_terminate_nonexistent_session_fails(self):
        """Terminating non-existent session returns failure."""
        from services.mcp_session_ipc import handle_mcp_session_terminate

        result = handle_mcp_session_terminate({
            "server_url": "https://unknown.example.com/mcp",
        })

        assert result["success"] is False
        assert "No session exists" in result["message"]
        assert result["result"] is not None
        assert result["result"]["success"] is False

    def test_terminate_active_session_succeeds(self):
        """Terminating active session initiates termination."""
        from services.mcp_session_ipc import handle_mcp_session_terminate, handle_mcp_session_set
        from core.mcp_session import get_mcp_session_manager, MCPSessionState

        # Create an active session
        handle_mcp_session_set({
            "server_url": "https://example.com/mcp",
            "session_id": "test-session-12345",
            "state": "active",
        })

        # Terminate it
        result = handle_mcp_session_terminate({
            "server_url": "https://example.com/mcp",
        })

        assert result["success"] is True
        assert "termination initiated" in result["message"]
        assert result["result"] is not None
        assert result["result"]["success"] is True

        # Verify session state changed to terminating
        manager = get_mcp_session_manager()
        session = manager.get_session("https://example.com/mcp")
        assert session.state == MCPSessionState.TERMINATING

    def test_terminate_session_without_id_clears_session(self):
        """Terminating session without ID clears it directly."""
        from services.mcp_session_ipc import handle_mcp_session_terminate, handle_mcp_session_set
        from core.mcp_session import get_mcp_session_manager

        # Create a session without ID
        handle_mcp_session_set({
            "server_url": "https://example.com/mcp",
            "state": "initializing",
        })

        # Terminate it
        result = handle_mcp_session_terminate({
            "server_url": "https://example.com/mcp",
        })

        assert result["success"] is True
        assert "no session ID" in result["message"]

        # Verify session was cleared
        manager = get_mcp_session_manager()
        session = manager.get_session("https://example.com/mcp")
        assert session is None


class TestDispatchMCPSessionMessage:
    """Tests for dispatch_mcp_session_message() function."""

    @pytest.fixture(autouse=True)
    def reset_singleton(self):
        """Reset singleton before and after each test."""
        from core.mcp_session import reset_mcp_session_manager

        reset_mcp_session_manager()
        yield
        reset_mcp_session_manager()

    def test_missing_type_returns_error(self):
        """Returns error when message type is missing."""
        from services.mcp_session_ipc import dispatch_mcp_session_message

        result = dispatch_mcp_session_message({
            "server_url": "https://example.com/mcp",
        })

        assert result["success"] is False
        assert "Missing required field: type" in result["message"]
        assert result["error"] == "MISSING_TYPE"

    def test_unknown_type_returns_error(self):
        """Returns error for unknown message type."""
        from services.mcp_session_ipc import dispatch_mcp_session_message

        result = dispatch_mcp_session_message({
            "type": "mcp:session:unknown",
            "server_url": "https://example.com/mcp",
        })

        assert result["success"] is False
        assert "Unknown message type" in result["message"]
        assert result["error"] == "UNKNOWN_TYPE"

    def test_dispatches_session_set(self):
        """Correctly dispatches mcp:session:set messages."""
        from services.mcp_session_ipc import dispatch_mcp_session_message

        result = dispatch_mcp_session_message({
            "type": "mcp:session:set",
            "server_url": "https://example.com/mcp",
            "session_id": "test-session-12345",
            "state": "active",
        })

        assert result["success"] is True
        assert result["session"]["state"] == "active"

    def test_dispatches_session_get(self):
        """Correctly dispatches mcp:session:get messages."""
        from services.mcp_session_ipc import dispatch_mcp_session_message

        # First create a session
        dispatch_mcp_session_message({
            "type": "mcp:session:set",
            "server_url": "https://example.com/mcp",
            "session_id": "test-session-12345",
            "state": "active",
        })

        # Then get it
        result = dispatch_mcp_session_message({
            "type": "mcp:session:get",
            "server_url": "https://example.com/mcp",
        })

        assert result["success"] is True
        assert result["session"] is not None

    def test_dispatches_session_get_all(self):
        """Correctly dispatches mcp:session:getAll messages."""
        from services.mcp_session_ipc import dispatch_mcp_session_message

        # Create a session
        dispatch_mcp_session_message({
            "type": "mcp:session:set",
            "server_url": "https://example.com/mcp",
            "session_id": "test-session-12345",
            "state": "active",
        })

        result = dispatch_mcp_session_message({
            "type": "mcp:session:getAll",
        })

        assert result["success"] is True
        assert len(result["sessions"]) == 1

    def test_dispatches_session_terminate(self):
        """Correctly dispatches mcp:session:terminate messages."""
        from services.mcp_session_ipc import dispatch_mcp_session_message

        # Create a session
        dispatch_mcp_session_message({
            "type": "mcp:session:set",
            "server_url": "https://example.com/mcp",
            "session_id": "test-session-12345",
            "state": "active",
        })

        result = dispatch_mcp_session_message({
            "type": "mcp:session:terminate",
            "server_url": "https://example.com/mcp",
        })

        assert result["success"] is True
        assert "termination initiated" in result["message"]

    def test_strips_type_from_data(self):
        """Type field is stripped before passing to handler."""
        from services.mcp_session_ipc import dispatch_mcp_session_message

        # If type wasn't stripped, it would be passed to handler and potentially cause issues
        result = dispatch_mcp_session_message({
            "type": "mcp:session:set",
            "server_url": "https://example.com/mcp",
            "session_id": "test-session-12345",
            "state": "active",
        })

        # The fact that this succeeds indicates type was properly stripped
        assert result["success"] is True


class TestMCPSessionHandlersRegistry:
    """Tests for MCP_SESSION_HANDLERS registry."""

    def test_all_handlers_registered(self):
        """All expected handlers are in the registry."""
        from services.mcp_session_ipc import MCP_SESSION_HANDLERS

        expected_handlers = [
            "mcp:session:set",
            "mcp:session:get",
            "mcp:session:getAll",
            "mcp:session:terminate",
        ]

        for handler_type in expected_handlers:
            assert handler_type in MCP_SESSION_HANDLERS, f"Missing handler: {handler_type}"

    def test_handlers_are_callable(self):
        """All registered handlers are callable."""
        from services.mcp_session_ipc import MCP_SESSION_HANDLERS

        for handler_type, handler in MCP_SESSION_HANDLERS.items():
            assert callable(handler), f"Handler {handler_type} is not callable"

    def test_handler_count_matches_expected(self):
        """Registry has exactly the expected number of handlers."""
        from services.mcp_session_ipc import MCP_SESSION_HANDLERS

        assert len(MCP_SESSION_HANDLERS) == 4
