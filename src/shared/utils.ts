import {CONFIG} from "./config";
import Fuse from 'fuse.js';
import {credentialCacheKey} from "./request-context";

const GLOBAL_REFRESH_INTERVAL = 60000; // 60 seconds - that is the rate limit time frame

/**
 * Checks if a string looks like a valid ClickUp task ID
 * Valid task IDs are 6-16 characters long and contain only alphanumeric characters
 */
export function isTaskId(str: string): boolean {
  // Task IDs are 6-16 characters long and contain only alphanumeric characters
  return /^[a-z0-9]{6,16}$/i.test(str);
}

// Cache for current user info to avoid repeated API calls and race conditions
// Keyed by credentialCacheKey() so users of a multi-user server never share entries.
const cachedUserPromises = new Map<string, Promise<any>>();

/**
 * Get current authenticated user information from ClickUp API
 * Caches the promise to prevent race conditions on concurrent calls
 */
export async function getCurrentUser() {
  // Return cached promise if available
  const userKey = credentialCacheKey();
  const cachedUser = cachedUserPromises.get(userKey);
  if (cachedUser) {
    return cachedUser;
  }

  // Create the fetch promise
  const fetchPromise = (async () => {
    const userResponse = await fetch("https://api.clickup.com/api/v2/user", {
      headers: { Authorization: CONFIG.authHeader },
    });

    if (!userResponse.ok) {
      throw new Error(`Error fetching user info: ${userResponse.status} ${userResponse.statusText}`);
    }

    return await userResponse.json();
  })();

  // Cache the promise
  cachedUserPromises.set(userKey, fetchPromise);
  
  // Auto-cleanup after 60 seconds
  setTimeout(() => {
    cachedUserPromises.delete(userKey);
    console.error(`Auto-cleaned user data cache`);
  }, GLOBAL_REFRESH_INTERVAL);
  
  return fetchPromise;
}

// Re-export image processing functions for backward compatibility
export { downloadImages } from "./image-processing";

const spaceCache = new Map<string, Promise<any>>(); // Global cache for space details promises

/**
 * Function to get space details, using a cache to avoid redundant fetches
 */
export function getSpaceDetails(spaceId: string): Promise<any> {
  if (!spaceId) {
    return Promise.reject(new Error('Invalid space ID'));
  }

  const cacheKey = `${credentialCacheKey()}:${spaceId}`;
  const cachedSpace = spaceCache.get(cacheKey);
  if (cachedSpace) {
    return cachedSpace;
  }

  const fetchPromise = fetch(
    `https://api.clickup.com/api/v2/space/${spaceId}`,
    {headers: {Authorization: CONFIG.authHeader}})
    .then(res => {
      if (!res.ok) {
        throw new Error(`Error fetching space ${spaceId}: ${res.status}`);
      }
      return res.json();
    })
    .catch(error => {
      console.error(`Network error fetching space ${spaceId}:`, error);
      throw new Error(`Error fetching space ${spaceId}: ${error}`);
    });

  spaceCache.set(cacheKey, fetchPromise);
  return fetchPromise;
}

// Task search index management - cache promises to prevent race conditions
const taskIndices: Map<string, Promise<TaskSearchResult>> = new Map();

/** ClickUp returns at most this many tasks per page of the team task endpoint. */
export const TASK_PAGE_SIZE = 100;
/** Pages fetched per search. The rate limit is 100 requests/minute per token, so keep this small. */
export const TASK_MAX_PAGES = 5;
/** Pages fetched in parallel by the legacy (pre-filter) search path, unfiltered / scoped by space, list or assignee. */
export const LEGACY_MAX_PAGES = 30;
export const LEGACY_SCOPED_MAX_PAGES = 10;

export type TaskOrderBy = 'id' | 'created' | 'updated' | 'due_date';

export interface CustomFieldFilter {
  field_id: string;
  operator: string;
  value?: unknown;
}

/** Filters understood by ClickUp's "Get Filtered Team Tasks" endpoint. Dates are Unix ms. */
export interface TaskFilters {
  space_ids?: string[];
  list_ids?: string[];
  /** Folder ids - sent as project_ids[] */
  folder_ids?: string[];
  assignees?: string[];
  statuses?: string[];
  tags?: string[];
  include_closed?: boolean;
  include_subtasks?: boolean;
  due_date_gt?: number;
  due_date_lt?: number;
  date_created_gt?: number;
  date_created_lt?: number;
  date_updated_gt?: number;
  date_updated_lt?: number;
  date_done_gt?: number;
  date_done_lt?: number;
  custom_fields?: CustomFieldFilter[];
  /** Task id - returns the subtasks of that task */
  parent?: string;
  order_by?: TaskOrderBy;
  reverse?: boolean;
}

