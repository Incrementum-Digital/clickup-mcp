#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG } from "./shared/config";
import {
  ensureCredentials,
  formatAuthHeader,
  getOAuthClientCredentials,
  getTokenFilePath,
  logout,
  runOAuthFlow,
} from "./shared/auth";
import { createMcpServer } from "./server-factory";

// Create server variable that will be initialized later
let server: McpServer;

async function initializeServer() {
  console.error(`Starting ClickUp MCP in ${CONFIG.mode} mode`);

  // Resolve token (env, stored OAuth token or OAuth flow) and team before any API call
  await ensureCredentials();

  server = await createMcpServer();
  return server;
}

/**
 * `auth` and `logout` subcommands. Always ends the process, so the returned promise
 * never resolves (it only exists so `serverPromise` keeps its type).
 */
async function runSubcommand(command: "auth" | "logout"): Promise<never> {
  let exitCode = 0;
  try {
    if (command === "logout") {
      const tokenFile = getTokenFilePath();
      console.error(
        logout(tokenFile) ? `Removed stored ClickUp token: ${tokenFile}` : `No stored ClickUp token found at ${tokenFile}`
      );
    } else {
      const { clientId, clientSecret } = getOAuthClientCredentials();
      if (!clientId || !clientSecret) {
        console.error(
          "The auth subcommand needs a ClickUp OAuth app. Set CLICKUP_CLIENT_ID and CLICKUP_CLIENT_SECRET " +
            `(create the app in ClickUp under Settings > Apps and register http://localhost:${process.env.CLICKUP_OAUTH_PORT || 8787}/callback as its redirect URL), then run it again. ` +
            "To use a personal API token instead, skip this command and set CLICKUP_API_KEY."
        );
        exitCode = 1;
      } else {
        // Always a fresh flow: a stored token is deliberately ignored here.
        const token = await runOAuthFlow();
        const headers = { Authorization: formatAuthHeader(token) };
        const [userResponse, teamResponse] = await Promise.all([
          fetch("https://api.clickup.com/api/v2/user", { headers }),
          fetch("https://api.clickup.com/api/v2/team", { headers }),
        ]);
        if (!userResponse.ok || !teamResponse.ok) {
          throw new Error(
            `Token was saved, but verifying it failed: user ${userResponse.status}, team ${teamResponse.status}`
          );
        }
        const userData: any = await userResponse.json();
        const teamData: any = await teamResponse.json();
        const teams: any[] = teamData.teams ?? [];
        console.error(`Authenticated as ${userData.user.username} (user_id: ${userData.user.id})`);
        for (const team of teams) {
          console.error(`${team.name} (team_id: ${team.id})`);
        }
        if (teams.length > 1) {
          console.error("Multiple workspaces are authorized. Set CLICKUP_TEAM_ID to the team_id you want to use.");
        }
      }
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}

const subcommand = process.argv[2];

// Initialize server with enhanced documentation and export
const serverPromise: Promise<McpServer> =
  subcommand === "auth" || subcommand === "logout" ? runSubcommand(subcommand) : initializeServer();

// Export the server promise for CLI and main usage
// Note: server is created inside the promise, so we export a getter
export { serverPromise };

// Only connect to the transport if this file is being run directly (not imported)
// OR if not being imported by CLI (to support Claude Desktop's module loading)
const isCliMode = process.argv.some(arg => arg.includes('cli.ts') || arg.includes('cli.js'));
if (require.main === module || !isCliMode) {
  // Start receiving messages on stdin and sending messages on stdout after initialization
  serverPromise.then(() => {
    const transport = new StdioServerTransport();
    server.connect(transport);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}