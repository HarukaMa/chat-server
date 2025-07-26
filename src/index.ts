import { DurableObject } from "cloudflare:workers"

export type WSMessageType =
  | { type: "new_message"; message: string }
  | { type: "user_join"; name: string }
  | { type: "user_leave"; name: string }
  | { type: "user_list"; users: string[] }
  | { type: "authenticate"; token: string }
  | { type: "send_message"; message: string }

export type Session = {
  authenticated: boolean
  name: string
}

/**
 * Welcome to Cloudflare Workers! This is your first Durable Objects application.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your Durable Object in action
 * - Run `npm run deploy` to publish your application
 *
 * Bind resources to your worker in `wrangler.jsonc`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/durable-objects
 */

/** A Durable Object's behavior is defined in an exported Javascript class */
export class DO extends DurableObject<Env> {
  sessions: Map<WebSocket, Session>

  /**
   * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
   *    `DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
   *
   * @param ctx - The interface for interacting with Durable Object state
   * @param env - The interface to reference bindings declared in wrangler.jsonc
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sessions = new Map()
    this.ctx.getWebSockets().forEach((ws) => {
      const session = ws.deserializeAttachment()
      this.sessions.set(ws, session)
    })
  }

  async fetch(request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair()
    const [client, server] = Object.values(webSocketPair)
    this.ctx.acceptWebSocket(server)
    const session: Session = { authenticated: false, name: "" }
    server.serializeAttachment(session)
    this.sessions.set(server, session)

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  broadcast(message: WSMessageType) {
    this.ctx.getWebSockets().forEach((ws) => {
      ws.send(JSON.stringify(message))
    })
  }

  get_user_list() {
    return Array.from(this.sessions.values(), (s) => s.name).filter(Boolean)
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (message instanceof ArrayBuffer) {
      ws.close(1003, "unsupported message type")
      return
    }

    const session = this.sessions.get(ws)
    if (session === undefined) {
      ws.close(1011, "invalid internal state")
      console.log("ERROR: session not found for existing connection")
      return
    }

    const msg = JSON.parse(message) as WSMessageType
    switch (msg.type) {
      case "new_message":
      case "user_join":
      case "user_leave":
        ws.close(1007, "invalid message type")
        return
      case "user_list":
        ws.send(JSON.stringify({ type: "user_list", users: this.get_user_list() }))
        break
      case "authenticate":
        if (!("token" in msg)) {
          ws.close(1007, "invalid message content")
          return
        }
        session.authenticated = true
        session.name = msg.token
        break
      case "send_message":
        if (!session.authenticated) {
          ws.close(1007, "unauthenticated")
          return
        }
        if (!("message" in msg)) {
          ws.close(1007, "invalid message content")
          return
        }
        this.broadcast({ type: "new_message", message: msg.message })
        break
      default:
        ws.close(1007, "invalid message type")
        return
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const session = this.sessions.get(ws)
    if (session) {
      if (session.authenticated) {
        this.broadcast({ type: "user_leave", name: session.name })
      }
      this.sessions.delete(ws)
    }
    ws.close(code, "closed")
    console.log("WebSocket closed", code, reason, wasClean)
  }

  async webSocketError(ws: WebSocket, error: Error) {
    console.log("WebSocket error", error)
    ws.close(1006, "error")
  }
}

export default {
  /**
   * This is the standard fetch handler for a Cloudflare Worker
   *
   * @param request - The request submitted to the Worker from the client
   * @param env - The interface to reference bindings declared in wrangler.jsonc
   * @param ctx - The execution context of the Worker
   * @returns The response to be sent back to the client
   */
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/auth") {
      return new Response(null, { status: 501 })
    } else if (url.pathname === "/chat") {
      const upgradeHeader = request.headers.get("Upgrade")
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("expected Upgrade: websocket", {
          status: 426,
        })
      }
      const id = env.DO.idFromName("chat")
      const stub = env.DO.get(id)
      return stub.fetch(request)
    }

    return new Response(
      JSON.stringify({
        status: "ok",
      }),
    )
  },
} satisfies ExportedHandler<Env>
