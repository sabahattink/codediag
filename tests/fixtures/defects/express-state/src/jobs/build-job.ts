import { exec } from 'node:child_process';

// The command is fixed in code, so the finding stays a warning.
export class BuildJob {
  private readonly command = 'npm run build';

  run() {
    exec(this.command);
  }
}
