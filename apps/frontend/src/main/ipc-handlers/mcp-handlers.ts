/**
 * MCP Server Health Check Handlers
 *
 * Handles IPC requests for checking MCP server health and connectivity.
 */

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants/ipc';
import type { CustomMcpServer, McpHealthCheckResult, McpHealthStatus, McpTestConnectionResult } from '../../shared/types/project';
import { spawn } from 'child_process';
import net from 'net';
import os from 'os';
import { appLog } from '../app-logger';
import { isWindows } from '../platform';
import { getWhereExePath } from '../utils/windows-paths';

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
 * Represents a local network subnet that this machine is connected to.
 */
interface LocalSubnet {
  address: number;  // IP as 32-bit unsigned integer
  mask: number;     // Netmask as 32-bit unsigned integer
}

/**
 * Cached local subnets to avoid repeated os.networkInterfaces() calls.
 * Cache is acceptable for security: worst case is a newly added subnet
 * is blocked until app restart.
 */
let cachedLocalSubnets: LocalSubnet[] | null = null;

/**
 * Convert an IPv4 address string to a 32-bit unsigned integer.
 * Returns -1 for invalid IP addresses.
 * Uses Node.js net.isIPv4() for validation.
 */
export function ipToInt(ip: string): number {
  if (!net.isIPv4(ip)) return -1;

  const octets = ip.split('.').map(Number);
  return octets.reduce((acc, octet) => (acc << 8) + octet, 0) >>> 0;
}

/**
 * Get all local subnets that this machine is directly connected to.
 * Uses os.networkInterfaces() to discover network configuration.
 */
export function getLocalSubnets(): LocalSubnet[] {
  if (cachedLocalSubnets) return cachedLocalSubnets;

  const subnets: LocalSubnet[] = [];
  const interfaces = os.networkInterfaces();

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const info of iface) {
      // Only consider external (non-loopback) IPv4 interfaces
      if (info.family === 'IPv4' && !info.internal) {
        const address = ipToInt(info.address);
        const mask = ipToInt(info.netmask);
        // Skip invalid interface data (defensive check)
        if (address === -1 || mask === -1) continue;

        subnets.push({ address, mask });
      }
    }
  }

  cachedLocalSubnets = subnets;
  return subnets;
}

/**
 * Clear the cached local subnets (useful for testing).
 */
export function clearLocalSubnetCache(): void {
  cachedLocalSubnets = null;
}

/**
 * Check if an IPv4 address is within one of the local subnets.
 * This allows access to MCP servers on the same LAN as this machine.
 * Returns false for invalid IP addresses.
 */
