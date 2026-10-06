import { CONFIG } from "./config";
import { credentialCacheKey } from "./request-context";
import { resolveAssignees } from "./members";

const GLOBAL_REFRESH_INTERVAL = 60000; // 60 seconds - that is the rate limit time frame

/** Upper bound of custom fields written by one setTaskCustomFields call (one API call each). */
export const MAX_CUSTOM_FIELDS_PER_CALL = 20;

export interface CustomFieldOption {
  id: string;
  name?: string;
  label?: string;
  orderindex?: number;
  color?: string | null;
}

export interface CustomFieldDefinition {
  id: string;
  name: string;
  type: string;
  type_config?: { options?: CustomFieldOption[]; [key: string]: unknown };
  required?: boolean;
}

export interface CustomFieldScope {
  list_id?: string;
  folder_id?: string;
  space_id?: string;
}

/** Display name of a dropdown/label option - dropdowns use `name`, labels use `label`. */
export function optionName(option: CustomFieldOption): string {
  return option.name ?? option.label ?? "";
}

function scopeTarget(scope: CustomFieldScope): { kind: "list" | "folder" | "space"; id: string } {
  const given = (
    [
      ["list", scope.list_id],
      ["folder", scope.folder_id],
      ["space", scope.space_id],
    ] as const
  ).filter(([, id]) => Boolean(id));
  if (given.length !== 1) {
    throw new Error("Pass exactly one of list_id, folder_id or space_id to look up custom fields.");
  }
  return { kind: given[0][0], id: given[0][1] as string };
}

// Cache promises, not results, so concurrent calls share one request.
// Keyed by user + scope so users of a multi-user server never share entries.
const definitionPromises = new Map<string, Promise<CustomFieldDefinition[]>>();

/** Custom field definitions visible in a list, folder or space, cached for 60 s per user and scope. */
export function getCustomFieldDefinitions(scope: CustomFieldScope): Promise<CustomFieldDefinition[]> {
  const { kind, id } = scopeTarget(scope);
  const key = `${credentialCacheKey()}:${kind}:${id}`;
  const cached = definitionPromises.get(key);
  if (cached) {
    return cached;
  }

  const fetchPromise = (async (): Promise<CustomFieldDefinition[]> => {
    const response = await fetch(`https://api.clickup.com/api/v2/${kind}/${encodeURIComponent(id)}/field`, {
      headers: { Authorization: CONFIG.authHeader },
    });
    if (!response.ok) {
      throw new Error(`Error fetching custom fields of ${kind} ${id}: ${response.status} ${response.statusText}`);
    }
    const data = await response.json();
    return Array.isArray(data.fields) ? data.fields : [];
  })();

  definitionPromises.set(key, fetchPromise);
  fetchPromise.catch(() => {
    if (definitionPromises.get(key) === fetchPromise) {
      definitionPromises.delete(key);
    }
  });

  // Auto-cleanup after 60 seconds
  setTimeout(() => {
    definitionPromises.delete(key);
    console.error(`Auto-cleaned custom field cache for ${kind} ${id}`);
  }, GLOBAL_REFRESH_INTERVAL);

  return fetchPromise;
}

export interface CustomFieldValue {
  value: unknown;
  /** `{ time: true }` for a date field whose value includes a time of day */
  value_options?: { time: true };
}

function describeOptions(options: CustomFieldOption[]): string {
  return options.length > 0
    ? options.map((o) => `"${optionName(o)}" (option_id: ${o.id})`).join(", ")
    : "(this field has no options)";
}

function pickOption(field: CustomFieldDefinition, raw: unknown): string {
  const options = field.type_config?.options ?? [];
  const text = String(raw ?? "").trim();
  const byId = options.find((o) => o.id === text);
  if (byId) {
    return byId.id;
  }
  const lowered = text.toLowerCase();
  const byName = options.filter((o) => optionName(o).toLowerCase() === lowered);
  if (byName.length === 1) {
    return byName[0].id;
  }
  if (byName.length > 1) {
    throw new Error(
      `Option "${text}" is ambiguous for custom field "${field.name}". Use one of the option ids: ${describeOptions(byName)}`
    );
  }
  throw new Error(`Unknown option "${text}" for custom field "${field.name}". Valid options: ${describeOptions(options)}`);
}

