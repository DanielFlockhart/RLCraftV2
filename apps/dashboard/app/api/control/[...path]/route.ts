import { NextRequest } from "next/server";
import { dashboardControlConnection } from "../../../../lib/control";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function proxy(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const route = path.join("/");
  const valid =
    req.method === "GET"
      ? /^(datasets(?:\/[a-f0-9-]+\/(?:examples|artifacts\/(?:(?:train|validation|test|ood_test)\.(?:csv|jsonl)|metadata\.json)))?|snapshot|progress|backends|clients|worlds|inputs(?:\/catalog\.json)?|agent-presets|arena-presets|models|models\/stage\/(movement|wood_collection|block_collection|survival|pvp)|models\/run\/[a-f0-9-]+|runs\/[a-f0-9-]+(?:\/agents\/rl_[a-f0-9]{6}_\d{1,3}\/(inputs|feed)|\/artifacts\/(config\.json|metrics\.jsonl|episodes\.jsonl|checkpoint\.json|controls\.jsonl|models\.json|inputs\.jsonl))?)$/.test(
          route,
        )
      : /^(datasets|datasets\/[a-f0-9-]+\/(rerun|cancel)|archive\/sync|clients\/prepare|inputs\/prepare|runs|runs\/[a-f0-9-]+\/(pause|resume|cancel|rerun|playback|watch|agents\/rl_[a-f0-9]{6}_\d{1,3}\/capture)|(?:agent|arena)-presets|(?:agent|arena)-presets\/[a-f0-9-]+(?:\/delete)?|worlds|worlds\/[a-f0-9-]+\/(activate|reset)|server\/(start|stop|command|prepare))$/.test(
          route,
        );
  if (!valid)
    return Response.json({ error: "Unknown control route" }, { status: 404 });
  if (req.method === "POST") {
    const origin = req.headers.get("origin");
    let sameOrigin = false;
    try {
      sameOrigin = !!origin && new URL(origin).host === req.headers.get("host");
    } catch {}
    if (!sameOrigin)
      return Response.json(
        { error: "Cross-origin control requests are blocked" },
        { status: 403 },
      );
  }
  try {
    const { origin, token } = dashboardControlConnection();
    const exampleQuery = new URLSearchParams();
    if (/^datasets\/[a-f0-9-]+\/examples$/.test(route)) {
      for (const key of ["split", "offset", "limit"]) {
        const value = req.nextUrl.searchParams.get(key);
        if (value !== null) exampleQuery.set(key, value);
      }
    }
    const query = exampleQuery.size
      ? `?${exampleQuery}`
      : route === "progress" && req.nextUrl.searchParams.has("runId")
        ? `?${new URLSearchParams({ runId: req.nextUrl.searchParams.get("runId")! })}`
        : route.startsWith("models/stage/") &&
            req.nextUrl.searchParams.get("fresh") === "1"
          ? "?fresh=1"
          : "";
    const res = await fetch(`${origin}/${route}${query}`, {
      method: req.method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: req.method === "POST" ? await req.text() : undefined,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    const headers = new Headers({
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    });
    const disposition = res.headers.get("content-disposition");
    if (disposition) headers.set("content-disposition", disposition);
    return new Response(res.body, { status: res.status, headers });
  } catch {
    return Response.json(
      {
        error:
          "Control service unavailable. Check its status, CONTROL_URL and control credentials.",
      },
      { status: 503 },
    );
  }
}
export const GET = proxy;
export const POST = proxy;
