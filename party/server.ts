// Time in the Bottle — room relay backend (Stage 2).
//
// History: originally planned on PartyKit's hosted cloud, but its shared domain
// `partykit.dev` hit Cloudflare's hard limit of 10,000 custom domains per zone,
// so new free deploys are blocked (2026-06). PartyKit is itself a thin wrapper
// over Cloudflare Durable Objects, so we run that directly: free, always-on, no
// custom domain needed (uses *.workers.dev). The job is unchanged — relay each
// player's integer `ticks` (their cumulative keystroke count) to the room; it
// never knows the sand grid, colours, or physics. See Doc/backend.md and
// Doc/architecture.md.
//
// Routing: wss://<host>/parties/main/<roomId>?_pk=<connId>
//   · each roomId maps to one Durable Object instance (= one room),
//   · the client supplies its own connection id via ?_pk, so it can recognise
//     and skip its own grains in the broadcast (no server-side help needed).

export interface Env {
  // Binding kept as RACEROOM/RaceRoom to match the already-deployed worker; the
  // name is internal (players use room codes). See wrangler.toml for the why.
  RACEROOM: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/parties\/main\/([^/]+)/);
    if (request.headers.get("Upgrade") === "websocket" && match) {
      const roomId = decodeURIComponent(match[1]);
      const stub = env.RACEROOM.get(env.RACEROOM.idFromName(roomId));
      return stub.fetch(request);
    }
    return new Response("Time in the Bottle room server (Cloudflare Durable Objects)", {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

type PlayerState = { name: string; ticks: number };

// One instance per roomId. Holds the room's players in memory and rebroadcasts
// the full state on every change — same contract as the old PartyKit server.
export class RaceRoom {  // legacy class name, kept to match the live deployment
  players: Record<string, PlayerState> = {};
  conns: Map<WebSocket, string> = new Map(); // socket -> connId

  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const connId = url.searchParams.get("_pk") || crypto.randomUUID();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.conns.set(server, connId);

    // snapshot so the newcomer immediately sees everyone already in the room
    server.send(JSON.stringify({ type: "state", players: this.players }));

    server.addEventListener("message", (e: MessageEvent) => {
      this.onMessage(connId, e.data);
    });
    const drop = () => this.onClose(server, connId);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  onMessage(id: string, raw: unknown) {
    let data: { type?: string; name?: string; ticks?: number };
    try { data = JSON.parse(typeof raw === "string" ? raw : ""); } catch { return; }
    if (data.type === "join") {
      this.players[id] = { name: String(data.name ?? "Player"), ticks: 0 };
    } else if (data.type === "progress" && this.players[id]) {
      this.players[id].ticks = Number(data.ticks) || 0; // trust the client's int
    } else {
      return; // unknown / invalid message → no broadcast
    }
    this.broadcast();
  }

  onClose(ws: WebSocket, id: string) {
    this.conns.delete(ws);
    if (this.players[id]) {
      delete this.players[id];
      this.broadcast();
    }
  }

  broadcast() {
    const msg = JSON.stringify({ type: "state", players: this.players });
    for (const ws of this.conns.keys()) {
      try { ws.send(msg); } catch { /* dead socket; its close handler cleans up */ }
    }
  }
}
