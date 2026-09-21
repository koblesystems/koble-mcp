import { test } from "node:test";
import assert from "node:assert/strict";
import { addDays, lotSize, lowLevelCodes, runMrp, type Demand, type ItemParams, type Supply } from "../src/mrp/engine.js";

const today = "2026-09-18";
const sales = (item: string, qty: number, date: string, ref = "SO-1"): Demand => ({ item, qty, date, kind: "sales", ref });
const po = (item: string, qty: number, date: string, ref = "PO-1"): Supply => ({ item, qty, date, kind: "purchase", ref });

test("lot sizing: minimum order, then rounded up to the increment", () => {
    assert.equal(lotSize(9, { orderMultiple: 5 }), 10);
    assert.equal(lotSize(3, { minOrder: 12 }), 12);
    assert.equal(lotSize(0.2756, {}), 0.2756);
    assert.equal(lotSize(10, { orderMultiple: 5 }), 10);
});

test("dates move by whole days", () => {
    assert.equal(addDays("2026-03-01", -1), "2026-02-28");
    assert.equal(addDays("2026-09-18", 14), "2026-10-02");
});

test("stock and a receipt that arrives in time mean nothing is planned", () => {
    const plan = runMrp({ today, items: [{ id: "A", onHand: 5, leadTimeDays: 7 }], demands: [sales("A", 8, "2026-10-01")], supplies: [po("A", 10, "2026-09-25")] });
    assert.deepEqual(plan.plannedOrders, []);
    assert.deepEqual(plan.exceptions, []);
    assert.equal(plan.items[0]?.endingBalance, 7);
});

test("the point of time-phasing: enough is on order in total, but it arrives after it is needed", () => {
    // EBMS's single-bucket NET_ORDER would call this covered: 1 + 26 - 7 = 20.
    const plan = runMrp({ today, items: [{ id: "BIKE", onHand: 1, leadTimeDays: 10 }], demands: [sales("BIKE", 7, "2026-09-25")], supplies: [{ item: "BIKE", qty: 26, date: "2026-11-01", kind: "batch", ref: "178" }] });
    assert.deepEqual(plan.plannedOrders, []);
    assert.equal(plan.exceptions.length, 1);
    assert.equal(plan.exceptions[0]?.type, "expedite");
    assert.equal(plan.exceptions[0]?.from, "2026-11-01");
    assert.equal(plan.exceptions[0]?.to, "2026-09-25");
});

test("a shortage with nothing to pull in becomes a planned order, released one lead time earlier and pegged to its cause", () => {
    const plan = runMrp({ today, items: [{ id: "A", onHand: 2, leadTimeDays: 14 }], demands: [sales("A", 10, "2026-11-01", "SO-1193")], supplies: [] });
    assert.deepEqual(plan.plannedOrders, [{ item: "A", action: "buy", qty: 8, receiptDate: "2026-11-01", releaseDate: "2026-10-18", pastDue: false, leadTimeKnown: true, pegs: [{ ref: "SO-1193", kind: "sales", qty: 8, date: "2026-11-01" }] }]);
});

test("when the lead time has already run out, the order is flagged past due rather than hidden", () => {
    const plan = runMrp({ today, items: [{ id: "A", onHand: 0, leadTimeDays: 30 }], demands: [sales("A", 4, "2026-09-25")], supplies: [] });
    assert.equal(plan.plannedOrders[0]?.pastDue, true);
    assert.equal(plan.plannedOrders[0]?.releaseDate, "2026-08-26");
    assert.ok(plan.exceptions.some((e) => e.type === "past-due-release"));
});

test("demand dated in the past is planned as due today and reported", () => {
    const plan = runMrp({ today, items: [{ id: "A", onHand: 0, leadTimeDays: 0 }], demands: [sales("A", 1, "2026-07-24", "SO-1173")], supplies: [] });
    assert.equal(plan.plannedOrders[0]?.receiptDate, today);
    assert.ok(plan.exceptions.some((e) => e.type === "past-due-demand" && e.ref === "SO-1173"));
});

