/** Removes duplicate values while preserving their first-seen order. */
export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Compares strings for stable, case-insensitive user-facing ordering. */
export function compareNames(left: string, right: string): number {
  return left.localeCompare(right, undefined, { sensitivity: "base" });
}
