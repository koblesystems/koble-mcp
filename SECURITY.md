# Security

koble-mcp holds EBMS credentials and can write to an ERP, so security reports are welcome and
taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting instead: the **Security**
tab of this repository → **Report a vulnerability**. Include what you did, what happened, and
the version (`package.json`) you were running.

## What is in scope

- Anything that lets a request reach an EBMS entity, key, company or command the guards should
  refuse: path or key tricks, a way to send `PROCESS`, a command off the allow-list, a write to a
  company outside `EBMS_COMPANIES` or the sandbox.
- Anything that exposes the serial number, username, password or tokens — in logs, tool results
  or error messages.
- A write reported as verified when it did not land, or reported as safe to retry when it was not.

## What to know when running it

- Credentials are read from the environment the MCP host starts the server with. Keep that
  configuration private.
- Set `EBMS_SANDBOX` while evaluating it, so writes can reach only a test company.
- `EBMS_LOG_FILE`, if set, records requests and responses, which include business data. Treat
  the file accordingly.
