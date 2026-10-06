import { CONFIG } from "./config";
import { credentialCacheKey } from "./request-context";

const GLOBAL_REFRESH_INTERVAL = 60000; // 60 seconds - that is the rate limit time frame

/** Maximum number of members listed in an "unknown/ambiguous assignee" error. */
const MAX_LISTED_MEMBERS = 30;

export interface WorkspaceMember {
  id: string;
  username: string;
  email?: string;
  role?: number;
}

const ROLE_NAMES: Record<number, string> = {
  1: "owner",
  2: "admin",
  3: "member",
  4: "guest",
};

/** Human readable name of a ClickUp workspace role number (1 owner, 2 admin, 3 member, 4 guest). */
export function describeRole(role: number | undefined): string {
  if (role === undefined || role === null) {
    return "unknown";
  }
  return ROLE_NAMES[role] ?? `role ${role}`;
}

/** `Username (user_id: 123)` - the output convention for user references. */
export function formatMember(member: { id: string | number; username?: string }): string {
  return member.username
    ? `${member.username} (user_id: ${member.id})`
    : `user_id: ${member.id}`;
}

// Cache promises, not results, so concurrent calls share one request.
// Keyed by credentialCacheKey() so users of a multi-user server never share entries.
const memberPromises = new Map<string, Promise<WorkspaceMember[]>>();

/**
 * All members of the configured workspace (`GET /team`), cached for 60 s per user.
 * A failed request is not cached, so the next call can retry.
 */
export function getWorkspaceMembers(): Promise<WorkspaceMember[]> {
  const key = `${credentialCacheKey()}:${CONFIG.teamId}`;
  const cached = memberPromises.get(key);
  if (cached) {
    return cached;
  }

  const fetchPromise = (async (): Promise<WorkspaceMember[]> => {
    const response = await fetch("https://api.clickup.com/api/v2/team", {
      headers: { Authorization: CONFIG.authHeader },
    });
    if (!response.ok) {
      throw new Error(`Error fetching workspace members: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const team = (data.teams || []).find((t: any) => String(t.id) === String(CONFIG.teamId));
    if (!team) {
      throw new Error(`Workspace ${CONFIG.teamId} not found while loading members`);
    }

    return (team.members || [])
      .map((entry: any) => entry.user)
      .filter((user: any) => user && user.id !== undefined && user.id !== null)
      .map((user: any): WorkspaceMember => ({
        id: String(user.id),
        username: String(user.username ?? ""),
        email: user.email ? String(user.email) : undefined,
        role: typeof user.role === "number" ? user.role : undefined,
      }));
  })();

  memberPromises.set(key, fetchPromise);
  fetchPromise.catch(() => {
    if (memberPromises.get(key) === fetchPromise) {
      memberPromises.delete(key);
    }
  });

  // Auto-cleanup after 60 seconds
  setTimeout(() => {
    memberPromises.delete(key);
    console.error("Auto-cleaned workspace members cache");
  }, GLOBAL_REFRESH_INTERVAL);

  return fetchPromise;
}

function listMembers(members: WorkspaceMember[]): string {
  if (members.length === 0) {
    return "(no members found)";
  }
  const shown = members.slice(0, MAX_LISTED_MEMBERS).map(formatMember).join(", ");
  const rest = members.length - MAX_LISTED_MEMBERS;
  return rest > 0 ? `${shown}, and ${rest} more (use getMembers to see all)` : shown;
}

export interface ResolvedAssignee {
  /** The ClickUp user id */
  id: string;
  /** Only known when the input was a username or email (a bare id is passed through unchecked). */
  username?: string;
}

/**
 * Resolve a user id, username or email to a ClickUp user.
 * - all digits: used as the user id as is, without a members request
 * - otherwise: case-insensitive match on username or email - exact first, then a
 *   unique prefix, then a unique "contains". Ambiguous or unknown input throws an
 *   error that lists the candidates so the caller can retry.
 */
export async function resolveAssigneeMember(input: string): Promise<ResolvedAssignee> {
  const query = String(input ?? "").trim();
  if (!query) {
    throw new Error("Empty assignee. Pass a user id, username or email.");
  }
  if (/^\d+$/.test(query)) {
    return { id: query };
  }

  const members = await getWorkspaceMembers();
  const needle = query.toLowerCase();
  const fields = (m: WorkspaceMember) =>
    [m.username, m.email].filter((v): v is string => Boolean(v)).map((v) => v.toLowerCase());

  const stages: Array<(value: string) => boolean> = [
    (value) => value === needle,
    (value) => value.startsWith(needle),
    (value) => value.includes(needle),
  ];

  for (const matches of stages) {
    const hits = members.filter((m) => fields(m).some(matches));
    if (hits.length === 1) {
      return { id: hits[0].id, username: hits[0].username };
    }
    if (hits.length > 1) {
      throw new Error(
        `Ambiguous assignee "${query}" matches ${hits.length} members: ${listMembers(hits)}. Use the user id or a more specific name/email.`
      );
    }
  }

  throw new Error(`Unknown assignee "${query}". Known members: ${listMembers(members)}`);
}

/** Resolve one assignee (user id, username or email) to its user id. */
export async function resolveAssignee(input: string): Promise<string> {
  return (await resolveAssigneeMember(input)).id;
}

/** Resolve several assignees, keeping the order and dropping duplicates. */
export async function resolveAssigneesDetailed(inputs: string[]): Promise<ResolvedAssignee[]> {
  const resolved: ResolvedAssignee[] = [];
  for (const input of inputs) {
    const member = await resolveAssigneeMember(input);
    if (!resolved.some((r) => r.id === member.id)) {
      resolved.push(member);
    }
  }
  return resolved;
}

/** Resolve several assignees to user ids. */
export async function resolveAssignees(inputs: string[]): Promise<string[]> {
  return (await resolveAssigneesDetailed(inputs)).map((r) => r.id);
}
