import { execSync } from 'node:child_process';

export function convert(name: string): string {
  return execSync(`convert ${name}.png ${name}.webp`).toString();
}
