/**
 * MRP netting engine. Pure: no network, no clock, no EBMS — everything arrives as data in
 * base units, and `today` is a parameter, so every rule here is unit-tested.
 *
 * For each item, lowest bill-of-material level last:
 *   1. lay its demand and scheduled supply on a timeline;
 *   2. walk the timeline keeping a projected balance;
 *   3. where the balance would fall below safety stock, first pull in a later scheduled
 *      receipt (an "expedite" message), then plan a new order, sized by the lot rules and
 *      released one lead time earlier;
 *   4. planned orders for a made item become dated demand on its components;
 *   5. scheduled receipts the plan never needs are reported ("not needed").
 * Every planned order remembers the demands that caused it, so any number can be explained.
 */

export type DemandKind = "sales" | "job" | "batch" | "dependent" | "forecast";
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
    /** Smallest order worth placing. */
    minOrder?: number;
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

/** Order quantity for a shortfall: at least the minimum, rounded up to the multiple. */
export function lotSize(shortfall: number, item: Pick<ItemParams, "minOrder" | "orderMultiple">): number {
    let qty = Math.max(shortfall, item.minOrder ?? 0);
    const multiple = item.orderMultiple ?? 0;
    if (multiple > 0) qty = Math.ceil(round(qty / multiple)) * multiple;
    return round(qty);
}

/**
 * Low-level codes: an item's level is one more than the deepest parent that uses it, so
 * planning by ascending level sees all of an item's dependent demand before netting it.
 * An item that lists itself as a component (a rework batch) is ignored as its own parent;
 * a longer cycle is reported and broken.
 */
export function lowLevelCodes(items: readonly ItemParams[]): { levels: Map<string, number>; cycles: string[][] } {
    const byId = new Map(items.map((item) => [item.id, item]));
    const levels = new Map<string, number>(items.map((item) => [item.id, 0]));
    const cycles: string[][] = [];
    const visit = (id: string, level: number, path: string[]): void => {
        if (path.includes(id)) {
            cycles.push([...path.slice(path.indexOf(id)), id]);
            return;
        }
        if (level > (levels.get(id) ?? 0)) levels.set(id, level);
        for (const component of byId.get(id)?.components ?? []) {
            if (component.item === id) continue;
            if (!levels.has(component.item)) levels.set(component.item, 0);
            visit(component.item, level + 1, [...path, id]);
        }
    };
    for (const item of items) visit(item.id, 0, []);
    return { levels, cycles };
}

interface Event {
    date: string;
    /** Supply first on a given day, so a same-day receipt covers a same-day need. */
    order: 0 | 1;
    supply?: Supply;
    demand?: Demand;
}

