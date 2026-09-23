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

## 2. Ask the person three things

1. Their EBMS serial number (the number at the start of their `…koblesystems.dev` address).
2. A test company to limit writes to while trying it out, or `none`.
3. Their EBMS username.

## 3. Save the settings and connect the Claude apps

```bash
koble setup --serial <serial> --username <username> --sandbox <company or none> --skip-password --yes
```

It lists the companies on the serial (a wrong serial fails here), saves the settings, and connects
Claude Desktop and Claude Code where they are installed.

## 4. The password — the person does this

Tell them: *open a terminal (PowerShell on Windows), run `koble login`, and type your EBMS
password; nothing shows while you type.* Wait until they confirm it printed "Signed in to …".

## 5. Verify

```bash
koble doctor --json
```

Fix anything marked `fail` using its `fix` field, then tell them to quit and reopen Claude Desktop,
or start a new Claude Code session. Done when no check is `"fail"`.
