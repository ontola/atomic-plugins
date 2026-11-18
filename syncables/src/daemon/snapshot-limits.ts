export interface SnapshotLimits {
  maxRecords: number;
  maxBytes: number;
}

/** Explicit collection publication budgets, also retained with accepted history. */
export function snapshotLimits(value: unknown): SnapshotLimits {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid snapshotLimits');
  const limits = value as Record<string, unknown>;
  if (
    Object.keys(limits).some(
      (key) => key !== 'maxRecords' && key !== 'maxBytes',
    ) ||
    !Number.isSafeInteger(limits.maxRecords) ||
    !Number.isSafeInteger(limits.maxBytes) ||
    Number(limits.maxRecords) < 1 ||
    Number(limits.maxRecords) > 500_000 ||
    Number(limits.maxBytes) < 1 ||
    Number(limits.maxBytes) > 512 * 1024 * 1024
  )
    throw new Error(
      'snapshotLimits requires maxRecords (1–500000) and maxBytes (1–536870912)',
    );
  return {
    maxRecords: Number(limits.maxRecords),
    maxBytes: Number(limits.maxBytes),
  };
}
