/**
 * What the planner asked to see. The whole company is always planned, because demand flows
 * between items; the scope only decides what is reported and what goes on the worksheet.
 */
import { readByIds, type Snapshot } from "./snapshot.js";

export type InScope = (item: string, type: string) => boolean;

export interface Scope {
    inScope: InScope;
    /** How the scope reads in the result. */
    label: unknown;
}

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** Vendors may be given by ID or by name; one that fits no vendor, or several, is asked about rather than guessed. */
export async function resolveScope(
    company: string,
    snapshot: Snapshot,
    args: { scope: "everything" | "vendors" | "products"; vendors?: readonly string[] | undefined; items?: readonly string[] | undefined },
): Promise<Scope | { ask: string; vendorsWithProducts: Array<{ id: string; name: string }> }> {
    if (args.scope === "everything") return { inScope: () => true, label: "everything" };
    if (args.scope === "products") {
        const wanted = new Set((args.items ?? []).map((id) => id.trim()));
        return { inScope: (item) => wanted.has(item), label: { products: [...wanted] } };
    }

    const primary = [...snapshot.products.values()].map((product) => product.vendor.toUpperCase());
    const known = (await readByIds(company, "APVENDOR", "ID", primary, "ID,F_NAME,L_NAME")).map((row) => ({
        id: text(row["ID"]).toUpperCase(),
        name: `${text(row["F_NAME"])} ${text(row["L_NAME"])}`.trim(),
    }));
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

    const vendorOf = (item: string): string => (snapshot.products.get(item)?.vendor ?? "").toUpperCase();
    return {
        // A vendor's buyer is not planning production, so batches are left off.
        inScope: (item, type) => type !== "MAKE" && chosen.has(vendorOf(item)),
        label: { vendors: [...chosen].map(([id, name]) => (name ? `${id} (${name})` : id)), note: "The whole company was planned; only these vendors' products are reported. Planned batches elsewhere may be what drives some of these purchases; the Because column says so." },
    };
}