export function isInLocalSubnet(ip: string): boolean {
  const ipInt = ipToInt(ip);
  if (ipInt === -1) return false; // Invalid IP address

  const subnets = getLocalSubnets();

  return subnets.some(subnet =>
    (ipInt & subnet.mask) === (subnet.address & subnet.mask)
  );
}

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

    // Check for private IP ranges and special addresses
    // Use net.isIPv4() for validation - it rejects malformed IPs like 999.999.999.999
    if (net.isIPv4(hostname)) {
      const [a, b, c, d] = hostname.split('.').map(Number);

      // Block 0.0.0.0 - it's not a valid destination address
      // (used for binding servers to all interfaces, not for connecting)
      if (a === 0 && b === 0 && c === 0 && d === 0) {
        return { allowed: false, reason: 'Invalid destination address' };
      }

      // ALWAYS block link-local/cloud metadata (169.254.0.0/16) - security critical
      // Cloud providers (AWS, GCP, Azure) use 169.254.169.254 for instance metadata
      // which can expose sensitive credentials and configuration
      if (a === 169 && b === 254) {
        return { allowed: false, reason: 'Link-local/cloud metadata addresses are not allowed' };
      }

      // Check if this is a private IP range
      const isPrivateIp =
        a === 10 ||                           // Class A private (10.0.0.0/8)
        (a === 192 && b === 168) ||           // Class C private (192.168.0.0/16)
        (a === 172 && b >= 16 && b <= 31);    // Class B private (172.16.0.0/12)

      if (isPrivateIp) {
        // Allow if the IP is in one of our local subnets (same LAN)
        if (isInLocalSubnet(hostname)) {
          return { allowed: true };
        }
        // Block other private IPs not on our network
        return { allowed: false, reason: 'Private IP addresses are not allowed (except localhost and local network)' };
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
 * Check Streamable HTTP server health by sending an MCP initialize request.
 * Streamable HTTP servers (MCP spec 2025-03-26) only accept POST requests with JSON-RPC payloads.
 * GET requests will return 400/405/406, so we must use POST with a proper MCP request.
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
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
    };

    // Add custom headers if configured
    if (server.headers) {
      Object.assign(headers, server.headers);
    }

    // MCP servers only accept POST with JSON-RPC, so send an initialize request
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

  // Store command in local variable for type narrowing inside Promise callback
  const serverCommand = server.command;

  return new Promise((resolve) => {
    // Defense-in-depth: Validate command and args before spawn
    if (!isCommandSafe(serverCommand)) {
      return resolve({
        serverId: server.id,
        status: 'unhealthy',
        message: `Invalid command '${serverCommand}' - not in allowlist`,
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

    const command = isWindows() ? getWhereExePath() : 'which';
    const proc = spawn(command, [serverCommand], {
      timeout: 5000,
      windowsHide: true,
    });

    let found = false;

    proc.on('close', (code) => {
      const responseTime = Date.now() - startTime;

      if (code === 0 || found) {
        resolve({
          serverId: server.id,
          status: 'healthy',
          message: `Command '${serverCommand}' found`,
          responseTime,
          checkedAt: new Date().toISOString(),
        });
      } else {
        resolve({
          serverId: server.id,
          status: 'unhealthy',
          message: `Command '${serverCommand}' not found in PATH`,
          responseTime,
          checkedAt: new Date().toISOString(),
        });
      }
    });

    proc.stdout.on('data', () => {
      found = true;
    });

    proc.on('error', (error: Error) => {
      const responseTime = Date.now() - startTime;
      const errCode = (error as NodeJS.ErrnoException).code;
      let message = `Failed to check command '${server.command}'`;

      // Provide actionable error messages for common failures
      if (errCode === 'ENOENT') {
        message = isWindows()
          ? `System utility 'where.exe' not found. Check Windows installation.`
          : `System utility 'which' not found. Check system PATH configuration.`;
      } else if (errCode === 'EACCES') {
        message = `Permission denied checking command '${server.command}'`;
      }

      resolve({
        serverId: server.id,
        status: 'unhealthy',
        message,
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

  // Defense-in-depth: Validate URL to prevent SSRF attacks
  const urlValidation = isUrlAllowed(server.url);
  if (!urlValidation.allowed) {
    return {
      serverId: server.id,
      success: false,
      message: urlValidation.reason || 'URL not allowed',
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
      appLog.debug(`MCP tools/list request failed for ${server.id}: ${toolsError instanceof Error ? toolsError.message : 'Unknown error'}`);
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

  // Defense-in-depth: Validate URL to prevent SSRF attacks
  const urlValidation = isUrlAllowed(server.url);
  if (!urlValidation.allowed) {
    return {
      serverId: server.id,
      success: false,
      message: urlValidation.reason || 'URL not allowed',
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

    // Streamable HTTP servers may return SSE (text/event-stream) or JSON
    const contentType = response.headers.get('content-type') || '';
    let data: { error?: unknown; result?: unknown };

    try {
      if (contentType.includes('text/event-stream')) {
        // Parse SSE response - extract JSON from "data:" lines
        const text = await response.text();
        const dataLines = text.split('\n').filter(line => line.startsWith('data:'));
        if (dataLines.length > 0) {
          const jsonStr = dataLines[0].substring(5).trim(); // Remove "data:" prefix
          if (!jsonStr) {
            // Empty data line - server is responding but no payload
            data = { result: {} };
          } else {
            data = JSON.parse(jsonStr);
          }
        } else {
          // No data lines but response was OK - server is responding
          data = { result: {} };
        }
      } else {
        data = await response.json();
      }
    } catch (parseError) {
      return {
        serverId: server.id,
        success: false,
        message: `Failed to parse server response: ${parseError instanceof Error ? parseError.message : 'Invalid JSON'}`,
        responseTime,
      };
    }

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
        // Handle SSE or JSON response for streamable HTTP
        const toolsContentType = toolsResponse.headers.get('content-type') || '';
        let toolsData: { result?: { tools?: Array<{ name: string }> } };

        if (toolsContentType.includes('text/event-stream')) {
          const text = await toolsResponse.text();
          const dataLines = text.split('\n').filter(line => line.startsWith('data:'));
          if (dataLines.length > 0) {
            const jsonStr = dataLines[0].substring(5).trim();
            toolsData = JSON.parse(jsonStr);
          } else {
            toolsData = {};
          }
        } else {
          toolsData = await toolsResponse.json();
        }

        if (toolsData.result?.tools) {
          tools = toolsData.result.tools.map((t: { name: string }) => t.name);
        }
      }
    } catch (toolsError) {
      // Tools listing is optional - don't fail the connection test
      clearTimeout(toolsTimeout);
      appLog.debug(`MCP tools/list request failed for ${server.id}: ${toolsError instanceof Error ? toolsError.message : 'Unknown error'}`);
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

  // Store command in local variable for type narrowing inside Promise callback
  const serverCommand = server.command;

  return new Promise((resolve) => {
    // Defense-in-depth: Validate command and args before spawn
    if (!isCommandSafe(serverCommand)) {
      return resolve({
        serverId: server.id,
        success: false,
        message: `Invalid command '${serverCommand}' - not in allowlist`,
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
    const proc = spawn(serverCommand, args, {
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
