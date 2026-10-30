import { json, redirect, type ActionFunctionArgs, type LoaderFunctionArgs } from '@remix-run/node';
import { Form, useLoaderData } from '@remix-run/react';
import { z } from 'zod';
import { db } from '../db.server';
import { requireUserId } from '../session.server';

const NoteSchema = z.object({ title: z.string().min(1), body: z.string() });

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireUserId(request);
  return json({ note: db.find(params.noteId ?? '') });
}

export async function action({ request, params }: ActionFunctionArgs) {
  const ownerId = await requireUserId(request);
  const parsed = NoteSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) return json(parsed.error.flatten(), { status: 400 });
  db.save({ id: params.noteId ?? '', ownerId, ...parsed.data });
  return redirect(`/notes/${params.noteId}`);
}

export default function EditNote() {
  const { note } = useLoaderData<typeof loader>();
  return (
    <Form method="post">
      <input name="title" defaultValue={note?.title} />
      <button type="submit">Save</button>
    </Form>
  );
}