function toList(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [raw];
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function toText(field: CustomFieldDefinition, raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  throw new Error(`Custom field "${field.name}" (type ${field.type}) needs a text value.`);
}

function toNumber(field: CustomFieldDefinition, raw: unknown): number {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new Error(`Custom field "${field.name}" (type ${field.type}) needs a number, got ${JSON.stringify(raw)}.`);
  }
  return n;
}

function toBoolean(field: CustomFieldDefinition, raw: unknown): boolean {
  if (typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "string") {
    const lowered = raw.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  throw new Error(`Custom field "${field.name}" (checkbox) needs true or false, got ${JSON.stringify(raw)}.`);
}

function toDate(field: CustomFieldDefinition, raw: unknown): CustomFieldValue {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return { value: raw, ...(raw % 86400000 !== 0 ? { value_options: { time: true as const } } : {}) };
  }
  if (typeof raw === "string") {
    const text = raw.trim();
    if (/^\d+$/.test(text)) {
      return toDate(field, Number(text));
    }
    const ms = Date.parse(text);
    if (!Number.isNaN(ms)) {
      // A time of day ("T14:30", " 14:30") switches on ClickUp's time display for the field.
      const hasTime = /[T\s]\d{1,2}:\d{2}/.test(text);
      return { value: ms, ...(hasTime ? { value_options: { time: true as const } } : {}) };
    }
  }
  throw new Error(
    `Custom field "${field.name}" (date) needs an ISO date such as "2025-12-31" or "2025-12-31T14:30:00+01:00", or Unix milliseconds, got ${JSON.stringify(raw)}.`
  );
}

async function toUsers(field: CustomFieldDefinition, raw: unknown): Promise<{ add: number[]; rem: number[] }> {
  const spec = isPlainObject(raw) ? raw : { add: toList(raw) };
  const resolve = async (list: unknown): Promise<number[]> =>
    (await resolveAssignees(toList(list ?? []).map(String))).map(Number);
  if (isPlainObject(raw) && !("add" in raw) && !("rem" in raw)) {
    throw new Error(`Custom field "${field.name}" (users) needs a list of users or { "add": [...], "rem": [...] }.`);
  }
  return { add: await resolve(spec.add), rem: await resolve(spec.rem) };
}

function toTasks(field: CustomFieldDefinition, raw: unknown): { add: string[]; rem: string[] } {
  if (isPlainObject(raw) && !("add" in raw) && !("rem" in raw)) {
    throw new Error(`Custom field "${field.name}" (tasks) needs a list of task ids or { "add": [...], "rem": [...] }.`);
  }
  const spec = isPlainObject(raw) ? raw : { add: toList(raw) };
  const ids = (list: unknown) => toList(list ?? []).map((id) => String(id).trim()).filter(Boolean);
  return { add: ids(spec.add), rem: ids(spec.rem) };
}

function toLocation(field: CustomFieldDefinition, raw: unknown): unknown {
  const location = isPlainObject(raw) && isPlainObject(raw.location) ? raw.location : undefined;
  if (
    !location ||
    typeof location.lat !== "number" ||
    typeof location.lng !== "number" ||
    typeof (raw as Record<string, unknown>).formatted_address !== "string"
  ) {
    throw new Error(
      `Custom field "${field.name}" (location) needs { "location": { "lat": number, "lng": number }, "formatted_address": string }.`
    );
  }
  return raw;
}

const SUPPORTED_TYPES = [
  "text", "short_text", "url", "email", "phone", "number", "currency", "checkbox",
  "date", "drop_down", "labels", "users", "tasks", "location",
];

/**
 * Convert a model-friendly value into the shape the ClickUp "set custom field"
 * endpoint expects for the field's type. Throws a descriptive error when the value
 * does not fit; unsupported types (formula, rollup, attachments, ...) are rejected
 * by name.
 */
export async function buildCustomFieldValue(field: CustomFieldDefinition, rawValue: unknown): Promise<CustomFieldValue> {
  switch (field.type) {
    case "text":
    case "short_text":
    case "url":
    case "email":
    case "phone":
      return { value: toText(field, rawValue) };
    case "number":
    case "currency":
      return { value: toNumber(field, rawValue) };
    case "checkbox":
      return { value: toBoolean(field, rawValue) };
    case "date":
      return toDate(field, rawValue);
    case "drop_down":
      return { value: pickOption(field, rawValue) };
    case "labels":
      return { value: toList(rawValue).map((entry) => pickOption(field, entry)) };
    case "users":
      return { value: await toUsers(field, rawValue) };
    case "tasks":
      return { value: toTasks(field, rawValue) };
    case "location":
      return { value: toLocation(field, rawValue) };
    default:
      throw new Error(
        `Custom field "${field.name}" has type "${field.type}", which cannot be set through this tool. Supported types: ${SUPPORTED_TYPES.join(", ")}.`
      );
  }
}

