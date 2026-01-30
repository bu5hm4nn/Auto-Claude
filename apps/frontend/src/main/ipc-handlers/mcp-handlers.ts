/**
 * MCP Server Health Check Handlers
 *
 * Handles IPC requests for checking MCP server health and connectivity.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/ipc';
import type { CustomMcpServer, McpHealthCheckResult, McpHealthStatus, McpTestConnectionResult } from '../../shared/types/project';
import { spawn } from 'child_process';
import { appLog } from '../app-logger';
import { isWindows } from '../platform';

/**
 * Defense-in-depth: Frontend-side command validation
 * Mirrors the backend SAFE_COMMANDS allowlist to prevent arbitrary command execution
 * even if malicious configs somehow bypass backend validation
 */
const SAFE_COMMANDS = new Set(['npx', 'npm', 'node', 'python', 'python3', 'uv', 'uvx']);

/**
 * Defense-in-depth: Dangerous interpreter flags that allow code execution
 * Mirrors backend DANGEROUS_FLAGS to prevent args-based code injection
 */
const DANGEROUS_FLAGS = new Set([
  '--eval', '-e', '-c', '--exec',
  '-m', '-p', '--print',
  '--input-type=module', '--experimental-loader',
  '--require', '-r'
]);

/**
 * Defense-in-depth: Shell metacharacters that could enable command injection
 * when shell: true is used on Windows
 */
const SHELL_METACHARACTERS = ['&', '|', '>', '<', '^', '%', ';', '$', '`', '\n', '\r'];

/**
 * Validate that a command is in the safe allowlist
 */
export function isCommandSafe(command: string | undefined): boolean {
  if (!command) return false;
  // Reject commands with paths (defense against path traversal)
  if (command.includes('/') || command.includes('\\')) return false;
  return SAFE_COMMANDS.has(command);
}

/**
 * Validate that args don't contain dangerous interpreter flags or shell metacharacters
 */
export function areArgsSafe(args: string[] | undefined): boolean {
  if (!args || args.length === 0) return true;

  // Check for dangerous interpreter flags
  if (args.some(arg => DANGEROUS_FLAGS.has(arg))) return false;

  // On Windows with shell: true, check for shell metacharacters that could enable injection
  if (isWindows()) {
    if (args.some(arg => SHELL_METACHARACTERS.some(char => arg.includes(char)))) {
      return false;
    }
  }

  return true;
}

/**
 * Defense-in-depth: URL validation to prevent SSRF attacks
 * Validates that URLs used in MCP HTTP handlers don't target internal/private networks
 */
export function isUrlAllowed(url: string): { allowed: boolean; reason?: string } {
  try {
    const parsed = new URL(url);

    // Only allow http/https protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { allowed: false, reason: 'Only HTTP/HTTPS URLs are allowed' };
    }

    // Block embedded credentials to prevent credential leakage
    if (parsed.username || parsed.password) {
      return { allowed: false, reason: 'URLs with embedded credentials are not allowed' };
    }

    // Allow localhost explicitly for local MCP servers
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return { allowed: true };
    }

    // Block private IP ranges to prevent SSRF attacks on internal networks
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      // Block Class A private (10.0.0.0/8)
      // Block link-local/cloud metadata (169.254.0.0/16)
      // Block Class C private (192.168.0.0/16)
      // Block Class B private (172.16.0.0/12)
      if (a === 10 ||
          (a === 169 && b === 254) ||
          (a === 192 && b === 168) ||
          (a === 172 && b >= 16 && b <= 31)) {
        return { allowed: false, reason: 'Private IP addresses are not allowed (except localhost)' };
      }
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: 'Invalid URL' };
  }
}

/**
 * Map raw network error messages to user-friendly messages.
 * This prevents exposing internal error details to users.
 */
export function mapNetworkErrorToMessage(errorMessage: string): string {
  if (errorMessage.includes('abort') || errorMessage.includes('timeout')) {
    return 'Connection timed out';
  } else if (errorMessage.includes('ECONNREFUSED')) {
    return 'Connection refused - server may be down';
  } else if (errorMessage.includes('ENOTFOUND')) {
    return 'Server not found - check URL';
  }
  return 'Connection failed';
}

/**
 * Quick health check for a custom MCP server.
 * For HTTP servers: makes a HEAD/GET request to check connectivity.
 * For Streamable HTTP servers: uses proper Accept header for MCP protocol.
 * For command servers: checks if the command exists.
 */
