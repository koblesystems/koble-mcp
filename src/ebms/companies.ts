/**
 * Company discovery. A serial number reaches one or more companies, and the company-list
 * endpoint names them without credentials — so users never have to know an internal ID.
 */
import { companyListUrl, normalizeCompany, type CompanyInfo } from "../config.js";

/** Turns the endpoint's rows into CompanyInfo, dropping anything without an Id. */
export function parseCompanyList(payload: unknown): CompanyInfo[] {
    if (!Array.isArray(payload)) return [];
    return payload.flatMap((row) => {
        if (!row || typeof row !== "object") return [];
        const { Id, Name, Version } = row as { Id?: unknown; Name?: unknown; Version?: unknown };
        if (typeof Id !== "string" || Id.trim().length === 0) return [];
        return [{ id: normalizeCompany(Id), name: typeof Name === "string" ? Name.trim() : "", version: typeof Version === "string" ? Version : null }];
    });
}

export async function discoverCompanies(fetchImpl: typeof fetch = fetch): Promise<CompanyInfo[]> {
    const response = await fetchImpl(companyListUrl(), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`company list returned HTTP ${response.status}`);
    const list = parseCompanyList(await response.json());
    if (list.length === 0) throw new Error("company list was empty");
    return list;
}
