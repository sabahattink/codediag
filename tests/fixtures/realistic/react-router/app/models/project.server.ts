import { db } from '~/db.server';
import type { NewProject, NewTask } from '~/schemas/project';

export function listProjects(ownerId: string) {
  return db.project.findMany({ where: { ownerId }, orderBy: { updatedAt: 'desc' } });
}

export function getProject(id: string, ownerId: string) {
  return db.project.findFirst({ where: { id, ownerId }, include: { tasks: true } });
}

export function createProject(ownerId: string, input: NewProject) {
  return db.project.create({ data: { ...input, ownerId } });
}

export async function addTask(projectId: string, ownerId: string, input: NewTask) {
  const project = await getProject(projectId, ownerId);
  if (!project) return null;
  return db.task.create({ data: { ...input, projectId: project.id } });
}

export function completeTask(taskId: string, ownerId: string) {
  return db.task.updateMany({
    where: { id: taskId, project: { ownerId } },
    data: { done: true },
  });
}

export function deleteProject(id: string, ownerId: string) {
  return db.project.deleteMany({ where: { id, ownerId } });
}