async function checkMcpHealth(server: CustomMcpServer): Promise<McpHealthCheckResult> {
  const startTime = Date.now();

  if (server.type === 'streamable-http') {
    return checkStreamableHttpHealth(server, startTime);
  } else if (server.type === 'http') {
    return checkHttpHealth(server, startTime);
  } else if (server.type === 'command') {
    return checkCommandHealth(server, startTime);
  } else {
    // Explicit handling for unknown types
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: `Unsupported server type: ${server.type}`,
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check HTTP server health by making a request.
 */
async function checkHttpHealth(server: CustomMcpServer, startTime: number): Promise<McpHealthCheckResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'No URL configured',
      checkedAt: new Date().toISOString(),
    };
  }

  // Defense-in-depth: Validate URL to prevent SSRF attacks
  const urlValidation = isUrlAllowed(server.url);
  if (!urlValidation.allowed) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: urlValidation.reason || 'URL not allowed',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const headers: Record<string, string> = {
      'Accept': 'application/json',
    };

    // Add custom headers if configured
    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    const response = await fetch(server.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    let status: McpHealthStatus;
    let message: string;

    if (response.ok) {
      status = 'healthy';
      message = 'Server is responding';
    } else if (response.status === 401 || response.status === 403) {
      status = 'needs_auth';
      message = response.status === 401 ? 'Authentication required' : 'Access forbidden';
    } else {
      status = 'unhealthy';
      message = `HTTP ${response.status}: ${response.statusText}`;
    }

    return {
      serverId: server.id,
      status,
      statusCode: response.status,
      message,
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      serverId: server.id,
      status: 'unhealthy',
      message: mapNetworkErrorToMessage(errorMessage),
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check Streamable HTTP server health by making a request with proper MCP Accept header.
 * Streamable HTTP servers (MCP spec 2025-03-26) support both JSON and SSE responses.
 */
async function checkStreamableHttpHealth(server: CustomMcpServer, startTime: number): Promise<McpHealthCheckResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'No URL configured',
      checkedAt: new Date().toISOString(),
    };
  }

  // Defense-in-depth: Validate URL to prevent SSRF attacks
  const urlValidation = isUrlAllowed(server.url);
  if (!urlValidation.allowed) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: urlValidation.reason || 'URL not allowed',
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    // Streamable HTTP requires Accept header with both JSON and SSE support
    const headers: Record<string, string> = {
      'Accept': 'application/json, text/event-stream',
    };

    // Add custom headers if configured
    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    const response = await fetch(server.url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    let status: McpHealthStatus;
    let message: string;

    if (response.ok) {
      status = 'healthy';
      message = 'Streamable HTTP server is responding';
    } else if (response.status === 401 || response.status === 403) {
      status = 'needs_auth';
      message = response.status === 401 ? 'Authentication required' : 'Access forbidden';
    } else {
      status = 'unhealthy';
      message = `HTTP ${response.status}: ${response.statusText}`;
    }

    return {
      serverId: server.id,
      status,
      statusCode: response.status,
      message,
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      serverId: server.id,
      status: 'unhealthy',
      message: mapNetworkErrorToMessage(errorMessage),
      responseTime,
      checkedAt: new Date().toISOString(),
    };
  }
}

/**
 * Check command-based server health by verifying the command exists.
 */
async function checkCommandHealth(server: CustomMcpServer, startTime: number): Promise<McpHealthCheckResult> {
  if (!server.command) {
    return {
      serverId: server.id,
      status: 'unhealthy',
      message: 'No command configured',
      checkedAt: new Date().toISOString(),
    };
  }

  return new Promise((resolve) => {
    // Defense-in-depth: Validate command and args before spawn
    if (!isCommandSafe(server.command)) {
      return resolve({
        serverId: server.id,
        status: 'unhealthy',
        message: `Invalid command '${server.command}' - not in allowlist`,
        checkedAt: new Date().toISOString(),
      });
    }
    if (!areArgsSafe(server.args)) {
      return resolve({
        serverId: server.id,
        status: 'unhealthy',
        message: 'Args contain dangerous flags or shell metacharacters',
        checkedAt: new Date().toISOString(),
      });
    }

    const command = isWindows() ? 'where' : 'which';
    const proc = spawn(command, [server.command!], {
      timeout: 5000,
    });

    let found = false;

    proc.on('close', (code) => {
      const responseTime = Date.now() - startTime;

      if (code === 0 || found) {
        resolve({
          serverId: server.id,
          status: 'healthy',
          message: `Command '${server.command}' found`,
          responseTime,
          checkedAt: new Date().toISOString(),
        });
      } else {
        resolve({
          serverId: server.id,
          status: 'unhealthy',
          message: `Command '${server.command}' not found in PATH`,
          responseTime,
          checkedAt: new Date().toISOString(),
        });
      }
    });

    proc.stdout.on('data', () => {
      found = true;
    });

    proc.on('error', () => {
      const responseTime = Date.now() - startTime;
      resolve({
        serverId: server.id,
        status: 'unhealthy',
        message: `Failed to check command '${server.command}'`,
        responseTime,
        checkedAt: new Date().toISOString(),
      });
    });
  });
}

