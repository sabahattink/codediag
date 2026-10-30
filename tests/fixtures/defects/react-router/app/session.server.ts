import { createCookieSessionStorage, redirect } from '@remix-run/node';

const storage = createCookieSessionStorage({
  cookie: { name: '__session', httpOnly: true, sameSite: 'lax', secrets: [process.env.SESSION_SECRET ?? ''] },
});

export async function getUserId(request: Request): Promise<string | undefined> {
  const session = await storage.getSession(request.headers.get('Cookie'));
  return session.get('userId');
}

export async function requireUserId(request: Request): Promise<string> {
  const userId = await getUserId(request);
  if (!userId) throw redirect('/login');
  return userId;
}

export async function createUserSession(userId: string) {
  const session = await storage.getSession();
  session.set('userId', userId);
  return redirect('/notes', { headers: { 'Set-Cookie': await storage.commitSession(session) } });
}
