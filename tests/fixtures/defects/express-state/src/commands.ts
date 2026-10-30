import { exec } from 'node:child_process';
import { Router } from 'express';

let lastCommand = 'uptime';

export const commands = Router();

commands.post('/commands', (req, res) => {
  lastCommand = req.body.command;
  res.sendStatus(204);
});

export function replayLastCommand() {
  exec(lastCommand);
}
