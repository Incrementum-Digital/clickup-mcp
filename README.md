# ClickUp MCP for AI Assistants

Model Context Protocol (MCP) server enabling AI assistants to interact with ClickUp workspaces. Get complete task context with comments and images, search across projects, create and update tasks, collaborate through comments, and track time - all through natural language.

## This MCP vs Official ClickUp MCP

> See also: [Official ClickUp MCP Documentation](https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server)

| Feature              | This MCP                                              | Official ClickUp MCP                        |
|----------------------|-------------------------------------------------------|---------------------------------------------|
| **Setup**            | Local npm/npx install, or self-hosted remote server   | Remote MCP (no install)                     |
| **Authentication**   | API key or ClickUp OAuth app (local browser login; remote: per-user ClickUp OAuth) | OAuth only                                  |
| **Task Context**     | Complete with comments, status history, inline images | Requires mutiple tool calls for full contxt |
| **Image Support**    | Read and write: inline images with smart size budgeting, and `![](local/path.png)` uploads automatically | Upload via separate tool calls; base64 capped at ~200KB |
| **Search**           | Fuzzy search on recent tasks (limited scope)          | Full ClickUp search database                |
| **Documents**        | CRUD operations                                       | CRUD + document search                      |
| **Time Tracking**    | View and create entries                               | Timers and entries                          |
| **Chat Integration** | Not supported                                         | Supported                                   |
| **Connected Apps**   | Not supported                                         | Connected Search                            |
| **Best For**         | Coding tools, automation, context gathering           | Chat apps, task management                  |
| **Support**          | Community (open source)                               | Official ClickUp                            |

**Choose this MCP when:**
- You need rich task context with inline images for AI coding tools
- You want to write screenshots into tickets by local file path (running locally, it reads the file itself instead of taking base64)
- You need API key authentication for automation or CI/CD pipelines
- You want the `read-minimal` mode optimized for development workflows

**Choose Official MCP when:**
- You need Chat integration or Connected Search features
- You want official support and no local installation

## What You Can Do

Turn natural language into powerful ClickUp actions:

**Agentic Coding & Development:**
- *"Look at CU-abc123, can you find the relevant code?"*
- *"Can you build the dashboard like described in https://app.clickup.com/t/12a23b45c?"*
- *"Check task CU-xyz789 and fix the bugs mentioned in the comments"*
- *"Implement the API endpoints described in the integration task"*

**Time Tracking & Productivity:**
- *"Book 2 hours for the client meeting on the XYZ project"*
- *"How much time did I spend on development tasks this week?"*
- *"Log 30 minutes for code review on the authentication feature"*

**Smart Search & Discovery:**
- *"What task did I mention the CSV import in?"*
- *"Find all tasks related to the payment gateway integration"*
- *"Show me tasks where users reported login issues"*

**Daily Workflow Management:**
- *"What do I need to do today?"*
- *"Create a task for fixing the dashboard bug in the frontend list"*
- *"Update the API documentation task to 'in review' status"*
- *"What tasks are blocking the mobile app release?"*

**Rich Context & Collaboration:**
- *"Show me all comments on the user authentication task"*
- *"What's the latest update on the database migration?"*
- *"Add a comment to the design task about the new wireframes"*

**Document Management:**
- *"Find documents about job posting in hauptsache.net space"*
- *"Search for API documentation across all spaces"*
- *"Read the API documentation in the development space"*
- *"Create a new requirements document for the mobile app project"*
- *"Update the meeting notes with today's decisions"*
- *"What documents are in the product strategy space?"*

## Key Features

### 🔍 **Intelligent Search**
- Fuzzy matching across task names, descriptions, and comments
- Multi-language search support for international teams
- Filter by assignees, projects, status, and metadata

### 💬 **Complete Context**
- Comment histories and team discussions (up to 250 top-level comments), including threaded comment replies
- Task descriptions with embedded images  
- List descriptions and project guidelines
- Document content with page navigation
- Access to complete task history and decisions

### ⏱️ **Time Tracking**
- Log time entries with descriptions
- View historical time logs and entries
- Query time entries by task or date range

### 📋 **Task & Document Management**
- Create and update tasks with markdown descriptions
- Create, read, and update documents and pages
- Add comments and collaborate with team members
- Manage priorities, due dates, assignees, and tags
- Handle time estimates and custom field values

