# Write outcomes and reruns

What each `ebms_write` result means during an import, and what to do next.

| Result | What it means | Do |
|---|---|---|
| `verification.ok: true` | Created and read back as sent. | Tally it. Report EBMS's values from `verification.rows` when you summarise, not what was sent. |
| `verification.ok: false` | Created (or changed), but EBMS did not store everything as sent. | **Stop.** Show the mismatches and problems exactly as returned, with the row number. Ask before the next write. Do not resend this one. |
| `refused: true` with `existing` | A record with this `EXTERNALID` is already there: an earlier run created it. | Skip it and go on. Not an error. |
| `uncertain: true` | The request reached EBMS and the outcome is unknown (timeout, dropped connection). | **Never resend.** `ebms_get` `path` `<ENTITY>`, `filter` `EXTERNALID eq '<the draft's externalId>'`, `select` `AUTOID,EXTERNALID`. Found: tally it and go on. Not found: tell the person and ask before retrying. |
| `uncertain: false`, error, "This Id already exists" | Someone (or something) created that key since the review. | Run `import_from_csv` again: it will be counted as existing. |
| `uncertain: false`, other error | EBMS refused this row; nothing was saved. | Note the row and EBMS's message, and go on with the rest unless the same error repeats (three in a row means stop and ask: the file or the folder setup is wrong, not the row). Pass these rows as `failedRows` on the rerun. |
| A refusal saying the write was **not sent** (a check before it failed, sign-in failed) | Nothing changed. | Safe to try that one again once. |

## Child rows (units, vendor records)

A draft for `INVENUNT` or `INVENDOR` is one `PATCH` of the product carrying up to 50 rows. Read `verification.problems`: a row that never appeared is listed there. Rows the
product already had were left out by the tool; it never removes or replaces anything.

## Rerunning

1. Call `import_from_csv` with the same `company`, `entity` and file. Pass `importId` from the
   first result if the file was renamed. Pass `failedRows` for the rows EBMS refused.
2. Rows created by any earlier run are in `alreadyCreated`; rows whose key is in EBMS are in
   `existing`. Neither is drafted.
3. The exceptions file is rewritten with what is left. If every row passes, no new one is
   written, and an older one is reported as out of date.
4. `counts.drafted: 0` with `exceptionsFile: null` means the file is done.

The person may instead fix the exceptions file and hand **it** back. Its About sheet carries
the import ID, so created rows are still recognised and the row numbers in messages are the
original file's.
