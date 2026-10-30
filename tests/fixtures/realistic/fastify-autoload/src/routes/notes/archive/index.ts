import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { ArchiveNote, NoteParams } from '../../../schemas/note.js';
import { archiveNote } from '../../../services/notes.js';

const archive: FastifyPluginAsyncTypebox = async (fastify) => {
  fastify.put(
    '/:id',
    { schema: { params: NoteParams, body: ArchiveNote } },
    async (request, reply) => {
      const note = archiveNote(request.user.sub, request.params.id, request.body.archived);
      return note ? note : reply.code(404).send();
    },
  );
};

export default archive;