export interface TaskSearchResult {
  tasks: any[];
  index: Fuse<any>;
  pagesFetched: number;
  /** True when the last allowed page was still full, i.e. more matching tasks probably exist. */
  pageCapReached: boolean;
  /** Set when a page after the first failed, so the task list is incomplete. */
  warning?: string;
}

/**
 * Parses an ISO 8601 date or datetime into Unix ms.
 * Date-only values are UTC; `endOfDay` makes a date-only value mean 23:59:59.999 of that day.
 * Datetimes without an offset are treated as UTC. Throws on unparsable input.
 */
export function parseDateFilter(name: string, value: string, endOfDay = false): number {
  const v = value.trim();
  let ms: number;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    ms = Date.parse(`${v}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
    // Date.parse rolls impossible days over (2026-02-31 -> March 3rd) - reject those
    if (Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) !== v) ms = NaN;
  } else {
    const hasZone = /(Z|[+-]\d{2}(:?\d{2})?)$/i.test(v);
    ms = Date.parse(hasZone ? v : `${v}Z`);
  }
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid ${name} "${value}": expected an ISO 8601 date (2025-01-31) or datetime (2025-01-31T09:00:00Z).`);
  }
  return ms;
}

/**
 * Builds the query parameters (without `page`) for the filtered team tasks endpoint.
 * Array values are sorted so equal filters always produce the same string (used as cache key).
 */
export function buildTaskQueryParams(filters: TaskFilters): string[] {
  const params: string[] = [];
  const enc = encodeURIComponent;
  const addArray = (name: string, values?: string[]) => {
    if (!values?.length) return;
    [...values].sort().forEach(v => params.push(`${name}[]=${enc(v)}`));
  };
  const addValue = (name: string, value: string | number | boolean | undefined) => {
    if (value === undefined) return;
    params.push(`${name}=${enc(String(value))}`);
  };

  addValue('order_by', filters.order_by ?? 'updated');
  addValue('reverse', filters.reverse);
  addArray('space_ids', filters.space_ids);
  addArray('list_ids', filters.list_ids);
  addArray('project_ids', filters.folder_ids);
  addArray('assignees', filters.assignees);
  addArray('statuses', filters.statuses);
  addArray('tags', filters.tags);
  if (filters.include_closed) addValue('include_closed', true);
  if (filters.include_subtasks) addValue('subtasks', true);
  addValue('due_date_gt', filters.due_date_gt);
  addValue('due_date_lt', filters.due_date_lt);
  addValue('date_created_gt', filters.date_created_gt);
  addValue('date_created_lt', filters.date_created_lt);
  addValue('date_updated_gt', filters.date_updated_gt);
  addValue('date_updated_lt', filters.date_updated_lt);
  addValue('date_done_gt', filters.date_done_gt);
  addValue('date_done_lt', filters.date_done_lt);
  if (filters.custom_fields?.length) addValue('custom_fields', JSON.stringify(filters.custom_fields));
  addValue('parent', filters.parent);
  return params;
}

/**
 * Get or create the task list + search index for the given filters.
 * Caches promises to prevent race conditions on concurrent calls; rejected fetches are not cached.
 *
 * mode "filtered" (default): sequential, capped at TASK_MAX_PAGES pages, stops at a short page.
 * mode "legacy": the original deep fetch used when only the pre-existing filters
 * (space_ids, list_ids, assignees) are set - up to LEGACY_MAX_PAGES pages in parallel so a pure
 * text search can match across thousands of recently updated tasks.
 */
