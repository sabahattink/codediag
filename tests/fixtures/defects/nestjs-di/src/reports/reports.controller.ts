import { Controller, Get, Query } from '@nestjs/common';
import { ReportsRepository } from './reports.repository';

class ReportQuery {
  id!: string;
}

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsRepository) {}

  @Get()
  show(@Query() query: ReportQuery) {
    return this.reports.find(query.id);
  }
}
