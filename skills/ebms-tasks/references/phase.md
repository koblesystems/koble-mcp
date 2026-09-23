# Move a task through its pipeline

Read `../SKILL.md` first for the ground rules.

A task type can have a pipeline — an ordered set of phases like *In Process*, *Waiting on Parts*,
*Waiting on Client*, *Pending*. The phases belong to the **type**, not to tasks in general.

## The rule that matters

**`PIPE_PHASE` accepts any string at all, with a 200.** There is no validation on the server: the
EBMS client is the only thing that checks, and a phase that is not real leaves the derived
`PHASE_AID` stale and the task in a phase nothing recognises. So:

1. **Read the phases for that task's type first** and only ever send one of them.
2. **Never write `PHASE_AID`.** EBMS derives it; writing it directly corrupts the record.

## Read the phases

`TAPIPELINE` holds one row per phase per type, keyed to the type by `TATYPE_AID`:

```
ebms_get  path: TATYPES      filter: TYPE eq 'Bike_Repair'   select: AUTOID,TYPE
ebms_get  path: TAPIPELINE   filter: TATYPE_AID eq '<that AUTOID>'
                             select: AUTOID,PIPE_PHASE
```

If the type has no rows, it has no pipeline — say so instead of inventing phases. SBX has 25
phase rows across its types.

`TASK.PIPE_PHASEItems` is EBMS's own list of the valid phases for a task, but it is one of the
virtual fields that appears neither in a plain read nor under `select: *`; name it explicitly in
`select` if you want to try it.

## Move the task

```
ebms_write  company: sbx   method: PATCH   path: TASK('<task AUTOID>')
            body: {"PIPE_PHASE": "Waiting on Parts"}
            readBack: {"record": "PIPE_PHASE,PHASE_AID,STATUS,PIPE_RANK"}
```

Then **check `PHASE_AID` in the read-back**. If it did not change to match the new phase, the
phase string was not one EBMS recognised — tell the user the task is now in a phase the client
may not show, and offer to set it back.

`PIPE_RANK` is the task's position within its phase, for ordering a board. Leave it alone unless
the user asks.

## Verified

On SBX, 2026-09-23: moving a ZTEST `Bike_Repair` task to `Waiting on Parts` stored that phase and
EBMS derived the matching `PHASE_AID` from `TAPIPELINE`. `STATUS` did not change (`Open`).
That an invalid string is also accepted comes from earlier testing of this install, and is why
the read-back check above is not optional.