export async function getTaskSearchIndex(
  filters: TaskFilters = {},
  mode: 'filtered' | 'legacy' = 'filtered'
): Promise<TaskSearchResult> {
  const queryString = (mode === 'legacy'
    ? buildTaskQueryParams({
      space_ids: filters.space_ids,
      list_ids: filters.list_ids,
      assignees: filters.assignees,
      include_subtasks: true,
    })
    : buildTaskQueryParams(filters)
  ).join('&');
  const key = `${credentialCacheKey()}:${mode}:${queryString}`;

  // Check for existing valid index promise
  const cachedPromise = taskIndices.get(key);
  if (cachedPromise) {
    return cachedPromise;
  }

  // Create the fetch promise
  const fetchPromise = (async (): Promise<TaskSearchResult> => {
    console.error(`Refreshing ${mode} task index for filters: ${queryString}`);
    const fetched = mode === 'legacy'
      ? await fetchTasksLegacy(queryString, !!(filters.space_ids?.length || filters.list_ids?.length || filters.assignees?.length))
      : await fetchTasks(queryString);
    const index = createFuseIndex(fetched.tasks);
    console.error(`Task index created with ${fetched.tasks.length} tasks (${fetched.pagesFetched} page(s))`);
    return {...fetched, index};
  })();

  // Store promise with auto-cleanup
  taskIndices.set(key, fetchPromise);
  fetchPromise.catch(() => taskIndices.delete(key));
  setTimeout(() => {
    taskIndices.delete(key);
    console.error(`Auto-cleaned index for filters: ${queryString}`);
  }, GLOBAL_REFRESH_INTERVAL);

  return fetchPromise;
}

/**
 * Original deep fetch: all pages requested in parallel (30 pages unfiltered, 10 when scoped by
 * space/list/assignee). Failed pages count as empty, as before.
 */
async function fetchTasksLegacy(queryString: string, scoped: boolean): Promise<Omit<TaskSearchResult, 'index'>> {
  const maxPages = scoped ? LEGACY_SCOPED_MAX_PAGES : LEGACY_MAX_PAGES;
  const taskLists = await Promise.all([...Array(maxPages)].map(async (_, i) => {
    const url = `https://api.clickup.com/api/v2/team/${CONFIG.teamId}/task?${queryString}&page=${i}`;
    try {
      const res = await fetch(url, {headers: {Authorization: CONFIG.authHeader}});
      return await res.json();
    } catch (e) {
      console.error(`Error fetching page ${i}:`, e);
      return {tasks: []};
    }
  }));
  return {
    tasks: taskLists.flatMap(taskList => taskList.tasks || []),
    pagesFetched: maxPages,
    pageCapReached: false,
  };
}

/**
 * Fetch tasks using the team endpoint, up to TASK_MAX_PAGES pages.
 * Pages are fetched one after another so a short page stops the loop early.
 */
async function fetchTasks(queryString: string): Promise<Omit<TaskSearchResult, 'index'>> {
  const tasks: any[] = [];
  let pagesFetched = 0;
  let pageCapReached = false;
  let warning: string | undefined;

  for (let page = 0; page < TASK_MAX_PAGES; page++) {
    const url = `https://api.clickup.com/api/v2/team/${CONFIG.teamId}/task?${queryString}&page=${page}`;
    let body: any;
    try {
      const res = await fetch(url, {headers: {Authorization: CONFIG.authHeader}});
      body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(`ClickUp API error ${res.status}${body?.err ? `: ${body.err}` : ''}`);
      }
    } catch (e) {
      if (page === 0) throw e;
      console.error(`Error fetching page ${page}:`, e);
      warning = `Fetching page ${page + 1} failed (${e instanceof Error ? e.message : String(e)}), so the results are incomplete.`;
      break;
    }

    const pageTasks: any[] = body.tasks || [];
    pagesFetched++;
    tasks.push(...pageTasks);

    if (pageTasks.length < TASK_PAGE_SIZE || body.last_page === true) break;
    if (page === TASK_MAX_PAGES - 1) pageCapReached = true;
  }

  return {tasks, pagesFetched, pageCapReached, warning};
}

/**
 * Create a Fuse index from tasks array
 */
function createFuseIndex(tasks: any[]): Fuse<any> {
  return new Fuse(tasks, {
    keys: [
      {name: 'name', weight: 0.7},
      {name: 'id', weight: 0.6},
      {name: 'text_content', weight: 0.5},
      {name: 'tags.name', weight: 0.4},
      {name: 'assignees.username', weight: 0.4},
      {name: 'list.name', weight: 0.3},
      {name: 'folder.name', weight: 0.2},
      {name: 'space.name', weight: 0.1}
    ],
    findAllMatches: true,
    includeScore: true,
    minMatchCharLength: 2,
    threshold: 0.4,
  });
}

// ===== LINK UTILITIES =====

/**
 * Generate a ClickUp task URL from a task ID
 */
