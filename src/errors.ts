export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function explain<T>(
  promise: Promise<T>,
  prefix: string,
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw new Error(`${prefix}: ${messageOf(error)}`, { cause: error });
  }
}
