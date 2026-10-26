import { handle } from "@/server/api";

// Every /api/* request goes to the game API (src/server/api.ts), which routes it itself.
// Node.js runtime (the default): the API uses node:sqlite and node:crypto.

type Ctx = { params: Promise<{ path: string[] }> };

async function route(req: Request, ctx: Ctx) {
  const { path } = await ctx.params;
  return handle(req, path);
}

export const GET = route;
export const POST = route;
export const PUT = route;
