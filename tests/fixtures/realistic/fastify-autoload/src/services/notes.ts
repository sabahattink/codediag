import { randomUUID } from 'node:crypto';

export interface StoredNote {
  id: string;
  title: string;
  body: string;
  archived: boolean;
}

const notesByOwner = new Map<string, Map<string, StoredNote>>();

function notesOf(owner: string): Map<string, StoredNote> {
  let notes = notesByOwner.get(owner);
  if (!notes) {
    notes = new Map();
    notesByOwner.set(owner, notes);
  }
  return notes;
}

export function listNotes(owner: string): StoredNote[] {
  return [...notesOf(owner).values()];
}

export function addNote(owner: string, input: { title: string; body: string }): StoredNote {
  const note = { id: randomUUID(), ...input, archived: false };
  notesOf(owner).set(note.id, note);
  return note;
}

export function archiveNote(owner: string, id: string, archived: boolean): StoredNote | null {
  const note = notesOf(owner).get(id);
  if (!note) return null;
  const updated = { ...note, archived };
  notesOf(owner).set(id, updated);
  return updated;
}

export function removeNote(owner: string, id: string): boolean {
  return notesOf(owner).delete(id);
}
