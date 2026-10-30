import { data, Form, redirect, useSearchParams } from 'react-router';
import { verifyLogin } from '~/models/user.server';
import { LoginSchema } from '~/schemas/project';
import { createUserSession, getUserId } from '~/session.server';
import { safeRedirect } from '~/utils';
import type { Route } from './+types/login';

export async function loader({ request }: Route.LoaderArgs) {
  if (await getUserId(request)) throw redirect('/projects');
  return null;
}

export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData();
  const parsed = LoginSchema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) {
    return data({ error: 'Enter a valid email and password' }, { status: 400 });
  }
  const user = await verifyLogin(parsed.data.email, parsed.data.password);
  if (!user) {
    return data({ error: 'Invalid email or password' }, { status: 400 });
  }
  return createUserSession({
    request,
    userId: user.id,
    redirectTo: safeRedirect(parsed.data.redirectTo),
  });
}

export default function Login({ actionData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams();
  return (
    <Form method="post">
      <input type="hidden" name="redirectTo" value={searchParams.get('redirectTo') ?? ''} />
      <label>
        Email <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Password <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {actionData?.error ? <p role="alert">{actionData.error}</p> : null}
      <button type="submit">Log in</button>
    </Form>
  );
}
