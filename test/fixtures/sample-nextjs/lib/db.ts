type Row = Record<string, unknown>;

function table() {
  return {
    findMany: async (): Promise<Row[]> => [],
    create: async ({ data }: { data: Row }): Promise<Row> => data,
    update: async ({ data }: { where: Row; data: Row }): Promise<Row> => data,
    delete: async (_args: { where: Row }): Promise<void> => undefined,
  };
}

export const db = { users: table(), posts: table() };