### 🔒 **Safety Features**
- **Append-Only Descriptions**: Description fields are never overwritten - new content is safely appended with timestamps
- **Normal Field Updates**: Status, priority, assignees, tags, and dates can be updated normally (easily revertible through ClickUp's history)

## Installation

### Prerequisites

For all installation methods, you'll need **either**:
- Your `CLICKUP_API_KEY` (Profile Icon > Settings > Apps > API Token ~ usually starts with pk_) and optionally your `CLICKUP_TEAM_ID` (The 7–10 digit number in the URL when you are in the settings)

**or**:
- A ClickUp OAuth app (client ID and client secret), see [Authentication](#authentication) below. `CLICKUP_TEAM_ID` is optional when your token is authorized for exactly one workspace.

The examples below use a personal API key; the [Authentication](#authentication) section shows the OAuth variants.

### Authentication

The server supports two ways to authenticate. The token is resolved in this order: `CLICKUP_API_KEY`, then the saved token file, then an interactive OAuth login (when `CLICKUP_CLIENT_ID` and `CLICKUP_CLIENT_SECRET` are set).

#### Option A: Personal API token

Take your token from Profile Icon > Settings > Apps > API Token (usually starts with `pk_`) and set it as `CLICKUP_API_KEY`. See the installation examples below.

#### Option B: ClickUp OAuth app

Create an OAuth app in ClickUp (only workspace owners/admins can create apps, see the [ClickUp authentication docs](https://developer.clickup.com/docs/authentication)):

1. In ClickUp click your avatar > Settings.
2. In the sidebar under the workspace section open "Integrations" (or "Apps"), then "ClickUp API".
3. Click "Create an App".
4. Enter a name and the redirect URL `http://localhost:8787/callback`.
5. Copy the Client ID and Client Secret.

The redirect URL must be registered on the ClickUp app exactly, including the port. If you change the port with `CLICKUP_OAUTH_PORT`, register the matching URL.

**Claude Code (CLI):**
```bash
claude mcp add --scope user clickup \
  --env CLICKUP_CLIENT_ID=YOUR_CLIENT_ID \
  --env CLICKUP_CLIENT_SECRET=YOUR_CLIENT_SECRET \
  -- npx -y @hauptsache.net/clickup-mcp
```

**Claude Desktop, Windsurf, Cursor and others:**
```json
{
  "mcpServers": {
    "clickup": {
      "command": "npx",
      "args": [
        "@hauptsache.net/clickup-mcp@latest"
      ],
      "env": {
        "CLICKUP_CLIENT_ID": "your_client_id",
        "CLICKUP_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

**Log in once in a terminal first** (the client ID and secret must be in the environment of that command):
```bash
CLICKUP_CLIENT_ID=YOUR_CLIENT_ID CLICKUP_CLIENT_SECRET=YOUR_CLIENT_SECRET \
  npx @hauptsache.net/clickup-mcp auth
```

`auth` opens the browser (and prints the URL to the terminal as well), saves the token and prints `Authenticated as <username> (user_id: ...)` plus the authorized workspaces. MCP hosts such as Claude Desktop start the server in the background and may time out if the first start has to wait for a browser login, so running `auth` once beforehand is the recommended path. If no token is saved and client ID and secret are set, the server still attempts the browser login on start.

To remove the saved token:
```bash
npx @hauptsache.net/clickup-mcp logout
```

Notes:
- `CLICKUP_TEAM_ID` is optional. If it is unset, the server calls `GET /api/v2/team` and uses the workspace automatically when the token is authorized for exactly one. With several workspaces it stops and lists them as `Name (team_id: 123)` so you can set `CLICKUP_TEAM_ID`.
- ClickUp OAuth tokens do not expire and there is no refresh token. The token is saved to `~/.config/clickup-mcp/token.json` (override with `CLICKUP_TOKEN_FILE`, written with mode 0600).
- OAuth tokens are sent as `Authorization: Bearer <token>`; personal tokens are sent as-is.
- **OAuth does not raise rate limits.** Limits are per token and identical for both token types: 100 requests/minute on Free Forever, Unlimited and Business, 1,000/min on Business Plus, 10,000/min on Enterprise. OAuth helps with team rollout (nobody has to handle a personal token) and gives per-workspace authorization and revocation from the ClickUp app settings.

### Option 1: MCPB Bundle (Recommended for Claude Desktop)

Download the pre-built bundle from our [releases page](https://github.com/hauptsacheNet/clickup-mcp/releases). This method requires no Node.js installation.

You'll get a configuration screen where you are prompted to enter your API key and team ID, or the client ID and secret of a ClickUp OAuth app (all optional, see [Authentication](#authentication)).

### Option 2: NPX Installation

This method automatically updates to the latest version and is preferred for users who want the newest features.

**For Claude Desktop, Windsurf, Cursor and others:**

Add the following to your MCP configuration file:

```json
{
  "mcpServers": {
    "clickup": {
      "command": "npx",
      "args": [
        "@hauptsache.net/clickup-mcp@latest"
      ],
      "env": {
        "CLICKUP_API_KEY": "your_api_key",
        "CLICKUP_TEAM_ID": "your_team_id"
      }
    }
  }
}
```

Replace `your_api_key` and `your_team_id` with your actual ClickUp credentials.

**Where to add this configuration:**
- **Claude Desktop**: Settings > Developer > Edit Config
- **Windsurf**: Add to your MCP configuration file
- **Cursor**: Configure through the MCP settings panel

### Option 3: Coding Tools Integration

**Claude Code (CLI):**
```bash
claude mcp add --scope user clickup \
  --env CLICKUP_API_KEY=YOUR_KEY \
  --env CLICKUP_TEAM_ID=YOUR_ID \
  --env CLICKUP_MCP_MODE=read-minimal \
  --env MAX_IMAGES=16 \
  --env MAX_RESPONSE_SIZE_MB=4 \
  -- npx -y @hauptsache.net/clickup-mcp
```

> Claude Code can handle a lot of images, thus the recommended increased limits.
 
> Note the `CLICKUP_MCP_MODE=read-minimal`. This is my usage recommendation, but feel free to use one of the other modes.

**OpenAI Codex:**
Add these lines to your `~/.codex/config.toml` file:
```toml
[mcp_servers.clickup]
command = "npx"
args = ["-y", "@hauptsache.net/clickup-mcp@latest"]
env = { "CLICKUP_API_KEY" = "YOUR_KEY", "CLICKUP_TEAM_ID" = "YOUR_ID", "CLICKUP_MCP_MODE" = "read-minimal" }
```

> Codex seems to not be able to handle images from MCP's. See [this issue](https://github.com/openai/codex/issues/3741) for more details.

> Note the `CLICKUP_MCP_MODE=read-minimal`. This is my usage recommendation, but feel free to use one of the other modes.

## Hosting as a Remote MCP Server (Railway)

Besides the local stdio mode, the server can run as a hosted remote MCP server: `node dist/http.js` (npm script `start:http`) serves MCP over Streamable HTTP at `/mcp`, behind an OAuth 2.1 authorization server built into the same process (dynamic client registration, PKCE, refresh tokens). The login step delegates to ClickUp OAuth, so every user connects with their own ClickUp account and their own rate limit; nothing is shared. The stdio mode described above is unchanged.

### Environment variables (hosted mode)

| Variable | Required | Description |
|----------|:--------:|-------------|
| `MCP_TOKEN_SECRET` | yes | Seals all tokens (AES-256-GCM). Minimum 32 characters, e.g. `openssl rand -hex 32`. Never auto-generated. |
| `CLICKUP_CLIENT_ID` | yes | Client ID of your ClickUp OAuth app. |
| `CLICKUP_CLIENT_SECRET` | yes | Client secret of your ClickUp OAuth app. |
| `MCP_PUBLIC_URL` | yes | External origin of the server. On Railway it falls back to `https://$RAILWAY_PUBLIC_DOMAIN`. |
| `PORT` | no | Listen port. Defaults to 3000. |
| `CLICKUP_TEAM_ID` | no | Workspace gate, see below. |
| `CLICKUP_MCP_MODE` | no | `read-minimal`, `read` or `write` (default), as in stdio mode. |
| `MCP_ACCESS_TOKEN_TTL_SECONDS` | no | Access token lifetime. Defaults to 3600. |
| `MCP_REFRESH_TOKEN_TTL_SECONDS` | no | Refresh token lifetime. Defaults to 30 days. |
| `MCP_SESSION_IDLE_SECONDS` | no | Idle time before an MCP session is dropped. Defaults to 3600. |
| `MCP_ALLOWED_REDIRECT_SCHEMES` | no | Extra redirect URI schemes for native MCP clients, comma-separated (e.g. `cursor`). By default only `https://` redirect URIs and `http://localhost` loopback URIs are accepted at client registration. |

### Deploy on Railway

`railway.toml` sets `startCommand = "node dist/http.js"` and `healthcheckPath = "/health"`.

1. Create a Railway service from the GitHub repository.
2. Set the environment variables above.
3. Generate a public domain for the service and set `MCP_PUBLIC_URL` to it (or rely on `RAILWAY_PUBLIC_DOMAIN`).
4. In your ClickUp OAuth app register `https://<MCP_PUBLIC_URL>/oauth/clickup/callback` as the redirect URL. The server prints this exact URL at startup.
5. Add `https://<domain>/mcp` as a connector (below).

Run a single replica; the server is built for that.

### Connecting

- **claude.ai:** Settings > Connectors > Add custom connector > enter the `/mcp` URL.
- **Claude Desktop:** the same connector.
- **Claude Code:** `claude mcp add --transport http clickup https://<host>/mcp`

Each user is sent through a ClickUp login the first time and then uses their own ClickUp token. Rate limits are per ClickUp token, so every connected user gets their own budget (100 requests/minute on Business).

### Workspace gate

With `CLICKUP_TEAM_ID` set, only users who authorized that workspace may connect. Without it, each user must have authorized exactly one workspace.

### Stateless tokens

There is no database. Access tokens, refresh tokens and registered client ids are AES-256-GCM blobs sealed with `MCP_TOKEN_SECRET`; only in-flight logins (10 minutes) and authorization codes (60 seconds) live in memory. Consequences:

- Rotating `MCP_TOKEN_SECRET` logs everyone out.
- Issued tokens cannot be revoked early. Revoking the app inside ClickUp (avatar > Settings > Apps / Integrations) invalidates the wrapped ClickUp token, which stops it working.
- A restart clears the in-memory list of used refresh tokens.

### Security notes

- MCP session ids are bound to the user who created them; another user's token gets a 403.
- Dynamically registered clients may only use `https://` redirect URIs, plus `http://localhost` for Claude Code. Other schemes are rejected unless listed in `MCP_ALLOWED_REDIRECT_SCHEMES`.
- The ClickUp login is bound to the browser that started it with a cookie, and a consent page shows which MCP client (name and redirect origin) will receive access before the user is sent to ClickUp.
- Refresh tokens are rotated on every use; a reused refresh token is rejected (the used-token list is in memory, so it resets on restart).
- On the hosted server, markdown image sources in comments and descriptions must be URLs or data URIs; local file paths are rejected, and URLs that resolve to private, loopback or link-local addresses are refused.
- The server logs `username (user_id)` and the tool name for every call to stderr, so usage is attributable.

### Endpoints

`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/authorize`, `/token`, `/register`, `/oauth/clickup/callback`, `/mcp`, `/health`.

## MCP Modes & Available Tools

The ClickUp MCP supports three operational modes to balance functionality, security, and performance:

- **🚀 `read-minimal`**: Perfect for AI coding assistants and context gathering
- **📖 `read`**: Full read-only access for project exploration and workflow understanding  
- **✏️ `write`** (Default): Complete functionality for task management and productivity workflows

| Tool                   | read-minimal | read | write | Description                                                                             |
|------------------------|:------------:|:----:|:-----:|-----------------------------------------------------------------------------------------|
| `getTaskById`          |      ✅       |  ✅   |   ✅   | Get complete task details including comments (with threaded replies), images, and metadata |
| `addComment`           |      ❌       |  ❌   |   ✅   | Add comments to tasks, or reply inside a comment thread via `parent_comment_id`         |
| `editComment`          |      ❌       |  ❌   |   ✅   | Correct your own comment within 24h instead of posting a follow-up                      |
| `updateTask`           |      ❌       |  ❌   |   ✅   | Update tasks (status, priority, assignees, etc.); descriptions can be appended to or replaced entirely |
| `createTask`           |      ❌       |  ❌   |   ✅   | Create new tasks with full markdown support                                             |
| `searchTasks`          |      ✅       |  ✅   |   ✅   | Find tasks by content, keywords, assignees, or project context                          |
| `searchSpaces`         |      ❌       |  ✅   |   ✅   | Browse workspace structure, project organization, and documents                         |
| `getListInfo`          |      ❌       |  ✅   |   ✅   | Get list details and available statuses for task creation                               |
| `updateListInfo`       |      ❌       |  ❌   |   ✅   | **SAFE APPEND-ONLY** updates to list descriptions (preserves existing content)          |
| `getTimeEntries`       |      ❌       |  ✅   |   ✅   | View time entries and analyze time spent across projects                                |
| `createTimeEntry`      |      ❌       |  ❌   |   ✅   | Log time entries for task tracking                                                      |
| `readDocument`         |      ❌       |  ✅   |   ✅   | Get document details, page structure, and content with navigation                       |
| `searchDocuments`      |      ❌       |  ✅   |   ✅   | Search documents by name and space with fuzzy matching and space filtering              |
| `updateDocumentPage`   |      ❌       |  ❌   |   ✅   | Update existing page content or name with replace/append modes                          |
| `createDocumentOrPage` |      ❌       |  ❌   |   ✅   | Create new documents with first page, or add pages/sub-pages to existing documents      |

### Setting the Mode

Add the mode to your MCP configuration:

```json
{
  "mcpServers": {
    "clickup": {
      "command": "npx",
      "args": ["-y", "@hauptsache.net/clickup-mcp@latest"],
      "env": {
        "CLICKUP_API_KEY": "your_api_key",
        "CLICKUP_TEAM_ID": "your_team_id",
        "CLICKUP_MCP_MODE": "read"
      }
    }
  }
}
```

## Configuration

This MCP server can be configured using environment variables. In the desktop extension (`.mcpb`) installer, the API key, team ID, OAuth client ID and secret, primary language, upload size limit and comment edit window are offered as form fields; the remaining variables have to be set on the server environment directly.

- `CLICKUP_API_KEY`: (Optional) Your ClickUp personal API key. Required unless a saved OAuth token exists or `CLICKUP_CLIENT_ID` and `CLICKUP_CLIENT_SECRET` are set.
- `CLICKUP_TEAM_ID`: (Optional) Your ClickUp Team ID (formerly Workspace ID). If unset, the workspace is detected automatically when the token is authorized for exactly one; with several, the server lists them and asks you to set this.
- `CLICKUP_CLIENT_ID`: (Optional) Client ID of your ClickUp OAuth app. Together with `CLICKUP_CLIENT_SECRET` this enables OAuth login (see [Authentication](#authentication)).
- `CLICKUP_CLIENT_SECRET`: (Optional) Client secret of your ClickUp OAuth app.
- `CLICKUP_OAUTH_PORT`: (Optional) Local port for the OAuth callback. Defaults to 8787. The redirect URL `http://localhost:8787/callback` (with your port) must be registered on the ClickUp app exactly.
- `CLICKUP_TOKEN_FILE`: (Optional) Where the OAuth token is saved. Defaults to `~/.config/clickup-mcp/token.json` (written with mode 0600).
- `CLICKUP_MCP_MODE`: (Optional) Controls which tools are available. Options: `read-minimal`, `read`, `write` (default).
- `MAX_IMAGES`: (Optional) The maximum number of images to return for a task in `getTaskById`. Defaults to 4.
- `MAX_RESPONSE_SIZE_MB`: (Optional) The maximum response size in megabytes for `getTaskById`. Uses intelligent size budgeting to fit the most important images within the limit. Defaults to 1.
- `MAX_UPLOAD_SIZE_MB`: (Optional) The maximum size of a single image uploaded when writing comments or descriptions. Defaults to 10.
- `CLICKUP_COMMENT_EDIT_WINDOW_HOURS`: (Optional) How long after creation `editComment` may still rewrite a comment. Defaults to 24. Set to `0` to disable comment editing entirely.
- `CLICKUP_PRIMARY_LANGUAGE`: (Optional) A hint for the primary language used in your ClickUp tasks (e.g., "de" for German, "en" for English). This helps the `searchTask` tool provide more tailored guidance in its description for multilingual searches.
- `LANG`: (Optional) If `CLICKUP_PRIMARY_LANGUAGE` is not set, the MCP will check this standard environment variable (e.g., "en_US.UTF-8", "de_DE") as a fallback to infer the primary language.

Hosted mode only (see [Hosting as a Remote MCP Server](#hosting-as-a-remote-mcp-server-railway)); `CLICKUP_CLIENT_ID`, `CLICKUP_CLIENT_SECRET`, `CLICKUP_TEAM_ID` and `CLICKUP_MCP_MODE` apply there too:

- `MCP_TOKEN_SECRET`: (Required) Secret of at least 32 characters that seals all tokens, e.g. `openssl rand -hex 32`. Never auto-generated.
- `MCP_PUBLIC_URL`: (Required) External origin of the server. Falls back to `https://$RAILWAY_PUBLIC_DOMAIN` on Railway.
- `PORT`: (Optional) Listen port. Defaults to 3000.
- `MCP_ACCESS_TOKEN_TTL_SECONDS`: (Optional) Access token lifetime. Defaults to 3600.
- `MCP_REFRESH_TOKEN_TTL_SECONDS`: (Optional) Refresh token lifetime. Defaults to 30 days.
- `MCP_SESSION_IDLE_SECONDS`: (Optional) Idle time before an MCP session is dropped. Defaults to 3600.

### Language-Aware Search Guidance

The `searchTask` tool's description will dynamically adjust based on the detected primary language:
- If `CLICKUP_PRIMARY_LANGUAGE` or `LANG` suggests a known primary language (e.g., German), the tool's description will specifically recommend providing search terms in both English and that detected language (e.g., German) for optimal results.
- If no primary language is detected, a more general recommendation for multilingual workspaces will be provided.

This feature aims to improve search effectiveness when the language of user queries (often English) differs from the language of the tasks in ClickUp, without making the MCP itself perform translations. The responsibility for providing bilingual search terms still lies with the agent calling the MCP, but the MCP offers more specific advice if it has a language hint.

## Markdown Formatting Support

Task descriptions and list documentation support full markdown formatting:

### Examples

**Task Creation with Markdown:**
```
Create a task called "API Integration" with description:
# API Integration Requirements

## Authentication
- Implement OAuth 2.0 flow
- Add JWT token validation
- **Priority**: High security standards

## Endpoints
1. `/api/users` - User management
2. `/api/data` - Data retrieval
3. `/api/webhook` - Event notifications

## Testing
- [ ] Unit tests for auth flow
- [ ] Integration tests
- [ ] Load testing with 1000+ concurrent users

> **Note**: This replaces the legacy REST implementation

See related task: https://app.clickup.com/t/abc123
```

**Append-Only Updates (Safe):**
When updating task descriptions, content is safely appended:
```markdown
[Existing task description content]

---
**Edit (2024-01-15):** Added new acceptance criteria based on client feedback:
- Must support mobile responsive design
- Performance requirement: < 2s load time
```

This ensures no existing content is ever lost while maintaining a clear audit trail.

## Writing Images Into Tickets

`addComment`, `editComment`, `createTask` and `updateTask` accept images as ordinary markdown. Because
this server runs locally, it reads the file itself - so a **local path is enough**:

```markdown
Ist umgesetzt. So sieht es aus:

**1. Login öffnen** – der Kunde gibt nur seine E-Mail-Adresse ein.

![Die Login-Maske fragt nur nach der E-Mail](/Users/me/shots/login.png)
```

Accepted sources: local file paths, `data:` URIs, http(s) URLs (downloaded, then
re-uploaded), and existing ClickUp attachment URLs (embedded without re-uploading).

Notes:

- **Prefer paths over base64.** A path costs a few tokens; the same screenshot as a
  `data:` URI costs roughly 4/3 of its file size in the request.
- **The caption becomes the attachment filename**, and that filename is what ClickUp
  displays beneath the image - so write a caption that reads well.
- **An image inside a numbered list breaks ClickUp's numbering.** Write walkthrough
  steps as bold lines with the image between them, as above.
- Only real PNG/JPEG/GIF/WebP files are uploaded - the content is checked, not the
  extension. A file that fails **aborts the write**: `addComment`, `editComment` and
  `updateTask` report every broken reference and change nothing, so the markdown can be
  fixed and the call retried without creating duplicates. `createTask` validates its
  images before creating the task; only an upload failing afterwards is reported as a
  warning, since the task already exists at that point.
- Attachments always belong to a task, so document pages cannot embed uploads this way.

## Performance & Limitations

**Optimized for AI Workflows:**
- **Smart Image Processing**: Intelligent size budgeting prioritizes the most recent images while respecting both count (`MAX_IMAGES`, default: 4) and total response size limits (`MAX_RESPONSE_SIZE_MB`, default: 1MB)
- **Search Scope**: Searches within the most recent 1000-3000 tasks to prevent running into rate limits (exact number varies by endpoint)
- **Search Results**: Returns up to 50 most relevant matches to prevent flooding the agent with too many results

**Current Scope:**
- Focused on task-level operations rather than bulk workspace management
- Optimized for conversational AI workflows rather than data migration
- Designed for productivity enhancement, not administrative operations

These limitations ensure reliable performance while covering the most common use cases for both development context and productivity management.

## License

MIT
