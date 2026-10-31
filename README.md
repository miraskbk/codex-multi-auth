# codex-multi-auth

Manage multiple accounts for the Codex CLI. Sign in once per profile, then run personal and work accounts side by side in separate terminals.

Each profile gets its own credentials, configuration, and session history. The CLI handles profile locks, preserves refreshed credentials, and displays account emails when available.

## Requirements

- Node.js 22 or later and npm.
- Codex CLI installed and available as `codex` on your `PATH`.
- A shell with `chmod` available for the build script, such as on macOS or Linux.

```sh
node --version
npm --version
codex --version
```

## Install from source

```sh
git clone https://github.com/miraskbk/codex-multi-auth.git
cd codex-multi-auth
npm install
npm run build
npm link
```

The linked command works outside the project directory:

```sh
codex-multi-auth --help
```

Keep the checkout in place: the command links to its built files. If you use a Node version manager, you may need to run `npm link` again after changing Node versions.

## Quick start

Create your profiles:

```sh
codex-multi-auth login personal
codex-multi-auth login work
codex-multi-auth list
```

Run your personal account in one terminal:

```sh
codex-multi-auth run personal
```

Run your work account in another:

```sh
codex-multi-auth run work
```

Exit a Codex session with `/exit`. Credentials refreshed by Codex remain in that profile's home and are copied back to its saved profile when the session exits.

Profiles isolate Codex state, not your working directory. Two sessions opened in the same repository still share its files.

## Commands

| Command | Purpose |
| --- | --- |
| `login <name>` | Sign in to a new or existing profile. |
| `add <name>` | Save credentials from the current default Codex auth file. |
| `list` | Show profile names, available emails, and local statuses. |
| `run <name> [args...]` | Launch Codex using the profile's isolated home. |
| `check <name>` | Inspect credential structure and locally readable expiry. |
| `check <name> --online` | Verify API-key access or refresh a managed ChatGPT session. |
| `use <name>` | Copy a profile into the default Codex auth file. |
| `remove <name>` | Remove a saved profile that has no isolated home. |
| `remove <name> --force` | Also delete the profile's isolated home and session history. |

Profile names use ASCII letters, numbers, underscores, or hyphens and must start with a letter or number. Examples: `personal`, `work-account`, and `client_1`.

### Sign in

```sh
codex-multi-auth login work
```

Codex handles browser sign-in. The default Codex account stays unchanged. Repeat the command to sign in again to an existing profile; failed or cancelled login attempts preserve its previous credentials.

For device-code login:

```sh
codex-multi-auth login work --device-auth
```

Device-code login still requires browser approval and must be enabled for your account or workspace. See [Codex authentication](https://learn.chatgpt.com/docs/auth).

To use an API key already stored in an environment variable:

```sh
printenv OPENAI_API_KEY | codex-multi-auth login api --with-api-key
```

`--device-auth` and `--with-api-key` cannot be combined.

### Import an existing login

```sh
codex-multi-auth add personal
```

`add` reads `$CODEX_HOME/auth.json`, defaulting to `~/.codex/auth.json`. It rejects existing profile names and does not read credentials from the OS keyring. Use `login` to sign in directly when no file-based login is available.

### View profiles

```sh
codex-multi-auth list
```

Example output:

```text
personal  person@example.com  saved
work      work@example.com    in use
old       email unavailable   signed out
```

| Status | Meaning |
| --- | --- |
| `saved` | Credentials are present and pass local structure validation. |
| `in use` | A recorded owner is alive, or lock ownership cannot be safely determined. |
| `signed out` | An isolated home exists without an auth file. |
| `invalid` | The auth file contains invalid JSON or lacks supported credentials. |
| `unreadable` | Profile files could not be read. |

A damaged profile does not stop other profiles from appearing. `saved` does not mean the credentials have been verified with the server. Displayed emails are decoded token claims, not proof of a valid session.

### Pass arguments to Codex

```sh
codex-multi-auth run work -- exec "review this repository"
codex-multi-auth run personal -- resume
```

`run` sets an isolated `CODEX_HOME`, forces file-based credential storage, and removes inherited credential variables that could select a different account. Remote runs and credential-store overrides are rejected.

Profile homes start with their own configuration; your default Codex config is not copied. Edit `~/.codex-multi-auth/homes/<name>/config.toml` for profile-specific settings.

### Check credentials

```sh
codex-multi-auth check personal
codex-multi-auth check personal --online
```

The default check is local. It can report an expired access token, but cannot prove a token is valid or unrevoked. An expired access token may still be refreshable.

With `--online`, the CLI:

- Asks Codex to refresh a managed ChatGPT session and saves the resulting credentials.
- Checks an API key against OpenAI's models endpoint. Restricted permissions can prevent verification even when the key is valid.

Online checks make network requests but do not send a model prompt. ChatGPT checks require a refresh token. See the [Codex account API](https://learn.chatgpt.com/docs/app-server) and [models endpoint](https://developers.openai.com/api/reference/resources/models/methods/list).

### Switch the default Codex account

```sh
codex-multi-auth use personal
```

`use` backs up the current auth file, replaces it with the selected profile, and records which profile was selected. On a later switch, it preserves matching refreshed credentials and refuses to overwrite conflicting changes from both the default and isolated homes.

This command requires default Codex file storage. Set this at the top level of your default Codex `config.toml`:

```toml
cli_auth_credentials_store = "file"
```

Close Codex clients using the default home before switching, then reopen them. Locks only track sessions launched through this program. Prefer `run` when you want simultaneous accounts.

### Remove a profile

```sh
codex-multi-auth remove old
```

If the profile has an isolated home, deletion requires `--force`:

```sh
codex-multi-auth remove old --force
```

This permanently deletes that profile's isolated credentials, configuration, and session history. It does not remove the default Codex auth file or its backups, revoke tokens, or log out the default account.

A locked profile cannot be removed, even with `--force`. Removing another unlocked profile does not affect a running session.

## Storage and locks

```text
~/.codex-multi-auth/
├── profiles/
│   ├── personal.json
│   └── work.json
├── homes/
│   ├── personal/
│   └── work/
└── locks/
```

Profile storage stays under `~/.codex-multi-auth` even when you set a custom default `CODEX_HOME`. Once a profile has an isolated home, its auth file takes precedence over the saved snapshot.

Credentials are stored as plaintext with file mode `0600`; newly created private directories use `0700`. Treat profile files and auth backups like passwords. Do not commit or share them.

Locks record the CLI and its Codex child processes. A stale lock is recovered automatically when all recorded owners are gone. A surviving child keeps the profile locked even if the parent CLI was force-quit.

If ownership is missing, corrupt, or cannot be verified, the command reports the exact lock path. Close all relevant Codex sessions before manually removing that lock directory. Never remove a lock while its session is still running.

## Billing

This profile manager adds no OpenAI service fee. Local profile management does not send model prompts.

- **ChatGPT sign-in:** Codex usage follows the selected account's plan allowance and applicable credits.
- **API-key sign-in:** Codex model usage is charged through the associated OpenAI API account at API rates.

Running multiple profiles does not combine their allowances. Each session uses the account selected for that profile. See [OpenAI authentication](https://learn.chatgpt.com/docs/auth) and [Codex pricing](https://learn.chatgpt.com/docs/pricing).

## Development

```sh
npm run dev -- --help
npm run watch
npm run check
```

The linked command runs `dist/`. After editing TypeScript, rebuild it:

```sh
npm run build
```

`npm run watch` runs the source through `tsx`; it does not rebuild the linked command.

To remove the global command link while keeping the checkout and profiles:

```sh
npm unlink -g codex-multi-auth
```

