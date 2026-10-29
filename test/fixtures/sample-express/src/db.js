let rows = [];

module.exports = {
  all: async () => rows,
  insert: async (row) => {
    const created = { id: String(rows.length + 1), ...row };
    rows = [...rows, created];
    return created;
  },
  update: async (id, patch) => {
    rows = rows.map((r) => (r.id === id ? { ...r, ...patch } : r));
    return rows.find((r) => r.id === id);
  },
  remove: async (id) => {
    rows = rows.filter((r) => r.id !== id);
  },
};
