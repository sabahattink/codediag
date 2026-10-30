import { createCookieSessionStorage, redirect } from 'react-router';
import type { SessionUser } from './context';
import { db } from './db.server';
import { env } from './env.server';

const USER_SESSION_KEY = 'userId';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: '__session',
    httpOnly: true,
    path: '/',
    sameSite: 'lax',
    secrets: [env.SESSION_SECRET],
    secure: env.NODE_ENV === 'production',
  },
});

async function getSession(request: Request) {
  return sessionStorage.getSession(request.headers.get('Cookie'));
}

export async function getUserId(request: Request): Promise<string | undefined> {
  const session = await getSession(request);
  return session.get(USER_SESSION_KEY);
}

export async function getUser(request: Request): Promise<SessionUser | null> {
  const userId = await getUserId(request);
  if (!userId) return null;
  return db.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true },
  });
}

export function loginRedirect(request: Request) {
  const redirectTo = new URL(request.url).pathname;
  return redirect(`/login?${new URLSearchParams({ redirectTo })}`);
}

export async function requireUserId(request: Request): Promise<string> {
  const userId = await getUserId(request);
  if (!userId) throw loginRedirect(request);
  return userId;
}

export async function createUserSession({
  request,
  userId,
  redirectTo,
}: {
  request: Request;
  userId: string;
  redirectTo: string;
}) {
  const session = await getSession(request);
  session.set(USER_SESSION_KEY, userId);
  return redirect(redirectTo, {
    headers: {
      'Set-Cookie': await sessionStorage.commitSession(session, {
        maxAge: SESSION_MAX_AGE_SECONDS,
      }),
    },
  });
}

export async function logout(request: Request) {
  const session = await getSession(request);
  return redirect('/', {
    headers: { 'Set-Cookie': await sessionStorage.destroySession(session) },
  });
}
