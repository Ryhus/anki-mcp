export function compareByName(
  left: { name: string },
  right: { name: string },
): number {
  return left.name.localeCompare(right.name);
}

export function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