/** Find a field by id, then by case-insensitive name. Throws on unknown or ambiguous keys. */
export function findCustomField(fields: CustomFieldDefinition[], key: string): CustomFieldDefinition {
  const byId = fields.find((f) => f.id === key);
  if (byId) {
    return byId;
  }
  const lowered = key.trim().toLowerCase();
  const byName = fields.filter((f) => f.name.trim().toLowerCase() === lowered);
  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length > 1) {
    throw new Error(
      `Custom field name "${key}" is ambiguous: ${byName.map((f) => `${f.name} (field_id: ${f.id})`).join(", ")}. Use the field id.`
    );
  }
  const available = fields.map((f) => `"${f.name}" (field_id: ${f.id}, type: ${f.type})`).join(", ");
  throw new Error(`Unknown custom field "${key}". Available fields: ${available || "(none)"}`);
}

function assertFieldCount(fields: Record<string, unknown>): string[] {
  const keys = Object.keys(fields);
  if (keys.length > MAX_CUSTOM_FIELDS_PER_CALL) {
    throw new Error(`At most ${MAX_CUSTOM_FIELDS_PER_CALL} custom fields can be set per call, got ${keys.length}.`);
  }
  return keys;
}

export interface CreateCustomField {
  id: string;
  value: unknown;
  value_options?: { time: true };
}

/**
 * Build the `custom_fields` array of the create-task body from a field-name-or-id
 * keyed record. Everything is validated up front and any problem throws, so a task
 * is never created with half of its fields. `null` values are skipped: a new task
 * has nothing to clear. `names` maps each field id to its display name for reporting.
 */
export async function buildCreateCustomFields(
  list_id: string,
  fields: Record<string, unknown>
): Promise<{ fields: CreateCustomField[]; names: Record<string, string> }> {
  const keys = assertFieldCount(fields);
  const result: CreateCustomField[] = [];
  const names: Record<string, string> = {};
  if (keys.length === 0) {
    return { fields: result, names };
  }
  const definitions = await getCustomFieldDefinitions({ list_id });
  for (const key of keys) {
    if (fields[key] === null) {
      continue;
    }
    const field = findCustomField(definitions, key);
    const built = await buildCustomFieldValue(field, fields[key]);
    result.push({ id: field.id, ...built });
    names[field.id] = field.name;
  }
  return { fields: result, names };
}

function hasStoredValue(entry: any, submitted: CreateCustomField, type?: string): boolean {
  if (!entry) {
    return false;
  }
  const value = entry.value;
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
    // ClickUp omits the value of an unchecked checkbox, so a submitted `false`
    // cannot be told apart from "stored" - the field being listed is all there is.
    return type === "checkbox" && submitted.value === false;
  }
  return true;
}

export interface CreatedFieldReport {
  field_id: string;
  name: string;
  saved: boolean;
}

/**
 * ClickUp silently drops custom fields that do not apply to a task (for example a
 * field restricted to another task type). Compare what was submitted with the
 * `custom_fields` of the task as it exists now.
 */
export function checkCreatedCustomFields(
  task: any,
  submitted: CreateCustomField[],
  names: Record<string, string>
): CreatedFieldReport[] {
  const present: any[] = Array.isArray(task?.custom_fields) ? task.custom_fields : [];
  return submitted.map((sent) => {
    const entry = present.find((cf) => cf.id === sent.id);
    return {
      field_id: sent.id,
      name: names[sent.id] ?? entry?.name ?? sent.id,
      saved: hasStoredValue(entry, sent, entry?.type),
    };
  });
}

/** Response lines for a checkCreatedCustomFields result. */
export function formatCreatedCustomFields(reports: CreatedFieldReport[]): string[] {
  if (reports.length === 0) {
    return [];
  }
  return [
    "custom_fields:",
    ...reports.map(
      (r) =>
        `  - ${r.name} (field_id: ${r.field_id}): ` +
        (r.saved ? "set" : "not saved by ClickUp, the field may not apply to this task type")
    ),
  ];
}

