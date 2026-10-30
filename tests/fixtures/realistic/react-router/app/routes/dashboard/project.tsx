import { parseWithZod } from '@conform-to/zod';
import { data, Form, redirect } from 'react-router';
import { userContext } from '~/context';
import { addTask, completeTask, deleteProject, getProject } from '~/models/project.server';
import { ProjectIntentSchema } from '~/schemas/project';
import type { Route } from './+types/project';

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = context.get(userContext);
  const project = await getProject(params.projectId, user.id);
  if (!project) throw data('Project not found', { status: 404 });
  return { project };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  const submission = parseWithZod(await request.formData(), { schema: ProjectIntentSchema });
  if (submission.status !== 'success') {
    return submission.reply();
  }
  switch (submission.value.intent) {
    case 'add-task':
      await addTask(params.projectId, user.id, { title: submission.value.title });
      return submission.reply({ resetForm: true });
    case 'complete-task':
      await completeTask(submission.value.taskId, user.id);
      return null;
    case 'delete-project':
      await deleteProject(params.projectId, user.id);
      return redirect('/projects');
  }
}

export default function Project({ loaderData }: Route.ComponentProps) {
  const { project } = loaderData;
  return (
    <main>
      <h1>{project.name}</h1>
      <ul>
        {project.tasks.map((task) => (
          <li key={task.id}>
            {task.title}
            {task.done ? null : (
              <Form method="post">
                <input type="hidden" name="taskId" value={task.id} />
                <button type="submit" name="intent" value="complete-task">
                  Done
                </button>
              </Form>
            )}
          </li>
        ))}
      </ul>
      <Form method="post">
        <input name="title" required />
        <button type="submit" name="intent" value="add-task">
          Add task
        </button>
      </Form>
      <Form method="post">
        <button type="submit" name="intent" value="delete-project">
          Delete project
        </button>
      </Form>
    </main>
  );
}