export function generateTaskUrl(taskId: string): string {
  return `https://app.clickup.com/t/${taskId}`;
}

/**
 * Generate a ClickUp list URL from a list ID
 */
export function generateListUrl(listId: string): string {
  return `https://app.clickup.com/${CONFIG.teamId}/v/li/${listId}`;
}

/**
 * Generate a ClickUp space URL from a space ID
 */
export function generateSpaceUrl(spaceId: string): string {
  return `https://app.clickup.com/${CONFIG.teamId}/v/s/${spaceId}`;
}

/**
 * Generate a ClickUp folder URL from a folder ID
 */
export function generateFolderUrl(folderId: string): string {
  return `https://app.clickup.com/${CONFIG.teamId}/v/f/${folderId}`;
}

/**
 * Generate a ClickUp document URL from a document ID and optional page ID
 */
export function generateDocumentUrl(docId: string, pageId?: string): string {
  if (pageId) {
    return `https://app.clickup.com/${CONFIG.teamId}/v/dc/${docId}/${pageId}`;
  }
  return `https://app.clickup.com/${CONFIG.teamId}/v/dc/${docId}`;
}

/**
 * Format space content as tree structure
 * Shared function used by both searchSpaces tool and space resources
 */
export function formatSpaceTree(space: any, lists: any[], folders: any[], documents: any[]): string {
  const spaceLines: string[] = [];
  const totalLists = lists.length + folders.reduce((sum, f) => sum + (f.lists?.length || 0), 0);

  // Space header
  spaceLines.push(
    `🏢 SPACE: ${space.name} (space_id: ${space.id}${space.private ? ', private' : ''}${space.archived ? ', archived' : ''}) ${generateSpaceUrl(space.id)}`,
    `   ${totalLists} lists, ${folders.length} folders, ${documents.length} documents`
  );

  // Create a tree structure
  const hasDirectLists = lists.length > 0;
  const hasFolders = folders.length > 0;
  const hasDocuments = documents.length > 0;

  // Direct lists (not in folders)
  if (hasDirectLists) {
    lists.forEach((list: any, listIndex) => {
      const isLastDirectList = listIndex === lists.length - 1;
      const isLastOverall = !hasFolders && !hasDocuments && isLastDirectList;
      const treeChar = isLastOverall ? '└──' : '├──';
      const extraInfo = [
        ...(list.task_count ? [`${list.task_count} tasks`] : []),
        ...(list.private ? ['private'] : []),
        ...(list.archived ? ['archived'] : [])
      ].join(', ');
      const listLine = `${treeChar} 📝 ${list.name} (list_id: ${list.id}${extraInfo ? `, ${extraInfo}` : ''}) ${generateListUrl(list.id)}`;
      spaceLines.push(listLine);
    });
  }

  // Folders and their lists
  if (hasFolders) {
    folders.forEach((folder: any, folderIndex) => {
      const isLastFolder = folderIndex === folders.length - 1;
      const isLastOverall = !hasDocuments && isLastFolder;
      const folderTreeChar = isLastOverall ? '└──' : '├──';
      const folderContinuation = isLastOverall ? '   ' : '│  ';
      
      const folderExtraInfo = [
        ...(folder.lists?.length ? [`${folder.lists.length} lists`] : []),
        ...(folder.private ? ['private'] : []),
        ...(folder.archived ? ['archived'] : [])
      ].join(', ');
      
      const folderLine = `${folderTreeChar} 📂 ${folder.name} (folder_id: ${folder.id}${folderExtraInfo ? `, ${folderExtraInfo}` : ''}) ${generateFolderUrl(folder.id)}`;
      spaceLines.push(folderLine);

      // Lists within this folder
      if (folder.lists && folder.lists.length > 0) {
        folder.lists.forEach((list: any, listIndex: number) => {
          const isLastListInFolder = listIndex === folder.lists.length - 1;
          const listTreeChar = isLastListInFolder ? '└──' : '├──';
          const listExtraInfo = [
            ...(list.task_count ? [`${list.task_count} tasks`] : []),
            ...(list.private ? ['private'] : []),
            ...(list.archived ? ['archived'] : [])
          ].join(', ');
          const listLine = `${folderContinuation}${listTreeChar} 📝 ${list.name} (list_id: ${list.id}${listExtraInfo ? `, ${listExtraInfo}` : ''}) ${generateListUrl(list.id)}`;
          spaceLines.push(listLine);
        });
      }
    });
  }

  // Documents attached to this space
  if (hasDocuments) {
    documents.forEach((document: any, docIndex) => {
      const isLastDocument = docIndex === documents.length - 1;
      const docTreeChar = isLastDocument ? '└──' : '├──';
      const docLine = `${docTreeChar} 📄 ${document.name} (doc_id: ${document.id}) ${generateDocumentUrl(document.id)}`;
      spaceLines.push(docLine);
    });
  }

  return spaceLines.join('\n');
}

