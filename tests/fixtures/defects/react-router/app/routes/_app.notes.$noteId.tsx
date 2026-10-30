import { json, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import { Form, useLoaderData } from '@remix-run/react';
import { db } from '../db.server';
import { requireUserId } from '../session.server';

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const note = db.find(params.noteId ?? '');
  if (!note || note.ownerId !== userId) throw new Response('Not found', { status: 404 });
  return json({ note });
}

export async function action({ params }: ActionFunctionArgs) {
  db.remove(params.noteId ?? '');
  return redirect('/notes');
}

export default function Note() {
  const { note } = useLoaderData<typeof loader>();
  return (
    <Form method="post">
      <h2>{note.title}</h2>
      <button type="submit">Delete</button>
    </Form>
  );
}
