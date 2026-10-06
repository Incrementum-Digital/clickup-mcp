import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** Owner of the session; a session id alone must never grant access to somebody else's session. */
  userKey: string;
  username?: string;
  lastSeen: number;
}

const EVICTION_INTERVAL_MS = 60 * 1000;

/** In-memory MCP sessions (single replica). Idle sessions are evicted so abandoned clients cannot leak. */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly idleMs: number) {
    this.timer = setInterval(() => this.evictIdle(), EVICTION_INTERVAL_MS);
    this.timer.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  add(id: string, session: Omit<Session, "lastSeen">): void {
    this.sessions.set(id, { ...session, lastSeen: Date.now() });
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  touch(id: string): void {
    const session = this.sessions.get(id);
    if (session) session.lastSeen = Date.now();
  }

  /** Forgets the session first so the transport's onclose callback does not recurse into us. */
  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    try {
      await session.server.close(); // closes the connected transport too
    } catch (error) {
      console.error(`closing session ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private evictIdle(now = Date.now()): void {
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen > this.idleMs) {
        console.error(`session ${id} evicted after being idle`);
        void this.remove(id);
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.timer);
    await Promise.all([...this.sessions.keys()].map((id) => this.remove(id)));
  }
}
