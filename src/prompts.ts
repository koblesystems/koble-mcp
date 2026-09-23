/**
 * Named entry points the host can list for the user — `/` in Claude Code, the prompt menu in
 * Claude Desktop. Each one only starts a conversation: it names the skill to follow and passes on
 * whatever the user filled in. Anything left blank, the skill asks for; nothing here writes.
 */
import { z } from "zod/v4";

export interface PromptSpec {
    name: string;
    title: string;
    description: string;
    args: Record<string, string>;
    skill: string;
    /** The request, in the user's words, built from the arguments that were filled in. */
    ask: (args: Record<string, string | undefined>) => string;
}

const given = (label: string, value: string | undefined): string => (value?.trim() ? ` ${label} ${value.trim()}.` : "");

export const PROMPTS: PromptSpec[] = [
    {
        name: "mrp-plan",
        title: "MRP: what to buy and make",
        description: "Plan purchasing and production for a time frame, and get a worksheet to approve.",
        args: { days: "How far ahead, in days (or a date).", scope: "Everything, or which vendors or products.", company: "Company ID or name." },
        skill: "ebms-mrp",
        ask: (a) => `Run MRP.${given("Time frame:", a["days"])}${given("Scope:", a["scope"])}${given("Company:", a["company"])}`,
    },
    {
        name: "mrp-purchase-orders",
        title: "MRP: create the approved purchase orders",
        description: "Turn the BUY rows approved on an MRP worksheet into purchase orders, one confirmed at a time.",
        args: { worksheet: "The worksheet file path, if it is not attached." },
        skill: "ebms-mrp-purchase-orders",
        ask: (a) => `Create the purchase orders I approved on the MRP worksheet.${given("Worksheet:", a["worksheet"])}`,
    },
    {
        name: "mrp-batches",
        title: "MRP: create the approved batches",
        description: "Turn the MAKE rows approved on an MRP worksheet into manufacturing batches.",
        args: { worksheet: "The worksheet file path, if it is not attached." },
        skill: "ebms-mrp-batches",
        ask: (a) => `Create the manufacturing batches I approved on the MRP worksheet.${given("Worksheet:", a["worksheet"])}`,
    },
    {
        name: "sales-order",
        title: "Sales order: new or change",
        description: "Enter a new sales order, or change or ship an existing one.",
        args: { customer: "Customer ID or name.", order: "An existing order number, to change or ship it." },
        skill: "ebms-sales-orders",
        ask: (a) => (a["order"]?.trim() ? `I want to work on sales order ${a["order"].trim()}.` : `I want to enter a sales order.${given("Customer:", a["customer"])}`),
    },
    {
        name: "purchase-order",
        title: "Purchase order: new or change",
        description: "Raise a purchase order for a vendor, or change an existing one.",
        args: { vendor: "Vendor ID or name.", po: "An existing PO number, to change it." },
        skill: "ebms-purchase-orders",
        ask: (a) => (a["po"]?.trim() ? `I want to change purchase order ${a["po"].trim()}.` : `I want to raise a purchase order.${given("Vendor:", a["vendor"])}`),
    },
    {
        name: "receive",
        title: "Receive a purchase order",
        description: "Record what arrived against a purchase order.",
        args: { po: "The PO number." },
        skill: "ebms-purchase-orders",
        ask: (a) => `I want to record a delivery.${given("Purchase order:", a["po"])} Use the receiving workflow.`,
    },
    {
        name: "on-order",
        title: "What's on order",
        description: "Show open purchase orders, for everything or one vendor.",
        args: { vendor: "Vendor ID or name, or leave blank for all." },
        skill: "ebms-purchase-orders",
        ask: (a) => `What is on order?${given("Vendor:", a["vendor"])} Read only; don't change anything.`,
    },
    {
        name: "product",
        title: "Product: new or change",
        description: "Create a product, or change one's price, cost, units or vendor records.",
        args: { product: "The product ID, to change an existing one." },
        skill: "ebms-products",
        ask: (a) => (a["product"]?.trim() ? `I want to change product ${a["product"].trim()}.` : "I want to set up a new product."),
    },
    {
        name: "task",
        title: "Task: new or update",
        description: "Raise a task or work order, assign it, move it along, book time or close it.",
        args: { task: "An existing task ID, to update it.", what: "What the task is for." },
        skill: "ebms-tasks",
        ask: (a) => (a["task"]?.trim() ? `I want to update task ${a["task"].trim()}.` : `I want to create a task.${given("It is for:", a["what"])}`),
    },
];

export function promptText(spec: PromptSpec, args: Record<string, string | undefined>): string {
    return [
        spec.ask(args),
        "",
        `Follow the ${spec.skill} skill. If it is not loaded in this app, call the ebms_guide tool with skill "${spec.skill}" first.`,
        "Ask me for anything it needs that I have not given, and confirm before any write.",
    ].join("\n");
}

type PromptRegistrar = (
    name: string,
    config: { title: string; description: string; argsSchema: z.ZodObject },
    callback: (args: Record<string, string | undefined>) => { messages: Array<{ role: "user"; content: { type: "text"; text: string } }> },
) => void;

export function registerPrompts(register: PromptRegistrar): void {
    for (const spec of PROMPTS) {
        const shape = Object.fromEntries(Object.entries(spec.args).map(([key, description]) => [key, z.string().optional().describe(description)]));
        register(spec.name, { title: spec.title, description: spec.description, argsSchema: z.object(shape) }, (args) => ({
            messages: [{ role: "user", content: { type: "text", text: promptText(spec, args) } }],
        }));
    }
}
