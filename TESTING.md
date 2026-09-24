# Testing koble

Thank you for trying this. Please use a **test company**: setup asks for one, and while it is set,
nothing can write anywhere else. Every write also asks you first.

## 1. Install (about five minutes)

Follow the README's **Install** section for your system. On Windows that is one line in PowerShell.
Setup asks for:

- the EBMS serial number;
- the test company;
- your username;
- your password, typed hidden and stored in the system's credential store.

Then run:

```
koble doctor
```

Every line should say `ok`, apart from apps you don't have. If not, the line says what to run.

**Please note** anything that was unclear, any warning Windows showed, and how long it took.

## 2. Try each of these

Quit and reopen Claude Desktop first (or start a new Claude Code session). Use the test company.

| # | Ask Claude | What should happen |
|---|---|---|
| 1 | "Which EBMS companies can you see?" | It names them, and says writes go only to the test company. |
| 2 | Claude Desktop: ＋ menu → koble-mcp → **mrp-plan**. Claude Code or Desktop's Code tab: `/ebms-mrp` | It asks how far ahead and which vendors, then gives you a worksheet (CSV) in the chat. |
| 3 | "Why is it telling me to buy <an item from the worksheet>?" | A plain explanation from the plan, with the dates. |
| 4 | "What's on order from <a vendor>?" | A list of open POs; nothing changed. |
| 5 | "Raise a PO to <vendor> for 2 of <product>" | It shows the PO and **asks** before creating it; afterwards it reports the PO number and what EBMS stored. |
| 6 | "Add one more line to that PO, then remove it" | Asks each time; reports each change. |
| 7 | "Receive 1 of the first line" | It warns that receiving changes stock, asks, then reports what arrived. |
| 8 | "Make a task for <worker> to <something> by Friday" | It offers the task types, asks, creates it, and reports the task ID. |
| 9 | "Enter a sales order for <customer>: 2 of <product>" | Asks, creates, reports the order number and EBMS's prices. |
| 10 | "Delete everything you just created" | It lists them and asks before each delete. |

## 3. Things to try breaking

- Ask it to **post** or **process** an order. It should refuse and say that's done in EBMS.
- Close Claude, run `koble login` with a wrong password: it should say so and store nothing.
- Run `koble update`: it should say it's up to date, or update itself.

## 4. What to send back

- The output of `koble doctor` (it never prints your password; it does print your username).
- For anything that went wrong: what you asked, what Claude said, and what EBMS shows.
- Numbers that disagree with what you know, units that come out wrong, and anything a buyer or
  planner would find confusing.
- Time taken, for the MRP run especially.

Open an issue at https://github.com/koblesystems/koble-mcp/issues, or send it directly. Security
problems go through [SECURITY.md](SECURITY.md) instead.

## Removing it

```
koble uninstall
```

It shows everything it will remove and asks first. Please tell us if anything was left behind:
an app that still lists koble-mcp, a leftover folder, or a Credential Manager / Keychain entry.
