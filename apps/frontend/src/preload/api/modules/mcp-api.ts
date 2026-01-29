/**
 * MCP Server API
 *
 * Exposes MCP health check, connection test, and session management functionality to the renderer.
 */

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../../../shared/constants/ipc';
import type { IPCResult } from '../../../shared/types/common';
import type {
  CustomMcpServer,
  McpHealthCheckResult,
  McpSessionStatus,
  McpSessionTerminateResult,
  McpTestConnectionResult,
} from '../../../shared/types/project';

export interface McpAPI {
  /** Quick health check for a custom MCP server */
  checkMcpHealth: (server: CustomMcpServer) => Promise<IPCResult<McpHealthCheckResult>>;
  /** Full MCP connection test */
  testMcpConnection: (server: CustomMcpServer) => Promise<IPCResult<McpTestConnectionResult>>;
  /** Get session status for a server URL */
  getSessionStatus: (serverUrl: string) => Promise<IPCResult<McpSessionStatus | null>>;
  /** Get all active MCP sessions */
  getAllSessions: () => Promise<IPCResult<McpSessionStatus[]>>;
  /** Terminate MCP session for a server URL */
  terminateSession: (serverUrl: string) => Promise<IPCResult<McpSessionTerminateResult>>;
}

export function createMcpAPI(): McpAPI {
  return {
    checkMcpHealth: (server: CustomMcpServer) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_CHECK_HEALTH, server),

    testMcpConnection: (server: CustomMcpServer) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_TEST_CONNECTION, server),

    getSessionStatus: (serverUrl: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_SESSION_GET_STATUS, serverUrl),

    getAllSessions: () =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_SESSION_GET_ALL),

    terminateSession: (serverUrl: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_SESSION_TERMINATE, serverUrl),
  };
}