function planItem(item: ItemParams, demands: Demand[], supplies: Supply[], today: string, out: { orders: PlannedOrder[]; exceptions: PlanException[] }): ItemPlan & { planned: PlannedOrder[] } {
    const safety = item.safetyStock ?? 0;
    const timeline: TimelineRow[] = [{ date: today, change: 0, balance: round(item.onHand), what: "on hand" }];
    const planned: PlannedOrder[] = [];
    const pending = supplies.filter((s) => s.qty > 0).map((s) => ({ ...s, date: later(s.date, today), used: false }));
    const events: Event[] = [
        ...pending.map((supply): Event => ({ date: supply.date, order: 0, supply })),
        ...demands.filter((d) => d.qty > 0).map((demand): Event => ({ date: later(demand.date, today), order: 1, demand })),
    ].sort((a, b) => (a.date === b.date ? a.order - b.order : a.date < b.date ? -1 : 1));

    for (const demand of demands) {
        if (demand.qty > 0 && demand.date < today && demand.kind !== "dependent") {
            out.exceptions.push({ type: "past-due-demand", item: item.id, ref: demand.ref, qty: demand.qty, from: demand.date, message: `${demand.kind} ${demand.ref} was due ${demand.date}; planned as due today.` });
        }
    }

    let balance = round(item.onHand);
    for (const event of events) {
        if (event.supply) {
            const supply = pending.find((s) => s.ref === event.supply?.ref && s.kind === event.supply?.kind && s.date === event.date && !s.used);
            if (!supply) continue; // already pulled in by an earlier shortage
            supply.used = true;
            balance = round(balance + supply.qty);
            timeline.push({ date: event.date, change: supply.qty, balance, what: `${supply.kind} ${supply.ref}` });
            continue;
        }
        const demand = event.demand as Demand;
        balance = round(balance - demand.qty);
        timeline.push({ date: event.date, change: -demand.qty, balance, what: `${demand.kind} ${demand.ref}` });

        // Pull in later scheduled receipts before planning anything new.
        while (balance < safety) {
            const next = pending.find((s) => !s.used && s.date > event.date);
            if (!next) break;
            next.used = true;
            balance = round(balance + next.qty);
            timeline.push({ date: event.date, change: next.qty, balance, what: `${next.kind} ${next.ref} (expedited from ${next.date})` });
            out.exceptions.push({ type: "expedite", item: item.id, ref: next.ref, qty: next.qty, from: next.date, to: event.date, message: `${next.kind} ${next.ref} for ${next.qty} is due ${next.date} but is needed ${event.date} for ${demand.kind} ${demand.ref}.` });
        }
        if (balance < safety) {
            const target = Math.max(safety, item.orderUpTo ?? 0);
            const shortfall = round(safety - balance);
            const qty = lotSize(round(target - balance), item);
            const leadTimeKnown = item.leadTimeDays !== undefined;
            const releaseDate = addDays(event.date, -(item.leadTimeDays ?? 0));
            const order: PlannedOrder = {
                item: item.id,
                action: item.make ? "make" : "buy",
                qty,
                receiptDate: event.date,
                releaseDate,
                pastDue: leadTimeKnown && releaseDate < today,
                leadTimeKnown,
                pegs: [{ ref: demand.ref, kind: demand.kind, qty: Math.min(demand.qty, shortfall), date: event.date }],
            };
            planned.push(order);
            balance = round(balance + qty);
            timeline.push({ date: event.date, change: qty, balance, what: `planned ${order.action}` });
            if (order.pastDue) {
                out.exceptions.push({ type: "past-due-release", item: item.id, ref: demand.ref, qty, from: releaseDate, to: event.date, message: `To have ${qty} by ${event.date} this should have been released ${releaseDate} (lead time ${item.leadTimeDays ?? 0} days).` });
            }
        } else {
            // Covered from stock, a receipt, or an earlier lot's surplus: peg it there if a lot is carrying it.
            const carrier = [...planned].reverse().find((order) => order.pegs.reduce((n, peg) => n + peg.qty, 0) < order.qty);
            if (carrier && timeline.some((row) => row.what.startsWith("planned"))) {
                const room = round(carrier.qty - carrier.pegs.reduce((n, peg) => n + peg.qty, 0));
                const stockBefore = round(balance + demand.qty - room);
                if (stockBefore < safety) carrier.pegs.push({ ref: demand.ref, kind: demand.kind, qty: Math.min(demand.qty, room), date: event.date });
            }
        }
    }

    // A receipt the plan gets through without is reported, latest first, so the message is
    // about the order that can most easily be moved or cancelled.
    for (const supply of [...pending].reverse()) {
        if (supply.dateAssumed) out.exceptions.push({ type: "assumed-date", item: item.id, ref: supply.ref, qty: supply.qty, to: supply.date, message: `${supply.kind} ${supply.ref} has no expected date in EBMS; ${supply.date} was assumed.` });
        let running = round(item.onHand);
        let lowest = running;
        for (const row of timeline.slice(1)) {
            const mine = row.what.startsWith(`${supply.kind} ${supply.ref}`);
            running = round(running + (mine ? 0 : row.change));
            if (row.date >= supply.date || mine) lowest = Math.min(lowest, running);
        }
        const plannedAfter = planned.some((order) => order.receiptDate >= supply.date);
        if (lowest >= safety && !plannedAfter && demands.length + supplies.length > 0) {
            out.exceptions.push({ type: "not-needed", item: item.id, ref: supply.ref, qty: supply.qty, from: supply.date, message: `${supply.kind} ${supply.ref} for ${supply.qty} is not needed by anything in the plan; consider deferring or cancelling it.` });
        }
    }

    out.orders.push(...planned);
    return { item: item.id, level: 0, timeline, endingBalance: balance, planned };
}

