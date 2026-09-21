/** The part of a plan that goes back in the tool result: short lists, with counts for the rest. */
import type { Plan, PlannedOrder } from "./engine.js";
import type { InScope } from "./scope.js";
import type { Snapshot } from "./snapshot.js";

const cap = <T>(list: readonly T[], max: number): { shown: T[]; notShown: number } => ({ shown: list.slice(0, max), notShown: Math.max(0, list.length - max) });
/** Reported as one line each, not row by row: on old data they would bury everything else. */
const QUIET = new Set(["assumed-date", "past-due-demand"]);

export function summarise(plan: Plan, snapshot: Snapshot, inScope: InScope, max: number): Record<string, unknown> {
    const describe = (order: PlannedOrder) => {
        const product = snapshot.products.get(order.item);
        return {
            item: order.item,
            description: product?.description ?? "",
            qty: order.qty,
            neededBy: order.receiptDate,
            ...(order.leadTimeKnown ? { releaseBy: order.releaseDate, pastDue: order.pastDue } : {}),
            ...(order.action === "buy" ? { vendor: product?.vendor || "(no primary vendor)" } : { alsoPurchased: Boolean(product?.vendor) }),
            because: order.pegs.slice(0, 3).map((peg) => `${peg.kind} ${peg.ref}: ${peg.qty} on ${peg.date}`),
        };
    };
    const orders = plan.plannedOrders.filter((order) => inScope(order.item, order.action === "buy" ? "BUY" : "MAKE"));
    const buys = orders.filter((order) => order.action === "buy");
    const makes = orders.filter((order) => order.action === "make");
    const exceptions = plan.exceptions.filter((e) => inScope(e.item, ""));
    const byType: Record<string, number> = {};
    for (const e of exceptions) byType[e.type] = (byType[e.type] ?? 0) + 1;
    const late = exceptions.filter((e) => e.type === "past-due-demand");
    const oldest = late.map((e) => e.from ?? "").filter(Boolean).sort()[0];
    const buying = new Set(buys.map((order) => order.item));
    const later = plan.beyondHorizon.filter((row) => inScope(row.item, ""));

    const buy = cap(buys.map(describe), max);
    const make = cap(makes.map(describe), max);
    const important = cap(exceptions.filter((e) => !QUIET.has(e.type)).map(({ type, item, message }) => ({ type, item, message })), max);
    const onOrderLater = later.filter((row) => row.supplies.length > 0 && buying.has(row.item)).map((row) => ({ item: row.item, onOrder: row.supplies.map((s) => `${s.ref}: ${s.qty} on ${s.date}`) }));
    return {
        counts: { productsPlanned: snapshot.items.length, demandLines: snapshot.demands.length, supplyLines: snapshot.supplies.length, toBuy: buys.length, toMake: makes.length, exceptions: byType },
        buy: buy.shown,
        ...(buy.notShown ? { buyNotShown: buy.notShown } : {}),
        make: make.shown,
        ...(make.notShown ? { makeNotShown: make.notShown } : {}),
        exceptions: important.shown,
        ...(important.notShown ? { exceptionsNotShown: important.notShown } : {}),
        ...(late.length > 0 ? { pastDueDemand: `${late.length} open demand lines were already due before today (oldest ${oldest}); they are planned as due now.` } : {}),
        ...(byType["assumed-date"] ? { assumedDates: `${byType["assumed-date"]} incoming receipts have no expected date in EBMS. They are counted on the last day of the time frame; where one is needed sooner, the plan asks for it by that date.` } : {}),
        ...(onOrderLater.length > 0 ? { alreadyOnOrderAfterTimeFrame: onOrderLater.slice(0, max) } : {}),
        demandAfterTimeFrame: later.filter((row) => row.demandQty > 0).slice(0, 20).map(({ supplies: _supplies, ...row }) => row),
        leftOut: snapshot.skipped,
        warnings: snapshot.warnings,
    };
}
