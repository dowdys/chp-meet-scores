/**
 * Tool argument validation utilities.
 * Replaces unsafe `as string` casts with runtime type checks.
 */

export function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string') throw new Error(`Expected string for '${key}', got ${typeof val}`);
  return val;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') throw new Error(`Expected string for '${key}', got ${typeof val}`);
  return val;
}

export function requireArray(args: Record<string, unknown>, key: string): unknown[] {
  const val = args[key];
  if (!Array.isArray(val)) throw new Error(`Expected array for '${key}', got ${typeof val}`);
  return val;
}

export function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number') throw new Error(`Expected number for '${key}', got ${typeof val}`);
  return val;
}
