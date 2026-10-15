import { z } from "zod";
import { createMcpApp, listen } from "@urumi/mcp-http";
import policy from "./policy.json";

const app = createMcpApp({
  name: "policy",
  version: "0.1.0",
  tools: () => [
    {
      name: "get_return_policy",
      annotations: { readOnlyHint: true },
      description: "Return the store return window and conditions.",
      inputSchema: z.object({}),
      handler: async () => {
        const value = { returnWindowDays: policy.returnWindowDays, conditions: policy.conditions };
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      },
    },
    {
      name: "list_shipping_options",
      annotations: { readOnlyHint: true },
      description: "List static shipping options. Pass a country code to include country-specific options.",
      inputSchema: z.object({ country: z.string().optional() }),
      handler: async (args) => {
        const country = String(args.country ?? "").toUpperCase();
        const options = policy.shipping.filter((option) => option.country === "*" || option.country === country);
        const value = { options };
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      },
    },
  ],
});

process.env.OTEL_SERVICE_NAME ??= "policy-mcp";
listen(app);
