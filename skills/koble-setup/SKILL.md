---
name: koble-setup
description: Install, connect, update, repair or remove koble — the program that connects Claude to EBMS (Koble Systems ERP). Downloads it, saves the EBMS serial number, test company and username, has the user enter their password privately, connects Claude Desktop and Claude Code, and runs its health check. Use whenever someone wants to set up, install, connect or update Koble or EBMS for Claude, when the ebms_* tools are missing or failing to sign in, or when they ask whether their EBMS connection is working — "set up Koble", "connect Claude to EBMS", "koble isn't working", "update koble", "uninstall Koble".
---

# Set up koble

`koble` is a single program. Once set up, every Claude app on this computer can use EBMS through
it. This skill runs the steps for the user from Claude Code's terminal.

**The EBMS password never passes through this chat.** Don't ask for it, and don't type it anywhere.
The user types it into `koble login` in their own terminal, where it is hidden and goes straight to
the system's credential store. If they paste it into the chat anyway, don't use it, and suggest
they change it in EBMS, since it has now been shared.

## 1. Is it installed?

Run `koble version`. If that prints a version, skip to step 3.

## 2. Install it

This downloads a program from github.com/koblesystems/koble-mcp and verifies it against the
release's published checksums. Say that, and ask before running it.

- **macOS or Linux:**
  ```bash
  curl -fsSL https://raw.githubusercontent.com/koblesystems/koble-mcp/master/scripts/install.sh | KOBLE_SKIP_SETUP=1 bash
  ```
  It installs to `~/.local/bin/koble`. If that folder is not on PATH, the installer says so. Use
  the full path for the rest of this skill, and tell the user which line to add to their shell
  profile.
- **Windows (PowerShell):**
  ```powershell
  $env:KOBLE_SKIP_SETUP = '1'; irm https://raw.githubusercontent.com/koblesystems/koble-mcp/master/scripts/install.ps1 | iex
  ```
  It installs to `%LOCALAPPDATA%\Programs\koble\koble.exe` and adds that folder to the user's
  PATH. Use the full path until a new terminal is opened.

`KOBLE_SKIP_SETUP=1` stops the installer starting the interactive setup, which cannot run inside
Claude's terminal. Step 3 does the same thing with flags instead.

If Windows blocks `koble.exe` (Smart App Control or SmartScreen), the program is not yet
code-signed. Tell the user, and point them to the README's Windows notes. Do not try to switch
off Windows security settings.

## 3. Save the settings

Ask the user for three things, in one message:

1. **The EBMS serial number**, the number at the start of their `…koblesystems.dev` address.
   Don't repeat it back in full.
2. **A test company**, if they have one, for trying things out. While set, every write can reach
   only that company. Recommend it for a first setup. `none` allows writes to every company.
3. **Their EBMS username.**

Then run:

```bash
koble setup --serial <serial> --username <username> --sandbox <company or none> --skip-password --yes
```

It lists the companies the serial reaches, so a wrong serial shows up at once. It then connects
every AI app it finds (Claude Desktop, Claude Code, Codex, Cursor, VS Code, Gemini CLI, Windsurf),
backing up each config first, and copies the skills into Claude Code's skills folder. To choose
the apps, add `--apps claude-desktop,claude-code,codex` (any of `claude-desktop`, `claude-code`,
`codex`, `cursor`, `vscode`, `gemini`, `windsurf`). Read its output to the user in plain words.

## 4. The password — the user types it

Tell the user, in these words or close to them:

> Open a terminal window (on Windows, PowerShell) and run `koble login`. Type your EBMS password
> when it asks; nothing will show as you type. It checks the password with EBMS before saving it.

Wait until they say it's done. `koble login` prints "Signed in to …" when it worked.

## 5. Check everything

```bash
koble doctor --json
```

Each check is `ok`, `warn`, `fail` or `info`, with a `fix` when something needs doing. Report
the failures and warnings in plain words, and do what each `fix` says. Where the fix is
`koble login`, that is the user's step, not yours. Then tell them:

- **Claude Desktop:** quit and reopen it. The EBMS tools appear under the connectors, and the
  named workflows in the ＋ menu. For the skills as `/` commands in its chat, the user runs
  `koble plugin` and uploads the saved file in Settings → Customize → Plugins.
- **Claude Code:** start a new session, or run `/mcp`. Type `/ebms` to see the skills, e.g.
  `/ebms-mrp`.
- **Codex, Cursor, VS Code, Gemini CLI, Windsurf:** restart the app or start a new session.

## Updating

`koble update`, then restart the Claude apps. `koble doctor` also says when an update is
available.

## When something is wrong

Run `koble doctor --json` first, every time. It checks, in order: the saved settings, whether
EBMS is reachable, the stored password, a real sign-in, testing mode, Claude Desktop and Claude
Code. The first failure is usually the cause of the rest. Common ones:

| Doctor says | Do |
|---|---|
| Settings: none saved | step 3 |
| EBMS: company list not reachable | Check the serial number and the internet connection. |
| Password: not stored, or Sign-in failing | The user runs `koble login`. |
| Any app: not connected, or runs something else | `koble connect` |
| Claude Desktop: connected, but has not started it | The user quits Claude Desktop completely (tray icon or menu → Quit) and reopens it. |
| Claude Desktop: config is not valid JSON | Don't edit it yourself. Show the user the path and ask them to fix or move the file, then `koble connect`. |

## Removing koble

Run `koble uninstall` without `--yes` first and read its list to the user: it says exactly what it
will remove (each app's koble-mcp entry, the skills it installed, the stored password, its
settings, the program) and what it keeps (MRP worksheets, config backups). Ask them to quit Claude
Desktop, then, with their go-ahead, run `koble uninstall --yes`. This skill is removed with it.