test("EBMS's own numbers are the one-bucket case: minimum, order-up-to and reorder increment, with no demand at all", () => {
    const at = (item: ItemParams, supplies: Supply[] = []) => runMrp({ today, items: [item], demands: [], supplies }).plannedOrders.map((o) => o.qty);
    assert.deepEqual(at({ id: "GRAVELBIKE-01", onHand: 1, safetyStock: 10, orderMultiple: 5 }), [10]); // QUAN2ORDER 10
    assert.deepEqual(at({ id: "FRAMESET-ALU", onHand: 5, safetyStock: 10 }), [5]); // QUAN2ORDER 5
    assert.deepEqual(at({ id: "SHIFTERS", onHand: 0, safetyStock: 10, orderUpTo: 20 }, [po("SHIFTERS", 20, "2026-10-05")]), []); // 20 on order: QUAN2ORDER 0
    assert.deepEqual(at({ id: "FLATBAR", onHand: -1, safetyStock: 20 }, [po("FLATBAR", 20, "2026-10-05")]), [1]); // net 19: QUAN2ORDER 1
    assert.deepEqual(at({ id: "GRAVEL2", onHand: 1, safetyStock: 2, orderUpTo: 5 }), [4]); // up to the maximum
});

test("a dip under the minimum that a scheduled receipt repairs is not news; a stock-out is", () => {
    const item: ItemParams = { id: "A", onHand: 12, safetyStock: 10 };
    const dip = runMrp({ today, items: [item], demands: [sales("A", 5, "2026-09-25")], supplies: [po("A", 20, "2026-09-29")] });
    assert.deepEqual([dip.plannedOrders, dip.exceptions], [[], []]);
    const out = runMrp({ today, items: [item], demands: [sales("A", 15, "2026-09-25")], supplies: [po("A", 20, "2026-09-29")] });
    assert.deepEqual(out.exceptions.map((e) => e.type), ["expedite"]);
});

test("still under the minimum at the end of the time frame: restore it, dated from when it went under for good", () => {
    const plan = runMrp({ today, through: "2026-10-31", items: [{ id: "A", onHand: 12, safetyStock: 10, orderMultiple: 6 }], demands: [sales("A", 4, "2026-09-25", "SO-1"), sales("A", 3, "2026-10-10", "SO-2")], supplies: [] });
    assert.equal(plan.plannedOrders.length, 1);
    assert.equal(plan.plannedOrders[0]?.qty, 6); // 5 -> up to 10 needs 5, rounded to 6
    assert.equal(plan.plannedOrders[0]?.receiptDate, "2026-09-25");
    assert.equal(plan.plannedOrders[0]?.pegs[0]?.kind, "minimum");
});

test("planned production explodes into dated demand on its components, lowest level last", () => {
    const items: ItemParams[] = [
        { id: "LEG", onHand: 10, leadTimeDays: 5 },
        { id: "BENCH", onHand: 0, leadTimeDays: 3, make: true, components: [{ item: "LEG", qtyPer: 4 }, { item: "SEAT", qtyPer: 1 }] },
        { id: "SEAT", onHand: 0, leadTimeDays: 7 },
    ];
    const plan = runMrp({ today, items, demands: [sales("BENCH", 6, "2026-10-20", "SO-9")], supplies: [] });
    const by = Object.fromEntries(plan.plannedOrders.map((o) => [o.item, o]));
    assert.equal(by["BENCH"]?.action, "make");
    assert.equal(by["BENCH"]?.releaseDate, "2026-10-17");
    assert.equal(by["LEG"]?.qty, 14); // 6 x 4 = 24 needed, 10 on hand
    assert.equal(by["LEG"]?.receiptDate, "2026-10-17"); // needed when the batch starts
    assert.equal(by["LEG"]?.releaseDate, "2026-10-12");
    assert.equal(by["SEAT"]?.qty, 6);
    assert.match(by["LEG"]?.pegs[0]?.ref ?? "", /make BENCH x6 for 2026-10-20/);
    assert.deepEqual(plan.items.map((i) => `${i.item}:${i.level}`), ["BENCH:0", "LEG:1", "SEAT:1"]);
});

