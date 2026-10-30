import { data } from 'react-router';
import { addTask, getProject } from '~/models/project.server';
import { TaskSchema } from '~/schemas/project';
import { requireUserId } from '~/session.server';
import type { Route } from './+types/tasks';

/** JSON API outside the dashboard layout, so it checks the session itself. */
export async function loader({ request, params }: Route.LoaderArgs) {
  const userId = await requireUserId(request);
  const project = await getProject(params.projectId, userId);
  if (!project) throw data({ error: 'Not found' }, { status: 404 });
  return Response.json(project.tasks);
}

export async function action({ request, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    throw data({ error: 'Method not allowed' }, { status: 405 });
  }
  const userId = await requireUserId(request);
  const parsed = TaskSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ errors: parsed.error.flatten().fieldErrors }, { status: 400 });
  }
  const task = await addTask(params.projectId, userId, parsed.data);
  if (!task) throw data({ error: 'Not found' }, { status: 404 });
  return Response.json(task, { status: 201 });
}
