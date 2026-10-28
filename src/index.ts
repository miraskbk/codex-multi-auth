#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

const program = new Command();

program
  .name('codex-multi-auth')
  .description('Manage multiple Codex authentication profiles.')
  .version(version)
  .showHelpAfterError();

function unfinished(command: string): void {
  program.error(`The "${command}" command is not implemented yet.`);
}

program
  .command('add')
  .description('Save an authentication profile under a name.')
  .argument('<name>', 'profile name')
  .action((_name: string) => unfinished('add'));

program
  .command('list')
  .description('List saved authentication profiles.')
  .action(() => unfinished('list'));

program
  .command('use')
  .description('Activate a saved authentication profile.')
  .argument('<name>', 'profile name')
  .action((_name: string) => unfinished('use'));

program
  .command('remove')
  .description('Remove a saved authentication profile.')
  .argument('<name>', 'profile name')
  .action((_name: string) => unfinished('remove'));

if (process.argv.length === 2) {
  program.help();
}

await program.parseAsync(process.argv);
