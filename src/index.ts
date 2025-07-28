// noinspection SqlNoDataSourceInspection

import { DurableObject, env } from "cloudflare:workers"

export type WSMessageType =
  | { type: "new_message"; name: string; message: string }
  | { type: "user_join"; name: string }
  | { type: "user_leave"; name: string }
  | { type: "user_list"; users: string[] }
  | { type: "authenticate"; token: string }
  | { type: "send_message"; message: string }
  | { type: "message_history" }

export type Session = {
  authenticated: boolean
  name: string
  history_requested: boolean
}

export type TwitchTokenServer = {
  access_token: string
  expires_in: number
  token_type: string
}

export type TwitchToken = {
  access_token: string
  expires_at: number
}

export type TwitchEmote = {
  name: string
  images: {
    url_1x: string | null
    url_2x: string | null
    url_4x: string | null
  }
  animated: boolean
}

export type TwitchEmotes = Array<TwitchEmote>

export type TwitchEmotesServer = {
  data: [
    {
      id: string
      name: string
      format: ["static" | "animated"]
      scale: ["1.0" | "2.0" | "3.0"]
      theme_mode: ["light" | "dark"]
      [key: string]: unknown
    },
  ]
  template: string
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
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("PING", "PONG"))

    this.init_database()
    this.ctx.storage.getAlarm().then((alarm_time) => {
      if (alarm_time === null) {
        this.ctx.storage.setAlarm(Date.now() + 3600 * 1000).catch((e) => console.error(e))
      }
    })
  }

  async fetch(_request: Request): Promise<Response> {
    const webSocketPair = new WebSocketPair()
    const [client, server] = Object.values(webSocketPair)
    this.ctx.acceptWebSocket(server)
    const session: Session = { authenticated: false, name: "", history_requested: false }
    server.serializeAttachment(session)
    this.sessions.set(server, session)

    return new Response(null, {
      status: 101,
      webSocket: client,
    })
  }

  private init_database() {
    const cursor = this.ctx.storage.sql.exec(`PRAGMA table_list`)
    if ([...cursor].find((t) => t.name === "messages")) {
      console.log("Table already exists")
      return
    }

    this.ctx.storage.sql.exec(
      `CREATE TABLE messages ( \
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL
      )`,
    )
    this.ctx.storage.sql.exec(`CREATE INDEX idx_timestamp ON messages (timestamp_ms DESC)`)
  }

  broadcast(message: WSMessageType) {
    this.ctx.getWebSockets().forEach((ws) => {
      ws.send(JSON.stringify(message))
    })
  }

  private get_user_list() {
    return Array.from(this.sessions.values(), (s) => s.name)
      .filter(Boolean)
      .sort()
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

    try {
      JSON.parse(message)
    } catch (e) {
      console.log("ERROR: invalid message: ", e)
      ws.close(1007, "invalid message content")
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
        ws.serializeAttachment(session)
        this.broadcast({ type: "user_join", name: session.name })
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
        this.ctx.storage.sql.exec(
          `INSERT INTO messages (name, message, timestamp_ms)
           VALUES (?, ?, ?)`,
          ...[session.name, msg.message, Date.now()],
        )
        this.broadcast({ type: "new_message", name: session.name, message: msg.message })
        break

      case "message_history": {
        if (session.history_requested) {
          return
        }
        session.history_requested = true
        ws.serializeAttachment(session)
        const messages = this.ctx.storage.sql.exec(
          `SELECT name, message, timestamp_ms
           FROM messages
           ORDER BY timestamp_ms`,
        )
        
        ws.send(JSON.stringify({ type: "message_history", messages: messages.toArray() }))
        break
      }

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

  async twitch_emotes(): Promise<Response> {
    let emote_data = await this.ctx.storage.get<TwitchEmotes>("emote_data")

    if (emote_data === undefined) {
      console.log("No emote data found, fetching from Twitch")
      let twitch_token = await this.ctx.storage.get<TwitchToken>("twitch_token")
      const now = Date.now() / 1000
      if (twitch_token === undefined || twitch_token.expires_at < now) {
        console.log("No valid Twitch token found, authenticating")
        twitch_token = await this.twitch_auth()
      }

      emote_data = await this.twitch_fetch_emotes(twitch_token)
    }
    return new Response(JSON.stringify(emote_data), { headers: { "Content-Type": "application/json" } })
  }

  private async twitch_auth(): Promise<TwitchToken> {
    const response = await fetch("https://id.twitch.tv/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID,
        client_secret: env.TWITCH_CLIENT_SECRET,
        grant_type: "client_credentials",
      }),
    })
    console.log("Authenticated with Twitch")
    const json = await response.json<TwitchTokenServer>()
    const twitch_token = {
      access_token: json.access_token,
      expires_at: Date.now() / 1000 + json.expires_in,
    }
    await this.ctx.storage.put("twitch_token", twitch_token)
    console.log("Stored Twitch token")
    return twitch_token
  }

  private async twitch_fetch_emotes(twitch_token: TwitchToken): Promise<TwitchEmotes> {
    const response = await fetch("https://api.twitch.tv/helix/chat/emotes?broadcaster_id=85498365", {
      headers: {
        "Client-Id": env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${twitch_token.access_token}`,
      },
    })
    console.log("Fetched Twitch emotes")
    const json = await response.json<TwitchEmotesServer>()
    const template = json.template
    const emote_data: TwitchEmotes = []
    for (const data of json.data) {
      const id = data.id
      let format = "static"
      if (data.format.includes("animated")) {
        format = "animated"
      }
      let theme_mode = "light"
      if (!data.theme_mode.includes("light")) {
        theme_mode = "dark"
      }
      const scale = data.scale
      const base_url = template.replace("{{id}}", id).replace("{{format}}", format).replace("{{theme_mode}}", theme_mode)
      const emote: TwitchEmote = {
        name: data.name,
        animated: format === "animated",
        images: {
          url_1x: scale.includes("1.0") ? base_url.replace("{{scale}}", "1.0") : null,
          url_2x: scale.includes("2.0") ? base_url.replace("{{scale}}", "2.0") : null,
          url_4x: scale.includes("3.0") ? base_url.replace("{{scale}}", "3.0") : null,
        },
      }
      emote_data.push(emote)
    }
    await this.ctx.storage.put("emote_data", emote_data)
    console.log("Stored Twitch emotes")
    return emote_data
  }

  alarm(_alarmInfo?: AlarmInvocationInfo): void | Promise<void> {
    this.ctx.storage.sql.exec(
      `DELETE
       FROM messages
       WHERE timestamp_ms < ${Date.now() - 86400 * 1000 * 3}`,
    )
    this.ctx.storage.setAlarm(Date.now() + 3600 * 1000).catch((e) => console.error(e))
  }
}

export default {
  /**
   * This is the standard fetch handler for a Cloudflare Worker
   *
   * @param request - The request submitted to the Worker from the client
   * @param env - The interface to reference bindings declared in wrangler.jsonc
   * @param _ctx - The execution context of the Worker
   * @returns The response to be sent back to the client
   */
  async fetch(request, env, _ctx): Promise<Response> {
    const url = new URL(request.url)
    const id = env.DO.idFromName("chat")
    const stub = env.DO.get(id)

    if (url.pathname === "/auth") {
      return new Response(null, { status: 501 })
    } else if (url.pathname === "/chat") {
      const upgradeHeader = request.headers.get("Upgrade")
      if (!upgradeHeader || upgradeHeader !== "websocket") {
        return new Response("expected Upgrade: websocket", {
          status: 426,
        })
      }
      return stub.fetch(request)
    } else if (url.pathname === "/twitch_emotes") {
      return stub.twitch_emotes()
    }

    return new Response(
      JSON.stringify({
        status: "ok",
      }),
    )
  },
} satisfies ExportedHandler<Env>
