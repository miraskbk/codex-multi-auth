#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import { readFileSync } from 'node:fs';
import { emailFromIdToken, parseAuthData, readCurrentAuth, saveProfile, listProfiles, useProfile, removeProfile } from './auth.js';
import { checkProfile, runProfile } from './sessions.js';

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
  .enablePositionalOptions()
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
  codex-multi-auth run personal
  codex-multi-auth run work -- exec "review this repository"
  codex-multi-auth check personal --online
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
  .action(async () => {
    const profiles = await listProfiles();

    if (profiles.length === 0) {
      console.log('No saved profiles.');
      return;
    }

    const nameWidth = Math.max(
      ...profiles.map((profile) => profile.name.length),
    );

    for (const profile of profiles) {
      console.log(
        `${profile.name.padEnd(nameWidth)}  ${profile.email || 'email unavailable'}`,
      );
    }
  });




program
  .command('use')
  .description('Activate a saved authentication profile.')
  .argument('<name>', 'profile name', profileName)
  .action(async (name: string) => {
    const { email, backupPath } = await useProfile(name);

    console.log(`Activated profile: ${name}`);
    console.log(`Account: ${email || 'email unavailable'}`);

    if (backupPath) {
      console.log(`Previous auth backed up to: ${backupPath}`);
    }
  });





program
  .command('run')
  .description('Run Codex with an isolated profile home and save refreshed credentials on exit.')
  .argument('<name>', 'profile name', profileName)
  .argument('[args...]', 'arguments passed to Codex (optionally after --)')
  .allowUnknownOption()
  .passThroughOptions()
  .action(async (name: string, args: string[]) => {
    process.exitCode = await runProfile(name, args);
  });



program
  .command('check')
  .description('Inspect saved credentials; --online verifies with the server without a model request.')
  .argument('<name>', 'profile name', profileName)
  .option('--online', 'Verify API key access or refresh the ChatGPT session over the network.')
  .action(async (name: string, options: { online?: boolean }) => {
    const result = await checkProfile(name, options.online === true);
    console.log(`Profile: ${name}`);
    console.log(`Account: ${result.email || 'email unavailable'}`);
    console.log(`Method: ${result.method}`);
    console.log(result.status);
    if (result.expired) process.exitCode = 1;
  });





program
  .command('remove')
  .description('Remove a saved authentication profile.')
  .argument('<name>', 'profile name', profileName)
  .option('--force', 'Also delete the isolated home and session history.')
  .action(async (name: string, options: { force?: boolean }) => {
    await removeProfile(name, options.force === true);
    console.log(`Removed profile: ${name}`);
  });


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
