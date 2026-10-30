import { exec } from 'node:child_process';

export class BackupJob {
  constructor(private readonly target: string) {}

  start() {
    exec(`tar -czf /var/backups/latest.tgz ${this.target}`);
  }
}
