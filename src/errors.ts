export class BoardError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}
export function fail(status: number, message: string): never {
  throw new BoardError(status, message);
}