// Space search index cache - cache promise to prevent race conditions
const spaceSearchIndexPromises = new Map<string, Promise<Fuse<any> | null>>();

/**
 * Looks up a space name in the cached space list (one request per user per minute for all spaces).
 * Returns undefined when the space is not in the list or the list could not be loaded.
 */
export async function getSpaceNameFromIndex(spaceId: string): Promise<string | undefined> {
  const index = await getSpaceSearchIndex();
  const spaces: any[] = (index as any)?._docs ?? [];
  const name = spaces.find(space => String(space.id) === String(spaceId))?.name;
  return typeof name === 'string' && name ? name : undefined;
}

/**
 * Get or refresh the space search index
 * Caches promise to prevent race conditions on concurrent calls
 */
export async function getSpaceSearchIndex(): Promise<Fuse<any> | null> {
  // Return cached promise if available
  const userKey = credentialCacheKey();
  const cachedIndex = spaceSearchIndexPromises.get(userKey);
  if (cachedIndex) {
    return cachedIndex;
  }

  // Create the fetch promise
  const fetchPromise = (async (): Promise<Fuse<any> | null> => {
    try {
      const url = `https://api.clickup.com/api/v2/team/${CONFIG.teamId}/space`;
      const response = await fetch(url, {
        headers: { Authorization: CONFIG.authHeader },
      });

      if (!response.ok) {
        throw new Error(`Error fetching spaces: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const spacesData = data.spaces || [];

      // Create Fuse search index
      return new Fuse(spacesData as any[], {
        keys: [
          { name: 'name', weight: 0.7 },
          { name: 'id', weight: 0.6 }
        ],
        includeScore: true,
        threshold: 0.4,
        minMatchCharLength: 1,
      });
    } catch (error) {
      console.error('Error creating space search index:', error);
      return null;
    }
  })();

  // Cache the promise
  spaceSearchIndexPromises.set(userKey, fetchPromise);

  // Auto-cleanup after 60 seconds
  setTimeout(() => {
    spaceSearchIndexPromises.delete(userKey);
    console.error('Auto-cleaned space search index');
  }, GLOBAL_REFRESH_INTERVAL);

  return fetchPromise;
}


const listCache = new Map<string, Promise<any>>(); // Cache for space lists/folders

/**
 * Get lists, folders, and documents for a specific space with caching
 */
export async function getSpaceContent(spaceId: string): Promise<{ lists: any[], folders: any[], documents: any[] }> {
  const cacheKey = `${credentialCacheKey()}:space-content-${spaceId}`;
  
  // Check cache first
  const cachedContent = listCache.get(cacheKey);
  if (cachedContent) {
    return cachedContent;
  }

  // Fetch content with parallel requests
  const fetchPromise = (async () => {
    try {
      const [folders, lists, documents] = await Promise.all([
        fetch(`https://api.clickup.com/api/v2/space/${spaceId}/folder`, {
          headers: {Authorization: CONFIG.authHeader},
        })
          .then(response => response.json())
          .then(json => json.folders || [])
          .catch(e => {
            console.error(e);
            return []
          }),
        fetch(`https://api.clickup.com/api/v2/space/${spaceId}/list`, {
          headers: {Authorization: CONFIG.authHeader},
        })
          .then(response => response.json())
          .then(json => json.lists || [])
          .catch(e => {
            console.error(e);
            return []
          }),
        fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs?parent_id=${spaceId}`, {
          headers: {Authorization: CONFIG.authHeader},
        })
          .then(response => response.json())
          .then(json => json.docs || [])
          .catch(e => {
            console.error(e);
            return []
          })
      ]);

      // For each folder, also fetch its lists
      const folderListPromises = folders.map(async (folder: any) => {
        try {
          const folderListResponse = await fetch(
            `https://api.clickup.com/api/v2/folder/${folder.id}/list`,
            { headers: { Authorization: CONFIG.authHeader } }
          );
          if (folderListResponse.ok) {
            const folderListData = await folderListResponse.json();
            folder.lists = folderListData.lists || [];
          }
          return folder;
        } catch (error) {
          console.error(`Error fetching lists for folder ${folder.id}:`, error);
          folder.lists = [];
          return folder;
        }
      });

      const foldersWithLists = await Promise.all(folderListPromises);

      return { lists, folders: foldersWithLists, documents };
    } catch (error) {
      console.error(`Error fetching space content for ${spaceId}:`, error);
      return { lists: [], folders: [], documents: [] };
    }
  })();

  // Cache the promise
  listCache.set(cacheKey, fetchPromise);
  
  // Auto-cleanup after 60 seconds
  setTimeout(() => {
    listCache.delete(cacheKey);
    console.error(`Auto-cleaned space content cache for ${spaceId}`);
  }, GLOBAL_REFRESH_INTERVAL);

  return fetchPromise;
}

