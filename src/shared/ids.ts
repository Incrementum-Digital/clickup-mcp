/**
 * Validates an ID before it is interpolated into a ClickUp URL path. Prevents path traversal
 * such as task_id="../list/123". Task IDs are alphanumeric, custom task IDs look like ABC-123,
 * list/folder/space IDs are digits.
 */
export function assertSafeId(value: string, label: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(`Invalid ${label} "${value}"`);
  }
  return trimmed;
}
