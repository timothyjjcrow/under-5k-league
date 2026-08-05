export function postgresCliEnv(
  raw: string,
  options?: { database?: string; env?: NodeJS.ProcessEnv },
): NodeJS.ProcessEnv;
