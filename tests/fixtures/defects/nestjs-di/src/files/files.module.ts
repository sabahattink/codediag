import { Module } from '@nestjs/common';
import { DiskFileStore } from './disk-file-store';
import { FILE_STORE } from './file-store';
import { FilesController } from './files.controller';

@Module({
  controllers: [FilesController],
  providers: [{ provide: FILE_STORE, useClass: DiskFileStore }],
})
export class FilesModule {}
