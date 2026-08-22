/**
 * Abort-race primitives for bounding async work that JS promises cannot cancel.
 *
 * A hung `await` (e.g. a stuck network call deep inside session creation) pins
 * every promise chained onto it forever — including `AbortSignal`-ignorant
 * call paths. These helpers race a promise against a signal so callers stop
 * WAITING even though the underlying promise keeps running (its suspended
 * frame leaks until it settles, if ever — that is unavoidable; the important
 * part is that the caller, and everything above it, gets unstuck).
 */

export interface RaceAbortOptions<T> {
  /** Called with the fulfilled value if the promise settles AFTER the race was
   *  already lost to abort — the caller's chance to clean up resources it no
   *  longer owns (e.g. destroy a session that finished creating after the
   *  caller gave up on it). Rejections after abort are swallowed: the caller
   *  already reported the abort and cannot use the error. */
  onLateSettle?: (value: T) => void;
}

/** Race `promise` against `signal`.
 *
 * - Settles with the promise's own value/rejection if the promise wins.
 * - Rejects with `signal.reason` (or a plain `Error("aborted")` when the
 *   reason is not an `Error`) the moment the signal fires — including when the
 *   signal was already aborted before this call, in which case `promise` is
 *   never awaited at all. */
export function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  opts?: RaceAbortOptions<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      const reason: unknown = signal.reason;
      const abortError = reason instanceof Error ? reason : new Error("aborted");
      if (!(reason instanceof Error) && reason !== undefined) abortError.cause = reason;
      reject(abortError);
      promise.then(
        (value) => opts?.onLateSettle?.(value),
        () => {},
      );
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** A self-contained creation bound: an AbortSignal that fires `ms` after start
 *  (unref'd timer — never keeps the process alive). Pair with `raceAbort`, or
 *  pass directly to APIs that accept a signal. Call `dispose()` as soon as the
 *  bounded phase completes to stop the timer. */
export function creationTimeoutSignal(
  ms: number,
  message: string,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), ms);
  timer.unref?.();
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}