const spaceHierarchyCache = new Map<string, Promise<{ lists: any[], folders: any[] }>>();

/**
 * Folders (each with its embedded lists) and folderless lists of a space: exactly 2 requests,
 * cached per user as a promise. Failures throw (and are not cached) so callers can report them.
 */
export function getSpaceHierarchy(spaceId: string): Promise<{ lists: any[], folders: any[] }> {
  const cacheKey = `${credentialCacheKey()}:space-hierarchy-${spaceId}`;
  const cached = spaceHierarchyCache.get(cacheKey);
  if (cached) return cached;

  const get = async (path: string, field: string): Promise<any[]> => {
    const response = await fetch(`https://api.clickup.com/api/v2/space/${spaceId}/${path}`, {
      headers: { Authorization: CONFIG.authHeader },
    });
    if (!response.ok) {
      throw new Error(`Error fetching ${path}s of space ${spaceId}: ${response.status} ${response.statusText}`);
    }
    const json = await response.json();
    return json[field] || [];
  };

  const promise = Promise.all([get("folder", "folders"), get("list", "lists")])
    .then(([folders, lists]) => ({ folders, lists }));
  spaceHierarchyCache.set(cacheKey, promise);
  promise.catch(() => spaceHierarchyCache.delete(cacheKey));
  setTimeout(() => spaceHierarchyCache.delete(cacheKey), GLOBAL_REFRESH_INTERVAL);
  return promise;
}

// Cache for team members to avoid repeated API calls and race conditions
const cachedTeamMembersPromises = new Map<string, Promise<string[]>>();

/**
 * Gets all team members from ClickUp API with caching
 */
export async function getAllTeamMembers(): Promise<string[]> {
  // Return cached promise if available
  const userKey = credentialCacheKey();
  const cachedMembers = cachedTeamMembersPromises.get(userKey);
  if (cachedMembers) {
    return cachedMembers;
  }

  // Create the fetch promise
  const fetchPromise = (async (): Promise<string[]> => {
    try {
      const response = await fetch(`https://api.clickup.com/api/v2/team`, {
        headers: { Authorization: CONFIG.authHeader },
      });

      if (!response.ok) {
        console.error(`Error fetching teams: ${response.status} ${response.statusText}`);
        return [];
      }

      const data = await response.json();
      if (!data.teams || !Array.isArray(data.teams)) {
        return [];
      }

      // Find the team that matches our configured team ID and extract all user IDs
      const currentTeam = data.teams.find((team: any) => team.id === CONFIG.teamId);
      if (!currentTeam || !currentTeam.members || !Array.isArray(currentTeam.members)) {
        console.error(`Team ${CONFIG.teamId} not found or has no members`);
        return [];
      }

      return currentTeam.members.map((member: any) => member.user?.id).filter(Boolean);
    } catch (error) {
      console.error('Error fetching team members:', error);
      return [];
    }
  })();

  // Cache the promise
  cachedTeamMembersPromises.set(userKey, fetchPromise);
  
  // Auto-cleanup after 60 seconds
  setTimeout(() => {
    cachedTeamMembersPromises.delete(userKey);
    console.error(`Auto-cleaned team members cache`);
  }, GLOBAL_REFRESH_INTERVAL);
  
  return fetchPromise;
}

/**
 * Performs multi-term search with aggressive boosting for items matching multiple terms
 * @param searchIndex Fuse search index to search within
 * @param terms Array of search terms
 * @returns Array of items sorted by relevance (multi-term matches ranked higher)
 */
