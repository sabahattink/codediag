import { redirect, type ActionFunctionArgs } from '@remix-run/node';
import { Form } from '@remix-run/react';
import { db } from '../db.server';
import { requireUserId } from '../session.server';

export async function action({ request }: ActionFunctionArgs) {
  const ownerId = await requireUserId(request);
  const formData = await request.formData();
  const id = crypto.randomUUID();
  db.save({ id, ownerId, title: formData.get('title') as string, body: formData.get('body') as string });
  return redirect(`/notes/${id}`);
}

export default function NewNote() {
  return (
    <Form method="post">
      <input name="title" />
      <textarea name="body" />
      <button type="submit">Save</button>
    </Form>
  );
}