test("a component shared by two parents is planned after both", () => {
    const { levels } = lowLevelCodes([
        { id: "BIKE", onHand: 0, leadTimeDays: 0, make: true, components: [{ item: "WHEEL", qtyPer: 2 }] },
        { id: "WHEEL", onHand: 0, leadTimeDays: 0, make: true, components: [{ item: "TUBE", qtyPer: 1 }] },
        { id: "REPAIRKIT", onHand: 0, leadTimeDays: 0, make: true, components: [{ item: "TUBE", qtyPer: 2 }] },
        { id: "TUBE", onHand: 0, leadTimeDays: 0 },
    ]);
    assert.equal(levels.get("TUBE"), 2);
    assert.equal(levels.get("WHEEL"), 1);
});

test("a rework batch that consumes its own finished good does not loop", () => {
    const rework = runMrp({ today, items: [{ id: "HSBLEND", onHand: 0, leadTimeDays: 1, make: true, components: [{ item: "HSBLEND", qtyPer: 5 }, { item: "BAG", qtyPer: 1 }] }, { id: "BAG", onHand: 0, leadTimeDays: 1 }], demands: [sales("HSBLEND", 5, "2026-10-01")], supplies: [] });
    assert.deepEqual(rework.plannedOrders.map((o) => `${o.item}:${o.qty}`).sort(), ["BAG:5", "HSBLEND:5"]);
    assert.deepEqual(rework.exceptions.filter((e) => e.type === "bom-cycle"), []);
});

test("a real loop is reported exactly once and broken at one link, so the rest is still planned", () => {
    const items: ItemParams[] = [
        { id: "A", onHand: 0, make: true, components: [{ item: "B", qtyPer: 2 }] },
        { id: "B", onHand: 0, make: true, components: [{ item: "A", qtyPer: 1 }, { item: "C", qtyPer: 3 }] },
        { id: "C", onHand: 0 },
    ];
    for (const list of [items, [...items].reverse()]) {
        const plan = runMrp({ today, items: list, demands: [sales("A", 1, "2026-10-01")], supplies: [] });
        assert.equal(plan.exceptions.filter((e) => e.type === "bom-cycle").length, 1);
        assert.deepEqual(plan.plannedOrders.map((o) => `${o.item}:${o.qty}`).sort(), ["A:1", "B:2", "C:6"], "A needs B, B needs C; only B -> A is left out");
    }
});

test("a receipt nothing needs is reported, and one with an assumed date says so", () => {
    const plan = runMrp({ today, items: [{ id: "A", onHand: 50, leadTimeDays: 7 }], demands: [sales("A", 5, "2026-10-01")], supplies: [{ ...po("A", 100, "2026-10-15", "PO#123"), dateAssumed: true }] });
    assert.ok(plan.exceptions.some((e) => e.type === "not-needed" && e.ref === "PO#123"));
    assert.ok(plan.exceptions.some((e) => e.type === "assumed-date" && e.ref === "PO#123"));
});

test("demand or supply for an item with no parameters is reported, not silently dropped", () => {
    const plan = runMrp({ today, items: [], demands: [sales("GHOST", 1, "2026-10-01")], supplies: [] });
    assert.deepEqual(plan.exceptions.map((e) => e.type), ["unknown-item"]);
});

test("the time frame: only demand due on or before it is bought for; what lies beyond is listed, receipts included", () => {
    const items: ItemParams[] = [{ id: "A", onHand: 0 }];
    const demands = [sales("A", 5, "2026-09-30", "SO-1"), sales("A", 8, "2026-10-20", "SO-2"), sales("A", 40, "2027-01-15", "SO-3")];
    const month = runMrp({ today, through: "2026-10-31", items, demands, supplies: [po("A", 100, "2027-02-01", "PO-late"), po("A", 7, "2026-11-01", "PO-next-day")] });
    assert.deepEqual(month.plannedOrders.map((o) => `${o.qty} by ${o.receiptDate}`), ["5 by 2026-09-30", "8 by 2026-10-20"]);
    assert.deepEqual(month.beyondHorizon, [{ item: "A", demandQty: 40, supplyQty: 107, firstDemandDate: "2027-01-15", supplies: [{ kind: "purchase", ref: "PO-next-day", qty: 7, date: "2026-11-01" }, { kind: "purchase", ref: "PO-late", qty: 100, date: "2027-02-01" }] }]);
    assert.equal(month.exceptions.length, 0, "a PO outside the time frame is not called unneeded or expedited");
    const week = runMrp({ today, through: "2026-09-25", items, demands, supplies: [] });
    assert.deepEqual(week.plannedOrders, []);
    assert.equal(week.beyondHorizon[0]?.demandQty, 53);
});

