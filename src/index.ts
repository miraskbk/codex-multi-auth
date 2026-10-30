#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import { readFileSync } from 'node:fs';
import { emailFromIdToken, parseAuthData, readCurrentAuth, saveProfile } from './auth.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

function color(text: string, code: string): string {
  return process.stdout.isTTY && process.env.NO_COLOR === undefined && process.env.TERM !== 'dumb'
    ? `\u001b[${code}m${text}\u001b[0m`
    : text;
}

function unfinished(command: string): void {
  throw new Error(`The "${command}" command is not implemented yet.`);
}

function profileName(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value)) {
    throw new InvalidArgumentError(
      'Use letters, numbers, underscores, or hyphens, starting with a letter or number.',
    );
  }
  return value;
}

const program = new Command();

program
  .name('codex-multi-auth')
  .description('Manage multiple Codex authentication profiles.')
  .version(version)
  .showHelpAfterError('(run with --help for usage)')
  .showSuggestionAfterError()
  .configureHelp({
    styleTitle: (text) => color(text, '1;36'),
    styleCommandText: (text) => color(text, '1'),
    styleSubcommandTerm: (text) => color(text, '36'),
    styleOptionTerm: (text) => color(text, '36'),
    styleArgumentTerm: (text) => color(text, '36'),
  })
  .addHelpText('beforeAll', () =>
    `${color('codex-multi-auth', '1;36')}  ${color(`v${version}`, '2')}\n` +
    `${color('Your Codex profiles, in one place.', '2')}\n`,
  )
  .addHelpText('after', `
Examples:
  codex-multi-auth add personal
  codex-multi-auth list
  codex-multi-auth use personal
  codex-multi-auth remove personal
`);

program
  .command('add')
  .description('Save an authentication profile under a name.')
  .argument('<name>', 'profile name', profileName)
  .action(async (name: string) => {
    const authData = await readCurrentAuth();

    const auth = parseAuthData(authData);
    const token = auth.tokens?.id_token;

    const email = typeof token === 'string'
      ? emailFromIdToken(token)
      : undefined;

    console.log(
      email
        ? `Saving account: ${email}`
        : 'Saving account: email unavailable',
    );

    await saveProfile(name, authData);
    console.log(`Saved profile: ${name}`);
  });

program
  .command('list')
  .description('List saved authentication profiles.')
  .action(() => unfinished('list'));

program
  .command('use')
  .description('Activate a saved authentication profile.')
  .argument('<name>', 'profile name', profileName)
  .action((_name: string) => unfinished('use'));

program
  .command('remove')
  .description('Remove a saved authentication profile.')
  .argument('<name>', 'profile name', profileName)
  .action((_name: string) => unfinished('remove'));


try {
  if (process.argv.length === 2) {
    program.outputHelp();
  } else {
    await program.parseAsync(process.argv);
  }
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`error: ${message}`);
  process.exitCode = 1;
}