export async function performMultiTermSearch<T>(
  searchIndex: Fuse<T>,
  terms: string[]
): Promise<T[]> {
  // Filter valid search terms
  const validTerms = terms.filter(term => term && term.trim().length > 0);
  if (validTerms.length === 0) {
    return [];
  }

  // Track multiple matches per item for aggressive boosting
  const itemMatches = new Map<string, {
    item: T,
    scores: number[],
    matchedTerms: string[]
  }>();

  // Collect all matches for each term
  validTerms.forEach(term => {
    const results = searchIndex.search(term);
    results.forEach(result => {
      if (result.item && typeof (result.item as any).id === 'string') {
        const itemId = (result.item as any).id;
        const currentScore = result.score ?? 1;
        const existing = itemMatches.get(itemId);
        
        if (!existing) {
          itemMatches.set(itemId, {
            item: result.item,
            scores: [currentScore],
            matchedTerms: [term]
          });
        } else {
          existing.scores.push(currentScore);
          existing.matchedTerms.push(term);
        }
      }
    });
  });

  // Calculate aggressively boosted scores for multi-term matches
  const uniqueResults = new Map<string, { item: T, score: number }>();
  itemMatches.forEach((match, itemId) => {
    const bestScore = Math.min(...match.scores);
    const matchCount = match.scores.length;
    const totalTerms = validTerms.length;
    
    // Aggressive multi-term boost: exponential improvement for multiple matches
    // 1 match: base score
    // 2+ matches: exponentially better score based on match ratio
    const matchRatio = matchCount / totalTerms;
    const boostFactor = Math.pow(0.1, matchRatio * 4); // Very aggressive boost
    const finalScore = bestScore * boostFactor;
    
    uniqueResults.set(itemId, {
      item: match.item,
      score: finalScore
    });
  });


  // Return sorted results (best scores first)
  return Array.from(uniqueResults.values())
    .sort((a, b) => a.score - b.score)
    .map(entry => entry.item);
}

// Workspace document listing cache - cache promise to prevent race conditions
const workspaceDocsPromises = new Map<string, Promise<{ docs: any[], capped: boolean }>>();
const DOCS_PAGE_SIZE = 100;
export const DOCS_MAX_PAGES = 10;

/**
 * Lists workspace documents via the v3 docs API (cursor paged, capped at DOCS_MAX_PAGES requests).
 * Optionally restricted to a space. Caches the promise per user for 60 s; failed fetches are not kept.
 */
export async function getWorkspaceDocs(spaceId?: string): Promise<{ docs: any[], capped: boolean }> {
  const cacheKey = `${credentialCacheKey()}:workspace-docs:${spaceId ?? 'all'}`;
  const cached = workspaceDocsPromises.get(cacheKey);
  if (cached) {
    return cached;
  }

  const fetchPromise = (async () => {
    const docs: any[] = [];
    let cursor: string | undefined;
    let capped = false;
    for (let page = 0; page < DOCS_MAX_PAGES; page++) {
      const params = new URLSearchParams({ limit: String(DOCS_PAGE_SIZE) });
      if (spaceId) {
        params.set('parent_id', spaceId);
        params.set('parent_type', 'SPACE');
      }
      if (cursor) {
        params.set('next_cursor', cursor);
      }
      const response = await fetch(`https://api.clickup.com/api/v3/workspaces/${CONFIG.teamId}/docs?${params.toString()}`, {
        headers: { Authorization: CONFIG.authHeader },
      });
      if (!response.ok) {
        throw new Error(`Error fetching documents: ${response.status} ${response.statusText}`);
      }
      const json: any = await response.json();
      docs.push(...(Array.isArray(json.docs) ? json.docs : []));
      cursor = json.next_cursor || undefined;
      if (!cursor) {
        break;
      }
      if (page === DOCS_MAX_PAGES - 1) {
        capped = true;
      }
    }
    return { docs, capped };
  })();

  workspaceDocsPromises.set(cacheKey, fetchPromise);
  fetchPromise.catch(() => workspaceDocsPromises.delete(cacheKey));

  setTimeout(() => {
    workspaceDocsPromises.delete(cacheKey);
    console.error('Auto-cleaned workspace docs cache');
  }, GLOBAL_REFRESH_INTERVAL);

  return fetchPromise;
}