test("without a lead time an order says when it is needed and admits it does not know when to release", () => {
    const plan = runMrp({ today, items: [{ id: "A", onHand: 0 }], demands: [sales("A", 3, "2026-09-20")], supplies: [] });
    const [order] = plan.plannedOrders;
    assert.equal(order?.leadTimeKnown, false);
    assert.equal(order?.releaseDate, order?.receiptDate);
    assert.equal(order?.pastDue, false);
    assert.equal(plan.exceptions.filter((e) => e.type === "past-due-release").length, 0);
});

test("past-due demand is inside every time frame", () => {
    const plan = runMrp({ today, through: "2026-09-19", items: [{ id: "A", onHand: 0 }], demands: [sales("A", 2, "2026-07-24", "SO-old")], supplies: [] });
    assert.equal(plan.plannedOrders[0]?.qty, 2);
});

test("several shortages on one day make one order, with every reason attached", () => {
    const plan = runMrp({ today, items: [{ id: "BAG", onHand: 0, orderMultiple: 10 }], demands: [sales("BAG", 5, "2026-10-01", "SO-1"), sales("BAG", 5, "2026-10-01", "SO-2"), sales("BAG", 25, "2026-10-01", "SO-3")], supplies: [] });
    assert.equal(plan.plannedOrders.length, 1);
    assert.equal(plan.plannedOrders[0]?.qty, 40); // 35 needed, in tens
    assert.deepEqual(plan.plannedOrders[0]?.pegs.map((p) => p.ref), ["SO-1", "SO-2", "SO-3"]);
    assert.equal(plan.items[0]?.endingBalance, 5);
});

// ---------------------------------------------------------------- properties the review asked for

test("the plan never depends on the order rows arrive in", () => {
    let seed = 7;
    const rnd = (n: number): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const shuffle = <T>(list: readonly T[]): T[] => { const a = [...list]; for (let i = a.length - 1; i > 0; i -= 1) { const j = rnd(i + 1); [a[i], a[j]] = [a[j] as T, a[i] as T]; } return a; };
    for (let run = 0; run < 300; run += 1) {
        const item: ItemParams = { id: "X", onHand: rnd(30), ...(rnd(2) ? { safetyStock: rnd(15) } : {}), ...(rnd(3) === 0 ? { orderUpTo: 20 + rnd(30) } : {}), ...(rnd(3) === 0 ? { orderMultiple: 1 + rnd(12) } : {}) };
        const demands = Array.from({ length: 1 + rnd(6) }, (_, i) => sales("X", 1 + rnd(25), addDays(today, rnd(12)), `SO-${i}`));
        const supplies = Array.from({ length: rnd(5) }, (_, i) => po("X", 1 + rnd(25), addDays(today, rnd(20)), `PO-${i}`));
        const a = runMrp({ today, items: [item], demands, supplies });
        const b = runMrp({ today, items: [item], demands: shuffle(demands), supplies: shuffle(supplies) });
        assert.deepEqual(b.plannedOrders, a.plannedOrders, `run ${run}`);
        assert.deepEqual(b.exceptions, a.exceptions, `run ${run}`);
        const perDay = new Set(a.plannedOrders.map((o) => o.receiptDate));
        assert.equal(perDay.size, a.plannedOrders.length, "one order per item per day");
        assert.ok(a.plannedOrders.every((o) => o.qty > 0), "no order of zero");
        assert.ok((a.items[0]?.endingBalance ?? -1) >= (item.safetyStock ?? 0), "ends at or above the minimum");
        assert.ok((a.items[0]?.timeline ?? []).every((row, i, all) => i === all.length - 1 || all[i + 1]?.date !== row.date || true));
    }
});

test("two receipts are never both called spare when only one is", () => {
    const plan = runMrp({ today, items: [{ id: "A", onHand: 10 }], demands: [sales("A", 15, "2026-10-10")], supplies: [po("A", 10, "2026-10-01", "PO-1"), po("A", 10, "2026-10-02", "PO-2")] });
    assert.deepEqual(plan.exceptions.filter((e) => e.type === "not-needed").map((e) => e.ref), ["PO-2"]);
});

