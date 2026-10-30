class ReportService {
  constructor(db) {
    this.db = db;
  }

  find(id) {
    return this.db.query('SELECT * FROM reports WHERE id = ' + id);
  }
}

module.exports = ReportService;
