import { test } from "node:test";
import assert from "node:assert/strict";
import { configure } from "../src/config.js";
import { resetAuth } from "../src/ebms/client.js";
import { runMrp } from "../src/mrp/engine.js";
import { orderBeforeFrameEnds } from "../src/mrp/report.js";
import { leadTimeFor, takeSnapshot, type ProductInfo } from "../src/mrp/snapshot.js";

const product = (over: Partial<ProductInfo>): ProductInfo => ({
    id: "P", description: "", classification: 2, purchaseMethod: 0, vendor: "ACME", onHand: 0, available: 0, min: 0, max: 0, increment: 0, ebmsQtyToOrder: 0, leadDays: 0, ...over,
});
const vendors = new Map([["ACME", 14]]);

test("a lead time comes from the user, then the product's vendor record, then the vendor, then the user's default", () => {
    assert.deepEqual(leadTimeFor("P", product({ leadDays: 90 }), false, vendors, { leadTimes: { P: 5 } }), { days: 5, from: "you" });
    assert.deepEqual(leadTimeFor("P", product({ leadDays: 90 }), false, vendors, { leadTimeDays: 3 }), { days: 90, from: "product" });
    assert.deepEqual(leadTimeFor("P", product({}), false, vendors, { leadTimeDays: 3 }), { days: 14, from: "vendor" });
    assert.deepEqual(leadTimeFor("P", product({ vendor: "OTHER" }), false, vendors, { leadTimeDays: 3 }), { days: 3, from: "your default" });
    assert.equal(leadTimeFor("P", product({ vendor: "OTHER" }), false, vendors, {}), undefined, "LEAD_DAYS 0 everywhere means not known");
    assert.deepEqual(leadTimeFor("P", product({ leadDays: 90 }), true, vendors, {}), undefined, "a made item has no vendor lead time");
});

// A company of three products, one sales line each, served the way EBMS answers.
let hasLeadDays = true;
globalThis.fetch = (async (url: string | URL) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith("/Token")) return new Response(JSON.stringify({ AccessToken: "a" }), { status: 200 });
    const query = `${u.searchParams.get("$select") ?? ""} ${u.searchParams.get("$expand") ?? ""} ${u.searchParams.get("$filter") ?? ""}`;
    if (!hasLeadDays && query.includes("LEAD_DAYS")) {
        return new Response(JSON.stringify({ Messages: [{ TextBriefDescription: "Invalid query", TextDetail: "Could not find a property named 'LEAD_DAYS' on type 'Model.Entities.INVENDOR'." }] }), { status: 400 });
    }
    const entity = u.pathname.split("/").pop();
    const stock = { C_TYPE: 2, PURC_METH: 0, T_ON_HAND: 0 };
    const rows: Record<string, unknown[]> = {
        INVENTRY: [
            { AUTOID: "1", ID: "CRANK", PRI_VENDOR: "ACME", ...stock },
            { AUTOID: "2", ID: "BAR", PRI_VENDOR: "ACME", ...stock },
            { AUTOID: "3", ID: "BOLT", PRI_VENDOR: "NUTCO", ...stock },
        ],
        // Only rows that set a lead time are asked for. CRANK's other vendor must not be used.
        INVENDOR: [{ AUTOID: "i1", ID: "CRANK", VENDOR_ID: "OTHER", LEAD_DAYS: 7 }, { AUTOID: "i2", ID: "CRANK", VENDOR_ID: "acme", LEAD_DAYS: 120 }],
        APVENDOR: [{ AUTOID: "v1", ID: "ACME", LEAD_DAYS: 14 }],
        ARINVDET: ["CRANK", "BAR", "BOLT"].map((item, i) => ({ AUTOID: `s${i}`, INVOICE: `SO-${i}`, INVEN: item, QUAN: 1, SHIP: 0, SHIP_DATE: "2026-12-01T00:00:00Z", DOC_TYPE: "S", PURC_M_VIS: "Stocked", PAR_TIME: "", TIMESTAMP: `t${i}` })),
    };
    const value = rows[entity ?? ""] ?? [];
    return new Response(JSON.stringify({ value, "@odata.count": value.length }), { status: 200 });
}) as typeof fetch;
const fresh = () => { configure({ EBMS_SERIAL_NUMBER: "000000000000000", EBMS_USERNAME: "u", EBMS_PASSWORD: "p", EBMS_COMPANIES: "sbx" }); resetAuth(); };

