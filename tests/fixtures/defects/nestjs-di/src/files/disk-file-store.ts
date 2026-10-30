import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import type { FileStore } from './file-store';

@Injectable()
export class DiskFileStore implements FileStore {
  read(name: string) {
    return readFile(join('/srv/files', name));
  }
}