/**
 * Full MCP connection test - actually connects to the server and tries to list tools.
 * This is more thorough but slower than the health check.
 */
async function testMcpConnection(server: CustomMcpServer): Promise<McpTestConnectionResult> {
  const startTime = Date.now();

  if (server.type === 'streamable-http') {
    return testStreamableHttpConnection(server, startTime);
  } else if (server.type === 'http') {
    return testHttpConnection(server, startTime);
  } else if (server.type === 'command') {
    return testCommandConnection(server, startTime);
  } else {
    // Explicit handling for unknown types
    return {
      serverId: server.id,
      success: false,
      message: `Unsupported server type: ${server.type}`,
    };
  }
}

/**
 * Test HTTP MCP server connection by sending an MCP initialize request.
 */
async function testHttpConnection(server: CustomMcpServer, startTime: number): Promise<McpTestConnectionResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      success: false,
      message: 'No URL configured',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    };

    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    // Send MCP initialize request
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'auto-claude-health-check',
          version: '1.0.0',
        },
      },
    };

    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(initRequest),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          serverId: server.id,
          success: false,
          message: 'Authentication failed',
          responseTime,
        };
      }
      return {
        serverId: server.id,
        success: false,
        message: `Server returned HTTP ${response.status}`,
        responseTime,
      };
    }

    const data = await response.json();

    if (data.error) {
      return {
        serverId: server.id,
        success: false,
        message: 'MCP protocol error',
        responseTime,
      };
    }

    // Now try to list tools (with separate timeout)
    const toolsController = new AbortController();
    const toolsTimeout = setTimeout(() => toolsController.abort(), 10000);

    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    let tools: string[] = [];
    try {
      const toolsResponse = await fetch(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(toolsRequest),
        signal: toolsController.signal,
      });

      clearTimeout(toolsTimeout);

      if (toolsResponse.ok) {
        const toolsData = await toolsResponse.json();
        if (toolsData.result?.tools) {
          tools = toolsData.result.tools.map((t: { name: string }) => t.name);
        }
      }
    } catch (toolsError) {
      // Tools listing is optional - don't fail the connection test
      clearTimeout(toolsTimeout);
      appLog.debug(`MCP tools/list request failed for ${server.id}:`, toolsError);
    }

    return {
      serverId: server.id,
      success: true,
      message: tools.length > 0 ? `Connected successfully, ${tools.length} tools available` : 'Connected successfully',
      tools,
      responseTime,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      serverId: server.id,
      success: false,
      message: mapNetworkErrorToMessage(errorMessage),
      responseTime,
    };
  }
}

/**
 * Test Streamable HTTP MCP server connection by sending an MCP initialize request.
 * Uses MCP protocol version 2025-03-26 and proper Accept header for streaming support.
 */
async function testStreamableHttpConnection(server: CustomMcpServer, startTime: number): Promise<McpTestConnectionResult> {
  if (!server.url) {
    return {
      serverId: server.id,
      success: false,
      message: 'No URL configured',
    };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    // Streamable HTTP requires Accept header with both JSON and SSE support
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    // Send MCP initialize request with Streamable HTTP protocol version
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: {
          name: 'auto-claude-health-check',
          version: '1.0.0',
        },
      },
    };

    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(initRequest),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const responseTime = Date.now() - startTime;

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        return {
          serverId: server.id,
          success: false,
          message: 'Authentication failed',
          responseTime,
        };
      }
      return {
        serverId: server.id,
        success: false,
        message: `Server returned HTTP ${response.status}`,
        responseTime,
      };
    }

    const data = await response.json();

    if (data.error) {
      return {
        serverId: server.id,
        success: false,
        message: 'MCP protocol error',
        responseTime,
      };
    }

    // Now try to list tools (with separate timeout)
    const toolsController = new AbortController();
    const toolsTimeout = setTimeout(() => toolsController.abort(), 10000);

    const toolsRequest = {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    };

    let tools: string[] = [];
    try {
      const toolsResponse = await fetch(server.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(toolsRequest),
        signal: toolsController.signal,
      });

      clearTimeout(toolsTimeout);

      if (toolsResponse.ok) {
        const toolsData = await toolsResponse.json();
        if (toolsData.result?.tools) {
          tools = toolsData.result.tools.map((t: { name: string }) => t.name);
        }
      }
    } catch (toolsError) {
      // Tools listing is optional - don't fail the connection test
      clearTimeout(toolsTimeout);
      appLog.debug(`MCP tools/list request failed for ${server.id}:`, toolsError);
    }

    return {
      serverId: server.id,
      success: true,
      message: tools.length > 0 ? `Connected successfully, ${tools.length} tools available` : 'Connected successfully (Streamable HTTP)',
      tools,
      responseTime,
    };
  } catch (error) {
    const responseTime = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    return {
      serverId: server.id,
      success: false,
      message: mapNetworkErrorToMessage(errorMessage),
      responseTime,
    };
  }
}

