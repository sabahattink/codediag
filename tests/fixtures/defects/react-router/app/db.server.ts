interface Note {
  id: string;
  title: string;
  body: string;
  ownerId: string;
}

const notes = new Map<string, Note>();

export const db = {
  list: () => [...notes.values()],
  find: (id: string) => notes.get(id) ?? null,
  save: (note: Note) => notes.set(note.id, note),
  remove: (id: string) => notes.delete(id),
};
