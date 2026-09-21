/**
 * MRP netting engine. Pure: no network, no clock, no EBMS — everything arrives as data in
 * base units, and `today` is a parameter, so every rule here is unit-tested.
 *
 * The result never depends on the order rows arrive in: demand and supply are sorted, and each
 * item is worked a DAY at a time — that day's receipts, then that day's demand, then one
 * decision — so there is at most one planned order per item per day.
 *
 * For each item, lowest bill-of-material level last:
 *   1. lay its demand and scheduled supply on a timeline;
 *   2. walk the timeline keeping a projected balance;
 *   3. where the balance would go negative — a real stock-out — first pull in a later
 *      scheduled receipt (an "expedite" message), then plan a new order, sized by the lot
 *      rules and released one lead time earlier;
 *   3b. being under the minimum is only acted on if the item is still under it at the end of
 *      the time frame; a dip that a scheduled receipt repairs is not news;
 *   4. planned orders for a made item become dated demand on its components;
 *   5. scheduled receipts the plan never needs are reported ("not needed").
 * Every planned order remembers the demands that caused it, so any number can be explained.
 */

export type DemandKind = "sales" | "job" | "batch" | "dependent" | "forecast" | "minimum";
export type SupplyKind = "purchase" | "batch";

export interface ItemParams {
    id: string;
    onHand: number;
    /**
     * Days from release to receipt. EBMS does not publish lead time through its API yet, so
     * this is usually absent: the order then carries only a needed-by date, and says so.
     */
    leadTimeDays?: number;
    /** The level the projected balance must not fall below (EBMS's MIN_INVEN). */
    safetyStock?: number;
    /** When set, an order brings the balance up to this level (EBMS's MAX_INVEN) instead of just back to the minimum. */
    orderUpTo?: number;
    /** Orders are rounded up to a multiple of this (EBMS's reorder increment). */
    orderMultiple?: number;
    /** True when the item is manufactured; its planned orders explode through `components`. */
    make?: boolean;
    components?: Array<{ item: string; qtyPer: number }>;
}

export interface Demand {
    item: string;
    qty: number;
    /** ISO date, yyyy-mm-dd. */
    date: string;
    kind: DemandKind;
    /** What caused it: an order number, a batch, a parent planned order. */
    ref: string;
}

export interface Supply {
    item: string;
    qty: number;
    date: string;
    kind: SupplyKind;
    ref: string;
    /** True when the date was assumed rather than read from EBMS. */
    dateAssumed?: boolean;
}

export interface Peg {
    ref: string;
    kind: DemandKind;
    qty: number;
    date: string;
}

export interface PlannedOrder {
    item: string;
    action: "buy" | "make";
    qty: number;
    /** When the quantity is needed in stock. */
    receiptDate: string;
    /** When the order must be placed or the batch started. */
    releaseDate: string;
    /** The release date has already passed; the receipt date cannot be met by lead time. */
    pastDue: boolean;
    /** False when no lead time was supplied: releaseDate then simply equals receiptDate. */
    leadTimeKnown: boolean;
    pegs: Peg[];
}

export type ExceptionType = "expedite" | "not-needed" | "past-due-release" | "past-due-demand" | "unknown-item" | "bom-cycle" | "assumed-date";

export interface PlanException {
    type: ExceptionType;
    item: string;
    ref: string;
    message: string;
    from?: string;
    to?: string;
    qty?: number;
    /** On an expedite: the receipt had no expected date in EBMS, so "from" is an assumption. */
    dateAssumed?: boolean;
}

export interface TimelineRow {
    date: string;
    change: number;
    balance: number;
    what: string;
}

export interface ItemPlan {
    item: string;
    level: number;
    timeline: TimelineRow[];
    endingBalance: number;
}

/** Demand and supply dated after the horizon: counted for the reader, left out of the netting. */
export interface BeyondHorizon {
    item: string;
    demandQty: number;
    supplyQty: number;
    firstDemandDate: string | null;
    /** The receipts themselves, so a buyer can see what is already on order just past the time frame. */
    supplies: Array<{ kind: SupplyKind; ref: string; qty: number; date: string }>;
}

export interface Plan {
    /** The last date the plan covers, or null when everything on file was planned. */
    through: string | null;
    plannedOrders: PlannedOrder[];
    exceptions: PlanException[];
    items: ItemPlan[];
    beyondHorizon: BeyondHorizon[];
}

