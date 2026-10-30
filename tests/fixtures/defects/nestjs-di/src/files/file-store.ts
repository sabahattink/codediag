export interface FileStore {
  read(name: string): Promise<Buffer>;
}

export const FILE_STORE = Symbol('FILE_STORE');
