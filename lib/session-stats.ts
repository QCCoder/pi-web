export interface CacheRateTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * Average cache hit rate across the session (upstream #471).
 *
 * Cache reads / (input + cache writes + cache reads) — the denominator covers
 * all input-class tokens. Returns null when there is nothing cache-related to
 * report (no reads/writes at all, or a zero denominator).
 */
export function computeCacheHitRatePercent(tokens: CacheRateTokens): number | null {
  const cacheTraffic = tokens.cacheRead + tokens.cacheWrite;
  const denominator = cacheTraffic + tokens.input;
  if (cacheTraffic <= 0 || denominator <= 0) return null;
  return (tokens.cacheRead / denominator) * 100;
}
