import { getFormProps, getInputProps, useForm } from '@conform-to/react';
import { parseWithZod } from '@conform-to/zod';
import { Form, redirect } from 'react-router';
import { userContext } from '~/context';
import { createProject } from '~/models/project.server';
import { ProjectSchema } from '~/schemas/project';
import type { Route } from './+types/new-project';

export async function action({ request, context }: Route.ActionArgs) {
  const user = context.get(userContext);
  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema: ProjectSchema });
  if (submission.status !== 'success') {
    return submission.reply();
  }
  const project = await createProject(user.id, submission.value);
  return redirect(`/projects/${project.id}`);
}

export default function NewProject({ actionData }: Route.ComponentProps) {
  const [form, fields] = useForm({
    lastResult: actionData,
    onValidate: ({ formData }) => parseWithZod(formData, { schema: ProjectSchema }),
  });
  return (
    <Form method="post" {...getFormProps(form)}>
      <label>
        Name <input {...getInputProps(fields.name, { type: 'text' })} />
      </label>
      <p>{fields.name.errors}</p>
      <label>
        Description <textarea name={fields.description.name} />
      </label>
      <button type="submit">Create project</button>
    </Form>
  );
}
