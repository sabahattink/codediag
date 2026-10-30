import { json, type ActionFunctionArgs } from '@remix-run/node';
import { Form } from '@remix-run/react';
import { z } from 'zod';
import { createUserSession } from '../session.server';

const LoginSchema = z.object({ email: z.string().email() });

// Signing in is public by design; it is not reported.
export async function action({ request }: ActionFunctionArgs) {
  const parsed = LoginSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return json({ error: 'Invalid email' }, { status: 400 });
  return createUserSession(parsed.data.email);
}

export default function Login() {
  return (
    <Form method="post">
      <input name="email" type="email" />
    </Form>
  );
}
