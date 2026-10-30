import { Type } from '@sinclair/typebox';

export const Note = Type.Object({
  id: Type.String({ format: 'uuid' }),
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String({ maxLength: 10_000 }),
  archived: Type.Boolean(),
});

export const CreateNote = Type.Object({
  title: Type.String({ minLength: 1, maxLength: 200 }),
  body: Type.String({ maxLength: 10_000 }),
});

export const ArchiveNote = Type.Object({ archived: Type.Boolean() });

export const NoteParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
