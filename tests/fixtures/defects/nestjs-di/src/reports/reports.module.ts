import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsRepository } from './reports.repository';
import { SqlReportsRepository } from './sql-reports.repository';

@Module({
  controllers: [ReportsController],
  providers: [{ provide: ReportsRepository, useClass: SqlReportsRepository }],
})
export class ReportsModule {}
