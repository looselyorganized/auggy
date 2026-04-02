export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(new TimeoutError(ms)), ms);
  });

  try {
    const result = await Promise.race([fn(), timeoutPromise]);
    return result;
  } finally {
    if (timerId !== undefined) clearTimeout(timerId);
  }
}
