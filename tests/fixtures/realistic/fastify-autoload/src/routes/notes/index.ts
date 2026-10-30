import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { CreateNote, Note, NoteParams } from '../../schemas/note.js';
import { addNote, listNotes, removeNote } from '../../services/notes.js';

const notes: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.get('/', { schema: { response: { 200: Type.Array(Note) } } }, async (request) =>
    listNotes(request.user.sub),
  );

  fastify.post(
    '/',
    { schema: { body: CreateNote, response: { 201: Note } } },
    async (request, reply) => reply.code(201).send(addNote(request.user.sub, request.body)),
  );

  fastify.delete('/:id', { schema: { params: NoteParams } }, async (request, reply) => {
    const removed = removeNote(request.user.sub, request.params.id);
    return reply.code(removed ? 204 : 404).send();
  });
};

export default notes;
