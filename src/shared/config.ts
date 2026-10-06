import { getRequestCredentials } from "./request-context";

export const rawPrimaryLang = process.env.CLICKUP_PRIMARY_LANGUAGE || process.env.LANG;
let detectedLanguageHint: string | undefined = undefined;

/**
 * Enhanced language detection that handles various formats and common language names
 */
function detectLanguage(rawLang: string): string | undefined {
  if (!rawLang) return undefined;
  
  const normalizedLang = rawLang.toLowerCase().trim();
  
  // German language detection
  if (normalizedLang === 'de' || normalizedLang === 'german' || normalizedLang === 'deutsch' || normalizedLang.startsWith('de_') || normalizedLang.startsWith('de-')) {
    return 'de';
  }
  
  // English language detection
  if (normalizedLang === 'en' || normalizedLang === 'english' || normalizedLang.startsWith('en_') || normalizedLang.startsWith('en-')) {
    return 'en';
  }
  
  // French language detection
  if (normalizedLang === 'fr' || normalizedLang === 'french' || normalizedLang === 'français' || normalizedLang.startsWith('fr_') || normalizedLang.startsWith('fr-')) {
    return 'fr';
  }
  
  // Spanish language detection
  if (normalizedLang === 'es' || normalizedLang === 'spanish' || normalizedLang === 'español' || normalizedLang.startsWith('es_') || normalizedLang.startsWith('es-')) {
    return 'es';
  }
  
  // Italian language detection
  if (normalizedLang === 'it' || normalizedLang === 'italian' || normalizedLang === 'italiano' || normalizedLang.startsWith('it_') || normalizedLang.startsWith('it-')) {
    return 'it';
  }
  
  // Fallback: extract the primary language part (e.g., 'en' from 'en_US.UTF-8' or 'en-GB')
  const langPart = normalizedLang.match(/^[a-zA-Z]{2,3}/);
  if (langPart) {
    return langPart[0].toLowerCase();
  }
  
  return undefined;
}

if (rawPrimaryLang) {
  detectedLanguageHint = detectLanguage(rawPrimaryLang);
}

// MCP Mode configuration
export type McpMode = 'read-minimal' | 'read' | 'write';
const rawMode = process.env.CLICKUP_MCP_MODE?.toLowerCase();
let mcpMode: McpMode = 'write'; // Default to write (full functionality)

if (rawMode === 'read-minimal' || rawMode === 'read') {
  mcpMode = rawMode;
} else if (rawMode && rawMode !== 'write') {
  console.error(`Invalid CLICKUP_MCP_MODE "${rawMode}". Using default "write". Valid options: read-minimal, read, write`);
}

/**
 * Numeric settings are exposed as optional MCPB user_config fields, so their env
 * values can arrive blank or - if the host does not substitute an unset optional
 * field - as the literal `${user_config.x}` placeholder. Both mean "not configured"
 * and must fall back to the default rather than fail or turn into NaN.
 */
export function readOptionalEnv(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  if (!raw || /^\$\{.*}$/.test(raw)) {
    return undefined;
  }
  return raw;
}

/**
 * A typo must not silently change a limit: `parseFloat("Infinity")` would disable
 * the comment age check altogether and `parseFloat("abc")` would yield NaN, which
 * compares false against every size and so lifts the upload limit instead of
 * enforcing it. Fail at startup instead.
 */
function parseNumericEnv(
  name: string,
  fallback: number,
  { min, expectation }: { min: number; expectation: string }
): number {
  const raw = readOptionalEnv(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`Invalid ${name} "${raw}". ${expectation}`);
  }
  return value;
}

/**
 * Personal tokens (`pk_...`) are sent raw; OAuth access tokens need the `Bearer` scheme.
 */
export function formatAuthHeader(token: string): string {
  return /^pk_/.test(token) ? token : `Bearer ${token}`;
}

// Inside runWithCredentials() (HTTP mode) the getters below read the request's credentials
// instead, so concurrent users never see each other's token.
//
// Credentials are mutable module state: they are seeded from the environment at load
// (so the synchronous env path keeps working) and filled in later by ensureCredentials()
// when they come from a token file, an OAuth flow or team auto-detection.
let currentToken: string | undefined = readOptionalEnv("CLICKUP_API_KEY");
let currentTeamId: string | undefined = readOptionalEnv("CLICKUP_TEAM_ID");

export function setCredentials(token: string, teamId: string): void {
  currentToken = token;
  currentTeamId = teamId;
}

function credentialsNotResolved(): Error {
  return new Error(
    "ClickUp credentials not resolved yet. ensureCredentials() must complete before any API call."
  );
}

export const CONFIG = {
  get apiKey(): string {
    const token = getRequestCredentials()?.token ?? currentToken;
    if (!token) throw credentialsNotResolved();
    return token;
  },
  get authHeader(): string {
    const token = getRequestCredentials()?.token ?? currentToken;
    if (!token) throw credentialsNotResolved();
    return formatAuthHeader(token);
  },
  get teamId(): string {
    const teamId = getRequestCredentials()?.teamId ?? currentTeamId;
    if (!teamId) throw credentialsNotResolved();
    return teamId;
  },
  maxImages: process.env.MAX_IMAGES ? parseInt(process.env.MAX_IMAGES) : 4,
  maxResponseSizeMB: process.env.MAX_RESPONSE_SIZE_MB ? parseFloat(process.env.MAX_RESPONSE_SIZE_MB) : 1,
  // Upper bound for a single image uploaded to ClickUp. Unlike maxResponseSizeMB this is
  // not about context window budget - it only guards against accidentally pushing huge
  // files into a ticket.
  maxUploadSizeMB: parseNumericEnv("MAX_UPLOAD_SIZE_MB", 10, {
    min: 1,
    expectation: "Expected a positive number of megabytes.",
  }),
  // How long after creation a comment may still be edited. ClickUp has no way to tell
  // "written by this MCP" apart from "written by the token owner in the UI", so this
  // window is the actual guard against rewriting history. 0 disables editing entirely.
  commentEditWindowHours: parseNumericEnv("CLICKUP_COMMENT_EDIT_WINDOW_HOURS", 24, {
    min: 0,
    expectation: "Expected a non-negative number of hours (0 disables editComment).",
  }),
  primaryLanguageHint: detectedLanguageHint, // Store the cleaned code directly
  mode: mcpMode,
};
