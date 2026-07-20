/**
 * Shared limit/offset slicing for tools that return a list.
 *
 * The clamping matters and is deliberately done here rather than left to the zod input
 * schemas: those only guard the MCP transport, and every tool function is also exported and
 * called directly. A negative offset would otherwise reach `Array.slice` and return the LAST
 * n items as though they were the first, and a fractional limit would return nothing while
 * still reporting a non-zero total.
 */

export interface PagedResult<T> {
  total: number;
  returned: number;
  offset: number;
  items: T[];
}

export function applyPaging<T>(
  items: readonly T[],
  limit: number | undefined,
  offset: number | undefined,
): PagedResult<T> {
  const rawOffset = offset ?? 0;
  const safeOffset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const safeLimit =
    limit === undefined || !Number.isFinite(limit) ? undefined : Math.max(0, Math.floor(limit));
  const sliced =
    safeLimit !== undefined
      ? items.slice(safeOffset, safeOffset + safeLimit)
      : items.slice(safeOffset);

  return { total: items.length, returned: sliced.length, offset: safeOffset, items: [...sliced] };
}