/**
 * `through` is the planner's time frame: "buy and make what is needed to cover everything due
 * on or before this date". Demand and supply dated after it are left out of the netting and
 * summarised instead. Past-due demand is always inside the time frame. Minimum levels are
 * held for the whole time frame, not just at its end.
 */
export function runMrp(input: { today: string; through?: string | undefined; items: readonly ItemParams[]; demands: readonly Demand[]; supplies: readonly Supply[] }): Plan {
    const out = { orders: [] as PlannedOrder[], exceptions: [] as PlanException[] };
    const through = input.through ?? null;
    const inside = (date: string): boolean => through === null || date <= through;
    const beyond = new Map<string, BeyondHorizon>();
    const noteBeyond = (item: string): BeyondHorizon => {
        let row = beyond.get(item);
        if (!row) beyond.set(item, (row = { item, demandQty: 0, supplyQty: 0, firstDemandDate: null }));
        return row;
    };
    for (const demand of input.demands) {
        if (inside(demand.date)) continue;
        const row = noteBeyond(demand.item);
        row.demandQty = round(row.demandQty + demand.qty);
        row.firstDemandDate = row.firstDemandDate === null || demand.date < row.firstDemandDate ? demand.date : row.firstDemandDate;
    }
    for (const supply of input.supplies) if (!inside(supply.date)) noteBeyond(supply.item).supplyQty = round(noteBeyond(supply.item).supplyQty + supply.qty);
    const byId = new Map(input.items.map((item) => [item.id, item]));
    const { levels, cycles } = lowLevelCodes(input.items);
    for (const cycle of cycles) out.exceptions.push({ type: "bom-cycle", item: cycle[0] ?? "", ref: cycle.join(" → "), message: `Bill of materials loops: ${cycle.join(" → ")}. The loop was planned once and not followed further.` });

    const demands = new Map<string, Demand[]>();
    const supplies = new Map<string, Supply[]>();
    const push = <T>(map: Map<string, T[]>, key: string, value: T): void => void map.set(key, [...(map.get(key) ?? []), value]);
    for (const demand of input.demands) if (inside(demand.date)) push(demands, demand.item, demand);
    for (const supply of input.supplies) if (inside(supply.date)) push(supplies, supply.item, supply);

    const known = new Set(byId.keys());
    for (const id of new Set([...demands.keys(), ...supplies.keys()])) {
        if (!known.has(id)) out.exceptions.push({ type: "unknown-item", item: id, ref: id, message: `${id} has demand or supply but no planning parameters; it was not planned.` });
    }

    const order = [...byId.values()].sort((a, b) => (levels.get(a.id) ?? 0) - (levels.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    const items: ItemPlan[] = [];
    for (const item of order) {
        const plan = planItem(item, demands.get(item.id) ?? [], supplies.get(item.id) ?? [], input.today, out);
        items.push({ item: plan.item, level: levels.get(item.id) ?? 0, timeline: plan.timeline, endingBalance: plan.endingBalance });
        if (!item.make) continue;
        for (const planned of plan.planned) {
            for (const component of item.components ?? []) {
                if (component.item === item.id) continue;
                if ((levels.get(component.item) ?? 0) <= (levels.get(item.id) ?? 0)) continue; // broken cycle
                push(demands, component.item, { item: component.item, qty: round(planned.qty * component.qtyPer), date: later(planned.releaseDate, input.today), kind: "dependent", ref: `make ${item.id} x${planned.qty} for ${planned.receiptDate}` });
            }
        }
    }
    return { through, plannedOrders: out.orders, exceptions: out.exceptions, items, beyondHorizon: [...beyond.values()].sort((a, b) => a.item.localeCompare(b.item)) };
}
