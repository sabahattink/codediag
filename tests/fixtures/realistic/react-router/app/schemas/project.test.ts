import { describe, expect, it } from 'vitest';
import { ProjectIntentSchema, ProjectSchema } from './project';

describe('project schemas', () => {
  it('trims and requires a project name', () => {
    expect(ProjectSchema.safeParse({ name: '  ' }).success).toBe(false);
    expect(ProjectSchema.parse({ name: ' Launch ' }).name).toBe('Launch');
  });

  it('accepts only known intents', () => {
    expect(ProjectIntentSchema.safeParse({ intent: 'delete-project' }).success).toBe(true);
    expect(ProjectIntentSchema.safeParse({ intent: 'drop-database' }).success).toBe(false);
  });
});
