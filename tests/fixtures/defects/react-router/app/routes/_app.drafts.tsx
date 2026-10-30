import type { ClientActionFunctionArgs } from '@remix-run/react';
import { Form } from '@remix-run/react';

// Runs in the browser only, so it is not a server endpoint.
export async function clientAction({ request }: ClientActionFunctionArgs) {
  const formData = await request.formData();
  localStorage.setItem('draft', String(formData.get('body')));
  return null;
}

export default function Drafts() {
  return (
    <Form method="post">
      <textarea name="body" />
    </Form>
  );
}
