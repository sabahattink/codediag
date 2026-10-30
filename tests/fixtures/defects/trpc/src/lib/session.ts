export interface User {
  id: string;
}

const sessions = new Map<string, User>();

export async function verifySession(header: string | undefined): Promise<User | null> {
  const token = header?.replace(/^Bearer /, '');
  return token ? (sessions.get(token) ?? null) : null;
}
