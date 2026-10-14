import { z } from "zod";
import { createMcpApp, listen } from "@urumi/mcp-http";

const app = createMcpApp({
  name: "utility",
  version: "0.1.0",
  tools: () => [
    {
      name: "get_current_time",
      description: "Return the current time as an ISO timestamp. Pass an IANA timezone, or omit it for UTC.",
      inputSchema: z.object({ timezone: z.string().optional() }),
      handler: async (args) => {
        const timezone = String(args.timezone ?? "UTC");
        let iso: string;
        try {
          iso = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "shortOffset" }).format(new Date());
        } catch {
          return { isError: true, content: [{ type: "text", text: `unknown timezone: ${timezone}` }] };
        }
        const value = { iso: new Date().toISOString(), timezone, local: iso };
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
      },
    },
    {
      name: "echo",
      description: "Return the message unchanged.",
      inputSchema: z.object({ message: z.string() }),
      handler: async (args) => {
        const value = { message: String(args.message) };
        return { content: [{ type: "text", text: value.message }], structuredContent: value };
      },
    },
  ],
});

process.env.OTEL_SERVICE_NAME ??= "utility-mcp";
listen(app);
