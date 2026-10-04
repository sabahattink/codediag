export interface Session {
  userId: string;
}

export async function auth(request: Request): Promise<Session | null> {
  const token = request.headers.get('authorization');
  return token ? { userId: token.slice(7) } : null;
}
