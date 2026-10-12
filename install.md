# Installing koble — for an AI agent

Follow these steps in order for the person you are helping. Run each command and read its output
before going on.

**DONE WHEN:** `koble doctor --json` reports no `"fail"` checks.

**Never ask for, type, or handle the EBMS password.** The person types it into `koble login`
themselves (step 4). If they paste it into the chat, do not use it; suggest they change it.

## 1. Install the program

Ask before running this: it downloads a program from github.com/koblesystems/koble-mcp and checks
it against the release's checksums.

- macOS / Linux:
  ```bash
  curl -fsSL https://raw.githubusercontent.com/koblesystems/koble-mcp/master/scripts/install.sh | KOBLE_SKIP_SETUP=1 bash
  ```
  Installs to `~/.local/bin/koble`.
- Windows (PowerShell):
  ```powershell
  $env:KOBLE_SKIP_SETUP = '1'; irm https://raw.githubusercontent.com/koblesystems/koble-mcp/master/scripts/install.ps1 | iex
  ```
  Installs to `%LOCALAPPDATA%\Programs\koble\koble.exe`.

Check: `koble version` prints a version. If `koble` is not found, use the full path above.

## 2. Ask the person for the serial number, then which companies

Ask for their EBMS serial number (the number at the start of their `…koblesystems.dev` address)
and list what it reaches; this saves nothing, and a wrong serial fails here:

```bash
koble companies --serial <serial>
```

Show them the list and ask, in one message:

1. Which companies the agent may use. Only these are visible to it.
2. A test company, one of those, to limit writes to while trying it out, or `none`.
3. Their EBMS username (and which companies, if any, use a different one).

## 3. Save the settings and connect the Claude apps

```bash
koble setup --serial <serial> --companies <ID,ID> --sandbox <company or none> --username <username> --skip-password --yes
```

`--companies` is required here: without a terminal, setup will not guess which companies to
enable. It saves the settings and connects Claude Desktop and Claude Code where they are installed.

## 4. The passwords — the person does this

Tell them: *open a terminal (PowerShell on Windows), run `koble login`, and type the username (or
press Enter to keep it) and password for each company; nothing shows while you type the
password.* Wait until they confirm it printed "<company>: signed in as …" for each.

## 5. Verify

```bash
koble doctor --json
```

Fix anything marked `fail` using its `fix` field, then tell them to quit and reopen Claude Desktop,
or start a new Claude Code session. Done when no check is `"fail"`.
