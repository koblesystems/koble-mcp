/**
 * What the planner asked to see. The whole company is always planned, because demand flows
 * between items; the scope only decides what is reported and what goes on the worksheet.
 */
import type { Snapshot } from "./snapshot.js";

export type InScope = (item: string, type: string) => boolean;

export interface Scope {
    inScope: InScope;
    /** How the scope reads in the result. */
    label: unknown;
}

type Ask = { ask: string } & Record<string, unknown>;

/**
 * Products are matched by ID whatever their case; vendors by ID or by name. One that fits nothing,
 * or a vendor name that fits several, is asked about rather than guessed. Needs only the products
 * and vendors, so it runs before the rest of the snapshot is read.
 */
export function resolveScope(
    found: Pick<Snapshot, "products" | "vendors">,
    args: { scope: "everything" | "vendors" | "products"; vendors?: readonly string[] | undefined; items?: readonly string[] | undefined },
): Scope | Ask {
    if (args.scope === "everything") return { inScope: () => true, label: "everything" };
    if (args.scope === "products") {
        const byUpper = new Map([...found.products.keys()].map((id) => [id.toUpperCase(), id]));
        const given = (args.items ?? []).map((id) => id.trim()).filter(Boolean);
        const unknown = given.filter((id) => !byUpper.has(id.toUpperCase()));
        if (unknown.length > 0) {
            const like = [...found.products.keys()].filter((id) => unknown.some((u) => id.toLowerCase().includes(u.toLowerCase()))).slice(0, 20);
            return { ask: `Ask the user to check ${unknown.map((id) => `"${id}"`).join(", ")}: no active product has ${unknown.length === 1 ? "that ID" : "those IDs"}.`, ...(like.length > 0 ? { similarProducts: like } : {}) };
        }
        const wanted = new Set(given.map((id) => byUpper.get(id.toUpperCase()) as string));
        return { inScope: (item) => wanted.has(item), label: { products: [...wanted] } };
    }

    const primary = new Set([...found.products.values()].map((product) => product.vendor.toUpperCase()));
    const known = [...found.vendors].filter(([id]) => primary.has(id)).map(([id, vendor]) => ({ id, name: vendor.name }));
    const chosen = new Map<string, string>();
    const unclear: string[] = [];
    for (const given of (args.vendors ?? []).map((v) => v.trim()).filter(Boolean)) {
        const lower = given.toLowerCase();
        const exact = known.filter((v) => v.id.toLowerCase() === lower || v.name.toLowerCase() === lower);
        const matches = exact.length > 0 ? exact : known.filter((v) => v.id.toLowerCase().includes(lower) || v.name.toLowerCase().includes(lower));
        const [only] = matches;
        if (matches.length === 1 && only) chosen.set(only.id, only.name);
        else unclear.push(matches.length === 0 ? `"${given}" is not the primary vendor of any product` : `"${given}" could be ${matches.map((v) => `${v.id} (${v.name})`).join(", ")}`);
    }
    if (unclear.length > 0) return { ask: `Ask the user which vendor they mean: ${unclear.join("; ")}.`, vendorsWithProducts: known.slice(0, 60) };

    const vendorOf = (item: string): string => (found.products.get(item)?.vendor ?? "").toUpperCase();
    return {
        // A vendor's buyer is not planning production, so batches are left off.
        inScope: (item, type) => type !== "MAKE" && chosen.has(vendorOf(item)),
        label: { vendors: [...chosen].map(([id, name]) => (name ? `${id} (${name})` : id)), note: "The whole company was planned; only these vendors' products are reported. Planned batches elsewhere may be what drives some of these purchases; the Because column says so." },
    };
}