export interface PreparedCustomFieldWrite {
  key: string;
  field: CustomFieldDefinition;
  /** `null` = clear the value (DELETE), otherwise the converted body to POST */
  body: CustomFieldValue | null;
}

/**
 * Validate every custom field of an update BEFORE anything is written: load the
 * list's definitions, match each key and convert each value. Any problem (the
 * definitions cannot be loaded, an unknown field, an invalid value) throws, so the
 * caller can abort without having changed the task.
 */
export async function prepareCustomFieldWrites(
  list_id: string,
  fields: Record<string, unknown>
): Promise<PreparedCustomFieldWrite[]> {
  const keys = assertFieldCount(fields);
  if (keys.length === 0) {
    return [];
  }
  const definitions = await getCustomFieldDefinitions({ list_id });
  const writes: PreparedCustomFieldWrite[] = [];
  const problems: string[] = [];
  for (const key of keys) {
    try {
      const field = findCustomField(definitions, key);
      writes.push({ key, field, body: fields[key] === null ? null : await buildCustomFieldValue(field, fields[key]) });
    } catch (error) {
      problems.push(`${key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Invalid custom field(s) - ${problems.join("; ")}`);
  }
  return writes;
}

export interface CustomFieldWriteResult {
  set: Array<{ field_id: string; name: string; cleared?: boolean }>;
  failed: Array<{ field: string; error: string }>;
}

/** Send prepared writes sequentially. A failing field is reported and does not stop the others. */
export async function executeCustomFieldWrites(
  task_id: string,
  writes: PreparedCustomFieldWrite[]
): Promise<CustomFieldWriteResult> {
  const result: CustomFieldWriteResult = { set: [], failed: [] };
  for (const { key, field, body } of writes) {
    try {
      const url = `https://api.clickup.com/api/v2/task/${task_id}/field/${field.id}`;
      const response =
        body === null
          ? await fetch(url, { method: "DELETE", headers: { Authorization: CONFIG.authHeader } })
          : await fetch(url, {
              method: "POST",
              headers: { Authorization: CONFIG.authHeader, "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });

      if (!response.ok) {
        const errorData = await response.text().catch(() => "");
        throw new Error(`${response.status} ${response.statusText}${errorData ? ` - ${errorData}` : ""}`);
      }
      result.set.push({ field_id: field.id, name: field.name, ...(body === null ? { cleared: true } : {}) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to set custom field "${key}":`, message);
      result.failed.push({ field: key, error: message });
    }
  }
  return result;
}

/**
 * Set (or, for `null`, clear) custom field values of an existing task - the update
 * endpoint of ClickUp does not take custom fields, so every field is its own
 * request. Fields are matched by id or case-insensitive name against the list's
 * definitions and written sequentially; a problem with one field is reported in
 * `failed` and does not stop the others. (updateTask uses prepareCustomFieldWrites
 * first so that nothing is written when a field is invalid.)
 */
export async function setTaskCustomFields(
  task_id: string,
  list_id: string,
  fields: Record<string, unknown>
): Promise<CustomFieldWriteResult> {
  const keys = assertFieldCount(fields);
  if (keys.length === 0) {
    return { set: [], failed: [] };
  }

  const definitions = await getCustomFieldDefinitions({ list_id });
  const writes: PreparedCustomFieldWrite[] = [];
  const failed: CustomFieldWriteResult["failed"] = [];
  for (const key of keys) {
    try {
      const field = findCustomField(definitions, key);
      writes.push({ key, field, body: fields[key] === null ? null : await buildCustomFieldValue(field, fields[key]) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to set custom field "${key}":`, message);
      failed.push({ field: key, error: message });
    }
  }

  const result = await executeCustomFieldWrites(task_id, writes);
  result.failed.unshift(...failed);
  return result;
}

/** Response lines for a custom field write result. */
export function formatCustomFieldResult(result: CustomFieldWriteResult): string[] {
  const lines: string[] = [];
  if (result.set.length > 0) {
    lines.push(
      "custom_fields_set: " +
        result.set.map((f) => `${f.name} (field_id: ${f.field_id})${f.cleared ? " cleared" : ""}`).join(", ")
    );
  }
  if (result.failed.length > 0) {
    lines.push("custom_field_warnings: " + result.failed.map((f) => `${f.field}: ${f.error}`).join("; "));
  }
  return lines;
}
