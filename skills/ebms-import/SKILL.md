---
name: ebms-import
description: Review and import a CSV or Excel file of products, customers, vendors, workers, folders or configuration records into EBMS / Koble (INVENTRY, ARCUST, APVENDOR, PYEMP, ...) — mapping the columns, checking every row against EBMS, writing an exceptions file with only the rows that need fixing, and creating the rest after one yes per file. Use whenever someone wants to "review my customer spreadsheet", "check this product list before we load it", "import these vendors", asks "what's wrong with these rows", says "load the rest of the file", or hands over an export from their old system. Builds on the ebms-api, ebms-products and ebms-customers-vendors skills. Needs the koble-mcp server (tools import_from_csv, ebms_get and ebms_write).
---

# Import a file into EBMS

`import_from_csv` reads the file, checks every row against EBMS and drafts the writes. It
writes nothing. You show the person what it found, get **one yes for the file**, and create
the drafts with `ebms_write`. How to call the tools and read a write's verification is in the
**ebms-api** skill: load it first. If `import_from_csv` is not available, say the koble-mcp
server is not connected (or is older than 0.1.0-rc.14) and stop.

Verified on COF (EBMS 1.8.184, 2026-10-12) through the tool and `ebms_write`, with ZTEST records
that were then deleted: product folders, products, units, vendor records, bills of materials,
vendors, customers (with and without an ID), worker and work-code folders, work codes,
salespeople and a tax rate; reruns that skip what was created; a resend refused. What was not is
listed at the end.

## Ground rules

1. **One file, one yes.** The yes covers the drafts the person was shown the counts and samples
   of, in that file, in that company. A second file, or a second window of the same file after
   a stop, is asked again.
2. **The numbers come from the tool.** Send each draft's `write` exactly as given. Never retype,
   round, pad or "fix" an ID, price, folder or quantity; if something looks wrong, the file
   gets fixed and the tool runs again.
3. **Stop on the first `verification.ok: false`.** Show it, and ask before writing the next one.
4. **Every create carries an `EXTERNALID`** the tool made (`claude-import-<importId>-<date>-r<row>`),
   so a rerun of the same file skips what was created and the server refuses a resend.
5. **What a field means belongs to the per-record skill.** Folders, classification, price,
   cost, units and IDs for products are in **ebms-products**; folders, IDs, names and addresses
   for customers and vendors are in **ebms-customers-vendors**. Open the one for the entity in
   hand before the first question. **Never guess a folder, a classification or a pay
   frequency: ask.**

## 1. Review the file

This is the whole procedure when the person only wants a review.

Get the file's **path** on this computer (an attachment reaches you as text: pass it as `csv`
if it is CSV; ask for the path of an Excel file). Confirm the company by name and which kind
of record the file holds, then call:

```
import_from_csv  company: COF   entity: INVENTRY   path: /Users/…/products.xlsx
```

Entities: `INVENTRY` products · `INVENUNT` units · `INVENDOR` vendor records · `INVENDET`
bill-of-materials lines · `ARCUST` customers · `APVENDOR` vendors · `INVENTRE` / `PYEMPTRE` /
`PYWORKTRE` folders · `ARTAX` tax rates · `PYWORK` work codes · `ARSALESP` salespeople ·
`ARTAXGROUP`, `GLDEPT`, `APTERM`, `GLEDGER`, `INWH`, `INPRICE` configuration. The columns each
accepts are in `references/columns.md`. Three are **review only**: workers (`PYEMP`), whose
creates EBMS refuses through the API, and customer and vendor folders, which are not offered at
all; those are set up in EBMS.

Read out, briefly:

- **`mapping`** (column → field) and **`unmapped`** columns. An unmapped column is not imported;
  say which, so nothing is lost silently.
- **`problems`**, grouped, with counts: "9 IDs are over 24 characters; EBMS would cut them
  silently". Rows are listed only when asked; they are all in the exceptions file.
- **`existing`** ("20 products already exist in COF; skipped, not changed") and
  **`alreadyCreated`** (from an earlier run).
- **`exceptionsFile`**: where it is. It holds only the rows that need a person, with the
  original columns, a Problem column and an empty Fix column.
- **`notes`** and **`writeBlocked`** if present.
- `fatal` with `blocked: true` means nothing can be drafted until that is fixed. Say so.
- `counts.waitingForParent` (folders): rows whose parent folder is another row of this file.
  EBMS numbers a new folder itself, so these are drafted on the next run, once their parent
  exists. A file of nested folders takes one run per level.

Then **one round of questions, at most three**, only what the result needs. If `ask_user_input_v0`
(tappable options) is available, use it; otherwise ask in one short message:

- a required field the file lacks (a folder, a classification): ask for the value and pass it as
  `defaults` (`{"TREE_ID": "26", "C_TYPE": 2}`). It fills blank cells only;
- what to do with an unmapped column that looks important: name the field (`mapping`), or leave it;
- fix the file first, or go on without the problem rows.

Run the tool again with the answers.

## 2. Confirm

Show **three sample drafts** as what EBMS will receive (the `write.body`, and `resolved` where a
folder name became a number), the counts, and anything marked `unverified`. Then ask, in italics:

*"Create these 380 products in COF from products.xlsx? 20 are already there and 5 are in
products.exceptions.xlsx for you to fix."*

That one yes approves this file's drafts.

## 3. Write

Call `ebms_write` for each draft **in order**, with exactly its `method`, `path`, `body` and
`readBack`. Tally as you go; report every 25 or so. Expect about 2.3 seconds a product, under a
second a vendor or folder, 2.3 seconds a customer (COF, 2026-10-12): say so before a long file
("380 products is about 15 minutes").
When `nextRowsFrom` is set, call the tool again with `rowsFrom: <nextRowsFrom>` for the next
window, and continue without asking again unless something stopped you.

What each result means is in `references/outcomes.md`. In short: `ok: true` tally on;
`ok: false` stop, show it, ask; `refused` with `existing` skip; `uncertain` never resend, look
it up by `EXTERNALID` first; "This Id already exists" means run the tool again.

## 4. Rerun and finish

Run the tool again on the same file (pass `importId` if it was renamed, and every row whose
write failed as `failedRows: [{row, problem}]`). Created rows are skipped; what is left and the
failures land in a fresh exceptions file. The person can fix the exceptions file and hand it
straight back: it remembers the import and the original row numbers.

**A rerun with `drafted: 0` and no exceptions file is the completion check.** Report: created,
skipped as already there, and left to fix (with the file's path).

## Small sets

Under about ten records, use the per-record skill (**ebms-products**, **ebms-customers-vendors**).
For a set described in chat that is bigger, write a CSV with the headers in
`references/columns.md`, show it, and import it through this skill.

## Not yet verified

- Workers (`PYEMP`): EBMS refuses every create through the API; the file is reviewed only.
- A tax rate made here is stored as sent but may tax nothing until it is set up in EBMS: see
  **ebms-new-company**'s tax reference before importing rates.
- `GLDEPT`, `INMANUFACTURERS`, `ARTAXGROUP` creates; `APTERM`, `GLEDGER`, `INWH`, `INPRICE` are
  set up in EBMS (the tool refuses the last two: EBMS will not take their key from the API).
- Very large files: 50 products in a row took 110 seconds and a 10-minute loop kept its sign-in;
  a few thousand were not tried.
