import { Controller, Get, Inject, Query } from '@nestjs/common';
import { FILE_STORE, type FileStore } from './file-store';

@Controller('files')
export class FilesController {
  constructor(@Inject(FILE_STORE) private readonly store: FileStore) {}

  @Get()
  read(@Query('name') name: string) {
    return this.store.read(name);
  }
}
