import fs from 'node:fs';
import type { Request } from 'express';

export class ExportJob {
  private file = 'exports/latest.csv';

  configure(req: Request) {
    this.file = String(req.query.file);
  }

  read() {
    return fs.readFileSync(this.file, 'utf8');
  }
}