test("the snapshot reads lead days from the products' vendor records and from the vendors", async () => {
    fresh();
    hasLeadDays = true;
    const snapshot = await takeSnapshot("sbx", { today: "2026-10-05", through: "2026-12-31" });
    assert.equal(snapshot.leadDaysPublished, true);
    assert.deepEqual(snapshot.leadTimes.get("CRANK"), { days: 120, from: "product" }, "the primary vendor's record, not another vendor's");
    assert.deepEqual(snapshot.leadTimes.get("BAR"), { days: 14, from: "vendor" });
    assert.equal(snapshot.leadTimes.get("BOLT"), undefined, "NUTCO has no lead days");
    const plan = runMrp({ today: "2026-10-05", through: "2026-12-31", items: snapshot.items, demands: snapshot.demands, supplies: snapshot.supplies });
    const crank = plan.plannedOrders.find((o) => o.item === "CRANK");
    assert.equal(crank?.releaseDate, "2026-08-03");
    assert.equal(crank?.pastDue, true);
});

test("an EBMS without LEAD_DAYS still plans, and says why there are no order-by dates", async () => {
    fresh();
    hasLeadDays = false;
    const snapshot = await takeSnapshot("sbx", { today: "2026-10-05", through: "2026-12-31", leadTimeDays: 10 });
    assert.equal(snapshot.leadDaysPublished, false);
    assert.equal(snapshot.items.length, 3);
    assert.ok(snapshot.warnings.some((w) => /does not publish INVENDOR.LEAD_DAYS/.test(w)));
    assert.deepEqual(snapshot.leadTimes.get("CRANK"), { days: 10, from: "your default" });
});

test("demand after the time frame that a long lead time pulls inside it is pointed out", async () => {
    fresh();
    hasLeadDays = true;
    const snapshot = await takeSnapshot("sbx", { today: "2026-10-05", through: "2026-11-15" });
    const plan = runMrp({ today: "2026-10-05", through: "2026-11-15", items: snapshot.items, demands: snapshot.demands, supplies: snapshot.supplies });
    // CRANK (120 days) must be ordered long before the frame ends; BAR's order-by date, 2026-11-17, is after it.
    assert.deepEqual(orderBeforeFrameEnds(plan, snapshot).map((row) => [row.item, row.orderBy]), [["CRANK", "2026-08-03"]]);
});

const sales = (item: string, qty: number, date: string, ref: string) => ({ item, qty, date, kind: "sales" as const, ref });

test("stock left at the end of the time frame covers demand after it before anything is flagged", () => {
    const leadTimes = new Map([["CRANK", { days: 120, from: "product" as const }]]);
    const snapshotWith = (onHand: number) => ({ leadTimes, items: [{ id: "CRANK", onHand }], today: "2026-10-05" }) as unknown as Parameters<typeof orderBeforeFrameEnds>[1];
    const demands = [sales("CRANK", 1, "2026-12-01", "SO-1"), sales("CRANK", 499, "2029-01-01", "SO-2")];
    const plan = (onHand: number) => runMrp({ today: "2026-10-05", through: "2026-11-15", items: [{ id: "CRANK", onHand }], demands, supplies: [] });
    assert.deepEqual(orderBeforeFrameEnds(plan(1000), snapshotWith(1000)), [], "1000 on hand covers both");
    // With nothing on hand only the December line is inside the window; the 2029 line is not ordered now.
    assert.deepEqual(orderBeforeFrameEnds(plan(0), snapshotWith(0)), [{ item: "CRANK", neededFrom: "2026-12-01", qty: 1, leadDays: 120, orderBy: "2026-08-03", make: false }]);
});

test("the worksheet carries order-by dates, lead days and their source", async () => {
    fresh();
    hasLeadDays = true;
    const { buildWorksheet } = await import("../src/mrp/worksheet.js");
    const snapshot = await takeSnapshot("sbx", { today: "2026-10-05", through: "2026-12-31" });
    const plan = runMrp({ today: "2026-10-05", through: "2026-12-31", items: snapshot.items, demands: snapshot.demands, supplies: snapshot.supplies });
    const { rows } = await buildWorksheet("sbx", "run-1", snapshot, plan);
    const row = (item: string) => rows.find((r) => r.Item === item)!;
    assert.equal(row("CRANK")["Order By"], "2026-08-03");
    assert.equal(row("CRANK")["Lead Days"], 120);
    assert.equal(row("CRANK")["Lead From"], "product vendor record");
    assert.match(String(row("CRANK").Recommendation), /^Order 1 now: needed 2026-12-01/);
    assert.equal(row("BAR").Recommendation, "Order 1 by 2026-11-17 to have them 2026-12-01");
    assert.equal(row("BOLT")["Order By"], undefined);
    assert.equal(row("BOLT").Recommendation, "Order 1 by 2026-12-01");
});