const round = (value: number): number => Math.round(value * 10_000) / 10_000;
const DAY = 86_400_000;
export const addDays = (date: string, days: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const later = (a: string, b: string): string => (a > b ? a : b);
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Order quantity for a shortfall, rounded up to the reorder increment. Never zero for a real shortfall. */
export function lotSize(shortfall: number, item: Pick<ItemParams, "orderMultiple">): number {
    if (shortfall <= 0) return 0;
    const multiple = item.orderMultiple ?? 0;
    return round(multiple > 0 ? Math.ceil(shortfall / multiple - 1e-9) * multiple : shortfall);
}

export interface LowLevel {
    levels: Map<string, number>;
    /** Each distinct loop, once. */
    cycles: string[][];
    /** `parent>component` edges left out so the rest of the structure can still be planned. */
    broken: Set<string>;
}

/**
 * Low-level codes: an item's level is one more than the deepest parent that uses it, so
 * planning by ascending level sees all of an item's dependent demand before netting it.
 * A loop is broken at exactly one edge — the one that closes it, walking items in ID order —
 * so every other link in the loop is still planned. An item that lists itself (a rework
 * batch) simply is not its own parent.
 */
export function lowLevelCodes(items: readonly ItemParams[]): LowLevel {
    const byId = new Map(items.map((item) => [item.id, item]));
    const ids = [...new Set([...byId.keys(), ...items.flatMap((item) => (item.components ?? []).map((c) => c.item))])].sort(cmp);
    const state = new Map<string, "open" | "done">();
    const broken = new Set<string>();
    const cycles: string[][] = [];
    const seenCycles = new Set<string>();
    const walk = (id: string, path: string[]): void => {
        state.set(id, "open");
        for (const component of [...(byId.get(id)?.components ?? [])].sort((a, b) => cmp(a.item, b.item))) {
            if (component.item === id) continue;
            if (state.get(component.item) === "open") {
                broken.add(`${id}>${component.item}`);
                const loop = [...path.slice(path.indexOf(component.item)), id];
                const key = [...loop].sort(cmp).join("|");
                if (!seenCycles.has(key)) {
                    seenCycles.add(key);
                    cycles.push([...loop, component.item]);
                }
            } else if (state.get(component.item) !== "done") walk(component.item, [...path, id]);
        }
        state.set(id, "done");
    };
    for (const id of ids) if (!state.has(id)) walk(id, []);

    const parents = new Map<string, string[]>();
    for (const item of items) {
        for (const component of item.components ?? []) {
            if (component.item === item.id || broken.has(`${item.id}>${component.item}`)) continue;
            parents.set(component.item, [...(parents.get(component.item) ?? []), item.id]);
        }
    }
    const levels = new Map<string, number>();
    const levelOf = (id: string): number => {
        const known = levels.get(id);
        if (known !== undefined) return known;
        levels.set(id, 0); // guards against anything the walk missed
        const level = Math.max(0, ...(parents.get(id) ?? []).map((parent) => levelOf(parent) + 1));
        levels.set(id, level);
        return level;
    };
    for (const id of ids) levelOf(id);
    return { levels, cycles, broken };
}

interface Receipt extends Supply {
    /** The date it is scheduled for, never earlier than today. */
    due: string;
    used: boolean;
    /** The date the plan counts it in: its due date, or the earlier date it was pulled in to. */
    effective: string;
}

function planItem(item: ItemParams, demandsIn: readonly Demand[], suppliesIn: readonly Supply[], today: string, laterShortfall: number, out: { orders: PlannedOrder[]; exceptions: PlanException[] }): ItemPlan & { planned: PlannedOrder[] } {
    const safety = item.safetyStock ?? 0;
    const target = Math.max(safety, item.orderUpTo ?? 0);
    const action = item.make ? "make" : "buy";
    const leadTimeKnown = item.leadTimeDays !== undefined;

    const demands = demandsIn.filter((d) => d.qty > 0).map((d) => ({ ...d, due: later(d.date, today) })).sort((a, b) => cmp(a.due, b.due) || cmp(a.kind, b.kind) || cmp(a.ref, b.ref) || a.qty - b.qty);
    const receipts: Receipt[] = suppliesIn.filter((s) => s.qty > 0).map((s) => ({ ...s, due: later(s.date, today), used: false, effective: later(s.date, today) })).sort((a, b) => cmp(a.due, b.due) || cmp(a.kind, b.kind) || cmp(a.ref, b.ref) || a.qty - b.qty);

    for (const demand of demands) {
        if (demand.date < today && demand.kind !== "dependent") {
            out.exceptions.push({ type: "past-due-demand", item: item.id, ref: demand.ref, qty: demand.qty, from: demand.date, message: `${demand.kind} ${demand.ref} was due ${demand.date}; planned as due today.` });
        }
    }

    const timeline: TimelineRow[] = [{ date: today, change: 0, balance: round(item.onHand), what: "on hand" }];
    const planned: PlannedOrder[] = [];
    const endOfDay: Array<{ date: string; balance: number }> = [];
    const place = (order: PlannedOrder): void => {
        planned.push(order);
        if (!order.pastDue) return;
        out.exceptions.push({
            type: "past-due-release",
            item: item.id,
            ref: order.pegs[0]?.ref ?? "",
            qty: order.qty,
            from: order.releaseDate,
            to: order.receiptDate,
            message: `To have ${order.qty} of ${item.id} by ${order.receiptDate} this should have been released ${order.releaseDate} (lead time ${item.leadTimeDays ?? 0} days).`,
        });
    };
    const newOrder = (date: string, qty: number, pegs: Peg[]): PlannedOrder => {
        const releaseDate = addDays(date, -(item.leadTimeDays ?? 0));
        return { item: item.id, action, qty, receiptDate: date, releaseDate, pastDue: leadTimeKnown && releaseDate < today, leadTimeKnown, pegs };
    };

    let balance = round(item.onHand);
    const startsShort = round(item.onHand) < 0;
    const days = [...new Set([...(startsShort ? [today] : []), ...demands.map((d) => d.due), ...receipts.map((r) => r.due)])].sort(cmp);
    for (const date of days) {
        for (const receipt of receipts) {
            if (receipt.due !== date || receipt.used) continue;
            receipt.used = true;
            balance = round(balance + receipt.qty);
            timeline.push({ date, change: receipt.qty, balance, what: `${receipt.kind} ${receipt.ref}` });
        }
        let pegs: Peg[] = startsShort && date === today ? [{ ref: "0 (on hand is negative)", kind: "minimum", qty: round(-item.onHand), date }] : [];
        for (const demand of demands) {
            if (demand.due !== date) continue;
            const before = balance;
            balance = round(balance - demand.qty);
            timeline.push({ date, change: -demand.qty, balance, what: `${demand.kind} ${demand.ref}` });
            const pushedUnder = round(Math.max(0, -balance) - Math.max(0, -before));
            if (pushedUnder > 0) pegs.push({ ref: demand.ref, kind: demand.kind, qty: pushedUnder, date });
        }
        // A real stock-out: pull in the EARLIEST later receipts first, then plan what is still missing.
        while (balance < 0) {
            const next = receipts.find((r) => !r.used);
            if (!next) break;
            next.used = true;
            next.effective = date;
            balance = round(balance + next.qty);
            timeline.push({ date, change: next.qty, balance, what: `${next.kind} ${next.ref} (${next.dateAssumed ? "no expected date; needed now" : `expedited from ${next.due}`})` });
            const why = pegs.map((peg) => `${peg.kind} ${peg.ref}`).join(", ") || "a negative on-hand balance";
            out.exceptions.push({
                type: "expedite", item: item.id, ref: next.ref, qty: next.qty, from: next.due, to: date, ...(next.dateAssumed ? { dateAssumed: true } : {}),
                message: next.dateAssumed
                    ? `${next.kind} ${next.ref}: ${next.qty} of ${item.id} has no expected date in EBMS, and is needed by ${date} for ${why}.`
                    : `${next.kind} ${next.ref}: ${next.qty} of ${item.id} is due ${next.due} but is needed ${date} for ${why}.`,
            });
        }
        if (balance < 0) {
            // What receipts pulled in has covered comes off the earliest reasons first, so the order's
            // reasons add up to the shortage it actually covers.
            let uncovered = round(-balance);
            pegs = [...pegs].reverse().map((peg) => { const qty = round(Math.min(peg.qty, uncovered)); uncovered = round(uncovered - qty); return { ...peg, qty }; }).filter((peg) => peg.qty > 0).reverse();
            const qty = lotSize(round(target - balance), item);
            balance = round(balance + qty);
            timeline.push({ date, change: qty, balance, what: `planned ${action}` });
            place(newOrder(date, qty, pegs));
        }
        endOfDay.push({ date, balance });
    }

    // Still under the minimum when the time frame ends: restore it, dated from the start of the
    // final stretch below the minimum, and folded into that day's order if there already is one.
    if (balance < safety) {
        let since = endOfDay.length;
        while (since > 0 && (endOfDay[since - 1]?.balance ?? 0) < safety) since -= 1;
        const neededBy = since === 0 && round(item.onHand) < safety ? today : (endOfDay[since]?.date ?? today);
        const peg: Peg = { ref: safety > 0 ? String(safety) : "0 (on hand is negative)", kind: "minimum", qty: round(safety - balance), date: neededBy };
        const sameDay = planned.find((order) => order.receiptDate === neededBy);
        if (sameDay) {
            const resized = lotSize(round(target - (balance - sameDay.qty)), item);
            balance = round(balance - sameDay.qty + resized);
            sameDay.qty = resized;
            sameDay.pegs.push(peg);
            timeline.push({ date: neededBy, change: 0, balance, what: `planned ${action} resized to restore the minimum` });
        } else {
            const qty = lotSize(round(target - balance), item);
            balance = round(balance + qty);
            timeline.push({ date: neededBy, change: qty, balance, what: `planned ${action} (restore minimum)` });
            place(newOrder(neededBy, qty, [peg]));
        }
    }

    for (const receipt of receipts) {
        if (receipt.dateAssumed) out.exceptions.push({ type: "assumed-date", item: item.id, ref: receipt.ref, qty: receipt.qty, to: receipt.due, message: `${receipt.kind} ${receipt.ref} has no expected date in EBMS; ${receipt.due} was assumed.` });
    }

    // Receipts the plan gets through without. Judged TOGETHER, latest first: a receipt is only
    // spare if the item still never runs out, and still ends at its minimum, without it AND
    // without every receipt already called spare. Nothing is called spare when new orders had
    // to be planned — cancelling a receipt in order to buy more makes no sense.
    if (planned.length === 0 && days.length > 0) {
        const spare = new Set<Receipt>();
        const survives = (without: ReadonlySet<Receipt>): boolean => {
            let running = round(item.onHand);
            for (const date of days) {
                for (const receipt of receipts) if (receipt.effective === date && !without.has(receipt)) running = round(running + receipt.qty);
                for (const demand of demands) if (demand.due === date) running = round(running - demand.qty);
                if (running < 0) return false;
            }
            // Demand dated after the time frame, beyond what is already on order for then, will need this stock too.
            return running >= safety + laterShortfall;
        };
        for (const receipt of [...receipts].reverse()) {
            if (receipt.effective !== receipt.due) continue; // pulled in to cover a shortage: needed by definition
            if (!survives(new Set([...spare, receipt]))) continue;
            spare.add(receipt);
            out.exceptions.push({ type: "not-needed", item: item.id, ref: receipt.ref, qty: receipt.qty, from: receipt.due, message: `${receipt.kind} ${receipt.ref}: ${receipt.qty} of ${item.id} is not needed by anything in the plan; consider deferring or cancelling it.` });
        }
    }

    out.orders.push(...planned);
    return { item: item.id, level: 0, timeline, endingBalance: balance, planned };
}

/**
 * `through` is the planner's time frame: "buy and make what is needed to cover everything due
 * on or before this date". Demand and supply dated after it are left out of the netting and
 * listed instead, receipts included, so nobody buys what is already on order. Past-due demand
 * is always inside the time frame. Minimum levels are held for the whole time frame.
 */
export function runMrp(input: { today: string; through?: string | undefined; items: readonly ItemParams[]; demands: readonly Demand[]; supplies: readonly Supply[] }): Plan {
    const out = { orders: [] as PlannedOrder[], exceptions: [] as PlanException[] };
    const through = input.through ?? null;
    const inside = (date: string): boolean => through === null || date <= through;
    const beyond = new Map<string, BeyondHorizon>();
    const noteBeyond = (item: string): BeyondHorizon => {
        let row = beyond.get(item);
        if (!row) beyond.set(item, (row = { item, demandQty: 0, supplyQty: 0, firstDemandDate: null, supplies: [] }));
        return row;
    };
    for (const demand of input.demands) {
        if (inside(demand.date)) continue;
        const row = noteBeyond(demand.item);
        row.demandQty = round(row.demandQty + demand.qty);
        row.firstDemandDate = row.firstDemandDate === null || demand.date < row.firstDemandDate ? demand.date : row.firstDemandDate;
    }
    for (const supply of input.supplies) {
        if (inside(supply.date)) continue;
        const row = noteBeyond(supply.item);
        row.supplyQty = round(row.supplyQty + supply.qty);
        row.supplies.push({ kind: supply.kind, ref: supply.ref, qty: supply.qty, date: supply.date });
    }
    for (const row of beyond.values()) row.supplies.sort((a, b) => cmp(a.date, b.date) || cmp(a.ref, b.ref));

    const byId = new Map(input.items.map((item) => [item.id, item]));
    const { levels, cycles, broken } = lowLevelCodes(input.items);
    for (const cycle of cycles) {
        const loop = cycle.join(" → ");
        const dropped = cycle.slice(-2).join(" → ");
        out.exceptions.push({ type: "bom-cycle", item: cycle[0] ?? "", ref: loop, message: `Bill of materials loops: ${loop}. The link that closes the loop (${dropped}) was left out; every other link was planned.` });
    }

    const demands = new Map<string, Demand[]>();
    const supplies = new Map<string, Supply[]>();
    const push = <T>(map: Map<string, T[]>, key: string, value: T): void => void map.set(key, [...(map.get(key) ?? []), value]);
    for (const demand of input.demands) if (inside(demand.date)) push(demands, demand.item, demand);
    for (const supply of input.supplies) if (inside(supply.date)) push(supplies, supply.item, supply);

    const unknown = new Set<string>();
    const noteUnknown = (id: string, why: string): void => {
        if (unknown.has(id)) return;
        unknown.add(id);
        out.exceptions.push({ type: "unknown-item", item: id, ref: id, message: `${id} ${why} but has no planning parameters; it was not planned.` });
    };
    for (const id of [...new Set([...demands.keys(), ...supplies.keys()])].sort(cmp)) if (!byId.has(id)) noteUnknown(id, "has demand or supply");

    const order = [...byId.values()].sort((a, b) => (levels.get(a.id) ?? 0) - (levels.get(b.id) ?? 0) || cmp(a.id, b.id));
    const items: ItemPlan[] = [];
    for (const item of order) {
        const afterFrame = beyond.get(item.id);
        const plan = planItem(item, demands.get(item.id) ?? [], supplies.get(item.id) ?? [], input.today, afterFrame ? Math.max(0, round(afterFrame.demandQty - afterFrame.supplyQty)) : 0, out);
        items.push({ item: plan.item, level: levels.get(item.id) ?? 0, timeline: plan.timeline, endingBalance: plan.endingBalance });
        if (!item.make) continue;
        for (const planned of plan.planned) {
            for (const component of item.components ?? []) {
                if (component.item === item.id || broken.has(`${item.id}>${component.item}`)) continue;
                if (!byId.has(component.item)) {
                    noteUnknown(component.item, `is needed to make ${item.id}`);
                    continue;
                }
                push(demands, component.item, { item: component.item, qty: round(planned.qty * component.qtyPer), date: later(planned.releaseDate, input.today), kind: "dependent", ref: `make ${item.id} x${planned.qty} for ${planned.receiptDate}` });
            }
        }
    }
    const kindRank: Record<string, number> = { expedite: 0, "past-due-release": 1, "not-needed": 2, "bom-cycle": 3, "unknown-item": 4, "past-due-demand": 5, "assumed-date": 6 };
    out.exceptions.sort((a, b) => (kindRank[a.type] ?? 9) - (kindRank[b.type] ?? 9) || cmp(a.item, b.item) || cmp(a.ref, b.ref));
    out.orders.sort((a, b) => cmp(a.receiptDate, b.receiptDate) || cmp(a.item, b.item));
    return { through, plannedOrders: out.orders, exceptions: out.exceptions, items, beyondHorizon: [...beyond.values()].sort((a, b) => cmp(a.item, b.item)) };
}
