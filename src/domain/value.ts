export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
