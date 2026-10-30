import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ReportsRepository } from './reports.repository';

@Injectable()
export class SqlReportsRepository extends ReportsRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  find(id: string) {
    return this.dataSource.query(`SELECT * FROM reports WHERE id = ${id}`);
  }
}