/**
 * Test command-based MCP server connection by spawning the process and trying to communicate.
 */
async function testCommandConnection(server: CustomMcpServer, startTime: number): Promise<McpTestConnectionResult> {
  if (!server.command) {
    return {
      serverId: server.id,
      success: false,
      message: 'No command configured',
    };
  }

  return new Promise((resolve) => {
    // Defense-in-depth: Validate command and args before spawn
    if (!isCommandSafe(server.command)) {
      return resolve({
        serverId: server.id,
        success: false,
        message: `Invalid command '${server.command}' - not in allowlist`,
      });
    }
    if (!areArgsSafe(server.args)) {
      return resolve({
        serverId: server.id,
        success: false,
        message: 'Args contain dangerous flags or shell metacharacters',
      });
    }

    const args = server.args || [];

    // On Windows, use shell: true to properly handle .cmd/.bat scripts like npx
    const proc = spawn(server.command!, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000, // OS-level timeout for reliable process termination
      shell: isWindows(), // Required for Windows to run npx.cmd
    });

    let stdout = '';
    let stderr = '';
    let resolved = false;

    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.kill();
        const responseTime = Date.now() - startTime;
        resolve({
          serverId: server.id,
          success: false,
          message: 'Connection timed out',
          responseTime,
        });
      }
    }, 15000); // 15 second timeout (matches spawn timeout)

    // Send MCP initialize request
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'auto-claude-health-check',
          version: '1.0.0',
        },
      },
    }) + '\n';

    proc.stdin.write(initRequest);

    proc.stdout.on('data', (data) => {
      stdout += data.toString('utf-8');

      // Try to parse JSON response
      try {
        const lines = stdout.split('\n').filter(l => l.trim());
        for (const line of lines) {
          const response = JSON.parse(line);
          if (response.id === 1 && response.result) {
            if (!resolved) {
              resolved = true;
              clearTimeout(timeoutId);
              proc.kill();
              const responseTime = Date.now() - startTime;
              resolve({
                serverId: server.id,
                success: true,
                message: 'MCP server started successfully',
                responseTime,
              });
            }
            return;
          }
        }
      } catch {
        // Not valid JSON yet, keep waiting
      }
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString('utf-8');
    });

    proc.on('error', (error) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const responseTime = Date.now() - startTime;
        resolve({
          serverId: server.id,
          success: false,
          message: 'Failed to start server',
          error: error.message,
          responseTime,
        });
      }
    });

    proc.on('close', (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeoutId);
        const responseTime = Date.now() - startTime;
        if (code === 0) {
          resolve({
            serverId: server.id,
            success: true,
            message: 'Server process started',
            responseTime,
          });
        } else {
          resolve({
            serverId: server.id,
            success: false,
            message: `Server exited with code ${code}`,
            error: stderr || undefined,
            responseTime,
          });
        }
      }
    });
  });
}

/**
 * Register MCP IPC handlers.
 */
export function registerMcpHandlers(): void {
  // Quick health check
  ipcMain.handle(IPC_CHANNELS.MCP_CHECK_HEALTH, async (_event, server: CustomMcpServer) => {
    try {
      const result = await checkMcpHealth(server);
      return { success: true, data: result };
    } catch (error) {
      appLog.error('MCP health check error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Health check failed',
      };
    }
  });

  // Full connection test
  ipcMain.handle(IPC_CHANNELS.MCP_TEST_CONNECTION, async (_event, server: CustomMcpServer) => {
    try {
      const result = await testMcpConnection(server);
      return { success: true, data: result };
    } catch (error) {
      appLog.error('MCP connection test error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Connection test failed',
      };
    }
  });
}