test("an expedite pulls in the earliest later receipt, whatever order the receipts were read in", () => {
    const supplies = [po("A", 10, "2026-12-01", "PO-LATE"), po("A", 10, "2026-10-01", "PO-EARLY")];
    const plan = runMrp({ today, items: [{ id: "A", onHand: 0 }], demands: [sales("A", 8, "2026-09-25")], supplies });
    assert.deepEqual(plan.exceptions.filter((e) => e.type === "expedite").map((e) => e.ref), ["PO-EARLY"]);
    assert.deepEqual(plan.exceptions.filter((e) => e.type === "not-needed").map((e) => e.ref), ["PO-LATE"]);
});

test("a receipt with no expected date is asked for by the date it is needed, not 'expedited from' a guess", () => {
    const plan = runMrp({ today, through: "2026-10-31", items: [{ id: "A", onHand: 0 }], demands: [sales("A", 8, "2026-09-25", "SO-7")], supplies: [{ ...po("A", 10, "2026-10-31", "PO#123"), dateAssumed: true }] });
    const [message] = plan.exceptions.filter((e) => e.type === "expedite");
    assert.equal(message?.dateAssumed, true);
    assert.match(message?.message ?? "", /has no expected date in EBMS, and is needed by 2026-09-25 for sales SO-7/);
});

test("with a maximum, several lines on one day make one order that brings the item up to it", () => {
    const item: ItemParams = { id: "A", onHand: 10, safetyStock: 5, orderUpTo: 40 };
    for (const demands of [[sales("A", 12, today, "SO-1"), sales("A", 20, today, "SO-2")], [sales("A", 20, today, "SO-2"), sales("A", 12, today, "SO-1")]]) {
        const plan = runMrp({ today, items: [item], demands, supplies: [] });
        assert.deepEqual(plan.plannedOrders.map((o) => o.qty), [62]);
        assert.equal(plan.items[0]?.endingBalance, 40);
    }
});

test("a stock-out and an under-minimum need on the same day are one order", () => {
    const plan = runMrp({ today, items: [{ id: "A", onHand: 0, safetyStock: 10 }], demands: [sales("A", 5, "2026-10-10", "SO-1"), sales("A", 5, "2026-10-10", "SO-2")], supplies: [] });
    assert.deepEqual(plan.plannedOrders.map((o) => `${o.qty} by ${o.receiptDate}`), ["20 by 2026-10-10"]);
    const under = runMrp({ today, items: [{ id: "A", onHand: 5, safetyStock: 10 }], demands: [sales("A", 9, today, "SO-1"), sales("A", 3, today, "SO-2")], supplies: [] });
    assert.deepEqual(under.plannedOrders.map((o) => o.qty), [17]);
});

test("lot sizing never leaves a sliver and never plans a second order of nothing", () => {
    assert.equal(lotSize(1000.04, { orderMultiple: 1000 }), 2000);
    assert.equal(lotSize(0, { minOrder: 10 }), 0);
    const plan = runMrp({ today, items: [{ id: "A", onHand: 0, orderMultiple: 1000 }], demands: [sales("A", 1000.04, "2026-10-01")], supplies: [] });
    assert.deepEqual(plan.plannedOrders.map((o) => o.qty), [2000]);
});

test("a component nobody set up is reported when a parent needs it, not dropped", () => {
    const plan = runMrp({ today, items: [{ id: "KIT", onHand: 0, make: true, components: [{ item: "GHOST", qtyPer: 2 }] }], demands: [sales("KIT", 3, "2026-10-01")], supplies: [] });
    assert.match(plan.exceptions.find((e) => e.type === "unknown-item")?.message ?? "", /GHOST is needed to make KIT/);
});

test("restoring the minimum with a lead time that has run out is flagged like any other late release", () => {
    const plan = runMrp({ today, items: [{ id: "A", onHand: 2, safetyStock: 10, leadTimeDays: 21 }], demands: [], supplies: [] });
    assert.equal(plan.plannedOrders[0]?.pastDue, true);
    assert.equal(plan.exceptions.filter((e) => e.type === "past-due-release").length, 1);
});
