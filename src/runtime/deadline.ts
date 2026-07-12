/** Resolve an operation or a typed fallback when its local deadline elapses. */
export async function raceWithTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutValue: T,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(timeoutValue), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
