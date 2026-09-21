# Order commands

Read `../SKILL.md` first for the ground rules.

EBMS commands run as `POST /ARINV('<AUTOID>')/Model.Entities.<Command>`. Verified against SBX
(EBMS 1.8.148, September 2026).

## How commands take input

- **A command with no dialog takes no request body at all.** Sending even `{}` fails with
  `422 The command does not have a dialog`. `RecalculateAllPrices`, `CalculateFreight` and
  `MarkAllAsShipped` are like this.
- **A command with a dialog takes the dialog's fields as the body**, e.g. `ChangeCustomer`.
- **Refer to an existing record inside a dialog by its `Guid`**: `{"NewCustomer": {"Guid": "…"}}`.
  The other forms fail, and two of them fail badly:
  - `{"ID": "…"}` makes EBMS try to **create** a customer ("This Id already exists").
  - `{"@id": "…"}` makes EBMS try to **save** a customer ("Could not find customer defaults").
  - `{"AUTOID": "…"}` is refused (403), and `NewCustomer@odata.bind` isn't recognised.

  Get the Guid with `/ARCUST('<AUTOID>')?$select=Guid`.
- The commands tested returned no useful body. **Read the order back** to see what changed.

## Recalculate all prices

```
POST /ARINV('<AUTOID>')/Model.Entities.RecalculateAllPrices
```

Reprices every line from the customer's price level. **It discards manual prices**: a line the
user had priced at 1.11 went back to 5.97.

Before running it:
1. Read the order and list any lines whose price differs from what the price level would give,
   and any lines with materials.
2. Tell the user those manual prices will be lost.
3. **If the order has materials lists, warn specifically:** it replaces each assembly's
   materials-based price with the assembly product's own price and rescales every material. On
   the test order that tripled the total. See `materials.md`.
4. Run it only on an explicit go-ahead, then read back and report the new line prices and
   `TOTAL_S_SO` next to the old ones.

## Change the customer

A plain `PATCH {"ID": "…"}` is refused: "cannot change the id on a saved entity except with a
command". Use the command:

```
POST /ARINV('<order AUTOID>')/Model.Entities.ChangeCustomer
{"NewCustomer": {"Guid": "<new customer's Guid>"},
 "ChangeAddress": true, "ChangeTerms": true, "RecalculatePrices": true}
```

Each flag is a real choice. Ask the user about all three rather than defaulting them:

| Flag | `true` | `false` |
|---|---|---|
| `ChangeAddress` | Name and address become the new customer's | The old customer's name and address stay on the order |
| `ChangeTerms` | Terms become the new customer's (Cash → Charge in testing) | Old terms stay |
| `RecalculatePrices` | Lines reprice to the new customer's price level (Retail → Wholesale). Tested only on lines with no manual prices; assume manual prices are lost, as with `RecalculateAllPrices`, and warn the user | Prices stay as they are |

With all three `false`, the order bills the new customer but still shows the **old** customer's
name, address, terms and prices. If the user chooses that, confirm it's intended.

Resolve the new customer exactly first (see `../SKILL.md`, *Finding things*), read back
afterwards, and report customer, address, terms and `TOTAL_S_SO` before and after.

## Calculate freight

```
POST /ARINV('<AUTOID>')/Model.Entities.CalculateFreight
```

Only partly verified. On an order shipping via `Pickup` it returned 200 and changed nothing.
Behaviour with a real carrier or freight table was not tested. If you run it, read back
`SHIP_VIA`, `SHIPPING`, `FREIGHT`, `HANDLING` and `TOTAL_SO` and report what changed — possibly
nothing.

## Not available through this skill

Tell the user plainly when asked for one of these, and suggest doing it in EBMS:

| Command | Why |
|---|---|
| `EstimateFees` | Returns **404** on the install tested, with or without a body, despite being in the metadata. |
| `RecordPayment` | Money that can only be voided, never deleted, plus card fields. Reserved for a guarded MCP tool, if ever. |
| `Send` | Emails the customer. Not something an agent should do unprompted, and it can't be tested safely. |
| `GetPdfReport` | Returns a binary PDF. Reserved for an MCP tool that saves it to a file. |
| `PrintReport`, `SelectReport`, `Sign`, scanner commands, `UpdateLocked` | Tied to EBMS screens and devices. |
| Deleting orders | Do it in EBMS, where the person can see what they're removing. |
