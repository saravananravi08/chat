import { extractCard, ValidationError } from "@chat-adapter/shared";
import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  Author,
  ChatInstance,
  EmojiValue,
  FetchOptions,
  FetchResult,
  FormattedContent,
  Logger,
  RawMessage,
  ReactionEvent,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
  WebhookOptions,
} from "chat";
import {
  ConsoleLogger,
  convertEmojiPlaceholders,
  defaultEmojiResolver,
  getEmoji,
  Message,
} from "chat";
import makeWASocket, {
  downloadMediaMessage,
  getContentType,
  isJidGroup,
  jidNormalizedUser,
  areJidsSameUser,
  type WAMessage,
  type WASocket,
  type AuthenticationState,
  type BaileysEventMap,
  proto,
} from "baileys";
import { cardToWhatsApp, decodeWhatsAppCallbackData } from "./cards";
import { WhatsAppFormatConverter } from "./markdown";
import type {
  WhatsAppAdapterConfig,
  WhatsAppRawMessage,
  WhatsAppThreadId,
} from "./types";

/** Maximum message length for WhatsApp */
const WHATSAPP_MESSAGE_LIMIT = 4096;

/**
 * Split text into chunks that fit within WhatsApp's message limit,
 * breaking on paragraph boundaries (\n\n) when possible, then line
 * boundaries (\n), and finally at the character limit as a last resort.
 */
export function splitMessage(text: string): string[] {
  if (text.length <= WHATSAPP_MESSAGE_LIMIT) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > WHATSAPP_MESSAGE_LIMIT) {
    const slice = remaining.slice(0, WHATSAPP_MESSAGE_LIMIT);

    // Try to break at a paragraph boundary
    let breakIndex = slice.lastIndexOf("\n\n");
    if (breakIndex === -1 || breakIndex < WHATSAPP_MESSAGE_LIMIT / 2) {
      // Try a line boundary
      breakIndex = slice.lastIndexOf("\n");
    }
    if (breakIndex === -1 || breakIndex < WHATSAPP_MESSAGE_LIMIT / 2) {
      // Hard break at the limit
      breakIndex = WHATSAPP_MESSAGE_LIMIT;
    }

    chunks.push(remaining.slice(0, breakIndex).trimEnd());
    remaining = remaining.slice(breakIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// Re-export types
export type {
  WhatsAppAdapterConfig,
  WhatsAppRawMessage,
  WhatsAppThreadId,
} from "./types";

/**
 * WhatsApp adapter for Chat SDK, powered by Baileys.
 *
 * Connects to WhatsApp via WebSocket (WhatsApp Web protocol) using Baileys.
 * Supports both 1:1 DMs and group chats.
 *
 * **Important:** This uses an unofficial API. WhatsApp may ban accounts
 * that violate their Terms of Service. Use responsibly.
 *
 * @example
 * ```typescript
 * import { Chat } from "chat";
 * import { createWhatsAppAdapter } from "@chat-adapter/whatsapp";
 * import { useMultiFileAuthState } from "baileys";
 * import { MemoryState } from "@chat-adapter/state-memory";
 *
 * const { state, saveCreds } = await useMultiFileAuthState("auth_store");
 *
 * const chat = new Chat({
 *   userName: "my-bot",
 *   adapters: {
 *     whatsapp: createWhatsAppAdapter({
 *       auth: state,
 *       onCredsUpdate: saveCreds,
 *     }),
 *   },
 *   state: new MemoryState(),
 * });
 * ```
 */
export class WhatsAppAdapter
  implements Adapter<WhatsAppThreadId, WhatsAppRawMessage>
{
  readonly name = "whatsapp";
  readonly persistMessageHistory = true;
  readonly userName: string;

  private chat: ChatInstance | null = null;
  private sock: WASocket | null = null;
  private readonly auth: AuthenticationState;
  private readonly logger: Logger;
  private readonly formatConverter = new WhatsAppFormatConverter();
  private _botUserId: string | null = null;
  private readonly printQRInTerminal: boolean;
  private readonly countryCode: string;
  private readonly onCredsUpdate?: () => Promise<void>;
  private readonly socketOptions?: Record<string, unknown>;

  /** Bot user ID (own JID) used for self-message detection */
  get botUserId(): string | undefined {
    return this._botUserId ?? undefined;
  }

  constructor(config: WhatsAppAdapterConfig) {
    this.auth = config.auth;
    this.logger = config.logger;
    this.userName = config.userName;
    this.printQRInTerminal = config.printQRInTerminal ?? true;
    this.countryCode = config.countryCode ?? "1";
    this.onCredsUpdate = config.onCredsUpdate;
    this.socketOptions = config.socketOptions;
  }

  /**
   * Initialize the adapter: create Baileys socket and register event listeners.
   */
  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;

    this.sock = makeWASocket({
      auth: this.auth,
      printQRInTerminal: this.printQRInTerminal,
      countryCode: this.countryCode,
      ...this.socketOptions,
    });

    this.registerEventListeners();

    this.logger.info("WhatsApp Baileys adapter initialized");
  }

  /**
   * Register Baileys event listeners to bridge events to Chat SDK.
   */
  private registerEventListeners(): void {
    if (!this.sock) return;

    const sock = this.sock;

    // Connection state changes
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        // Extract our own JID once connected
        this._botUserId = sock.user
          ? jidNormalizedUser(sock.user.id)
          : null;
        this.logger.info("WhatsApp connected", {
          botUserId: this._botUserId,
        });
      }

      if (connection === "close") {
        const statusCode =
          (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== 401;
        this.logger.warn("WhatsApp connection closed", {
          statusCode,
          shouldReconnect,
        });

        if (shouldReconnect) {
          // Reconnect by re-creating socket
          this.sock = makeWASocket({
            auth: this.auth,
            printQRInTerminal: this.printQRInTerminal,
            countryCode: this.countryCode,
            ...this.socketOptions,
          });
          this.registerEventListeners();
        }
      }
    });

    // Persist credentials on update
    sock.ev.on("creds.update", async () => {
      if (this.onCredsUpdate) {
        await this.onCredsUpdate();
      }
    });

    // Incoming messages
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        try {
          this.handleInboundMessage(msg);
        } catch (error) {
          this.logger.error("Failed to handle inbound message", {
            messageId: msg.key.id,
            error,
          });
        }
      }
    });

    // Reactions
    sock.ev.on(
      "messages.reaction",
      (reactions: BaileysEventMap["messages.reaction"]) => {
        for (const { key, reaction } of reactions) {
          try {
            this.handleReaction(key, reaction);
          } catch (error) {
            this.logger.error("Failed to handle reaction", {
              messageId: key.id,
              error,
            });
          }
        }
      }
    );
  }

  /**
   * Handle incoming webhook requests.
   *
   * Baileys uses WebSocket, not HTTP webhooks. Returns 501 Not Implemented.
   * Events are received via the WebSocket connection in registerEventListeners().
   */
  async handleWebhook(
    _request: Request,
    _options?: WebhookOptions
  ): Promise<Response> {
    return new Response(
      "Not applicable — Baileys uses WebSocket, not HTTP webhooks",
      { status: 501 }
    );
  }

  /**
   * Handle an inbound message from Baileys.
   */
  private handleInboundMessage(waMsg: WAMessage): void {
    if (!this.chat) return;

    const jid = waMsg.key.remoteJid;
    if (!jid) return;

    // Skip our own messages
    if (waMsg.key.fromMe) return;

    // Skip status broadcasts
    if (jid === "status@broadcast") return;

    // Extract text content
    const text = this.extractTextContent(waMsg);
    if (text === null) {
      this.logger.debug("Unsupported message type, ignoring", {
        messageId: waMsg.key.id,
      });
      return;
    }

    const threadId = this.encodeThreadId({ jid: jidNormalizedUser(jid) });
    const message = this.buildMessage(waMsg, threadId, text);
    this.chat.processMessage(this, threadId, message);
  }

  /**
   * Handle reaction events from Baileys.
   */
  private handleReaction(
    key: proto.IMessageKey,
    reaction: proto.IReaction
  ): void {
    if (!this.chat) return;

    const jid = key.remoteJid;
    if (!jid) return;

    const threadId = this.encodeThreadId({ jid: jidNormalizedUser(jid) });
    const rawEmoji = reaction.text ?? "";
    const added = rawEmoji !== "";
    const emojiValue = added ? getEmoji(rawEmoji) : getEmoji("");

    const senderJid = reaction.key?.participant || reaction.key?.remoteJid || jid;
    const user: Author = {
      userId: jidNormalizedUser(senderJid),
      userName: jidNormalizedUser(senderJid),
      fullName: jidNormalizedUser(senderJid),
      isBot: false,
      isMe: areJidsSameUser(senderJid, this._botUserId ?? undefined),
    };

    const event: Omit<ReactionEvent, "adapter" | "thread"> = {
      emoji: emojiValue,
      rawEmoji,
      added,
      user,
      messageId: key.id ?? "",
      threadId,
      raw: { message: { key } as WAMessage },
    };

    this.chat.processReaction({ ...event, adapter: this });
  }

  /**
   * Extract text content from a Baileys WAMessage.
   * Returns null for unsupported message types.
   */
  private extractTextContent(waMsg: WAMessage): string | null {
    const msg = waMsg.message;
    if (!msg) return null;

    // Handle ephemeral/viewOnce wrappers
    const inner =
      msg.ephemeralMessage?.message ||
      msg.viewOnceMessage?.message ||
      msg.viewOnceMessageV2?.message ||
      msg;

    const contentType = getContentType(inner);
    if (!contentType) return null;

    switch (contentType) {
      case "conversation":
        return inner.conversation ?? null;
      case "extendedTextMessage":
        return inner.extendedTextMessage?.text ?? null;
      case "imageMessage":
        return inner.imageMessage?.caption ?? "[Image]";
      case "videoMessage":
        return inner.videoMessage?.caption ?? "[Video]";
      case "audioMessage":
        return inner.audioMessage?.ptt ? "[Voice message]" : "[Audio message]";
      case "documentMessage":
        return (
          inner.documentMessage?.caption ??
          `[Document: ${inner.documentMessage?.fileName ?? "file"}]`
        );
      case "stickerMessage":
        return "[Sticker]";
      case "locationMessage": {
        const loc = inner.locationMessage;
        if (loc) {
          const lat = loc.degreesLatitude;
          const lng = loc.degreesLongitude;
          const parts = [
            `[Location: ${loc.name || `${lat}, ${lng}`}`,
          ];
          if (loc.address) {
            parts.push(loc.address);
          }
          return `${parts.join(" - ")}]`;
        }
        return "[Location]";
      }
      case "contactMessage":
        return `[Contact: ${inner.contactMessage?.displayName ?? "Unknown"}]`;
      case "pollCreationMessage":
      case "pollCreationMessageV3":
        return `[Poll: ${inner.pollCreationMessage?.name ?? ""}]`;
      default:
        return null;
    }
  }

  /**
   * Build a Message from a Baileys WAMessage.
   */
  private buildMessage(
    waMsg: WAMessage,
    threadId: string,
    text: string
  ): Message<WhatsAppRawMessage> {
    const senderJid = waMsg.key.participant || waMsg.key.remoteJid || "";
    const pushName = waMsg.pushName || jidNormalizedUser(senderJid);

    const author: Author = {
      userId: jidNormalizedUser(senderJid),
      userName: pushName,
      fullName: pushName,
      isBot: false,
      isMe: waMsg.key.fromMe ?? false,
    };

    const formatted: FormattedContent = this.formatConverter.toAst(text);

    const raw: WhatsAppRawMessage = {
      message: waMsg,
      pushName: waMsg.pushName ?? undefined,
    };

    const attachments = this.buildAttachments(waMsg);

    const timestamp = waMsg.messageTimestamp
      ? typeof waMsg.messageTimestamp === "number"
        ? waMsg.messageTimestamp
        : Number(waMsg.messageTimestamp)
      : Math.floor(Date.now() / 1000);

    return new Message<WhatsAppRawMessage>({
      id: waMsg.key.id ?? "",
      threadId,
      text,
      formatted,
      raw,
      author,
      metadata: {
        dateSent: new Date(timestamp * 1000),
        edited: false,
      },
      attachments,
    });
  }

  /**
   * Build attachments from a Baileys WAMessage.
   */
  private buildAttachments(waMsg: WAMessage): Attachment[] {
    const attachments: Attachment[] = [];
    const msg = waMsg.message;
    if (!msg) return attachments;

    const inner =
      msg.ephemeralMessage?.message ||
      msg.viewOnceMessage?.message ||
      msg.viewOnceMessageV2?.message ||
      msg;

    if (inner.imageMessage) {
      attachments.push({
        type: "image",
        mimeType: inner.imageMessage.mimetype ?? "image/jpeg",
        fetchData: () => this.downloadMedia(waMsg),
      });
    }

    if (inner.documentMessage) {
      attachments.push({
        type: "file",
        mimeType: inner.documentMessage.mimetype ?? "application/octet-stream",
        name: inner.documentMessage.fileName ?? undefined,
        fetchData: () => this.downloadMedia(waMsg),
      });
    }

    if (inner.audioMessage) {
      attachments.push({
        type: "audio",
        mimeType: inner.audioMessage.mimetype ?? "audio/ogg",
        name: inner.audioMessage.ptt ? "voice" : undefined,
        fetchData: () => this.downloadMedia(waMsg),
      });
    }

    if (inner.videoMessage) {
      attachments.push({
        type: "video",
        mimeType: inner.videoMessage.mimetype ?? "video/mp4",
        fetchData: () => this.downloadMedia(waMsg),
      });
    }

    if (inner.stickerMessage) {
      attachments.push({
        type: "image",
        mimeType: inner.stickerMessage.mimetype ?? "image/webp",
        name: "sticker",
        fetchData: () => this.downloadMedia(waMsg),
      });
    }

    if (inner.locationMessage) {
      const loc = inner.locationMessage;
      const lat = Number(loc.degreesLatitude);
      const lng = Number(loc.degreesLongitude);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        const mapUrl = `https://www.google.com/maps?q=${lat},${lng}`;
        attachments.push({
          type: "file",
          name: loc.name || "Location",
          url: mapUrl,
          mimeType: "application/geo+json",
        });
      }
    }

    return attachments;
  }

  /**
   * Download media from a Baileys WAMessage.
   */
  async downloadMedia(waMsg: WAMessage): Promise<Buffer> {
    const buffer = await downloadMediaMessage(waMsg, "buffer", {});
    return Buffer.from(buffer as Buffer);
  }

  /**
   * Send a message to a WhatsApp chat via Baileys.
   */
  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WhatsAppRawMessage>> {
    if (!this.sock) {
      throw new Error("WhatsApp adapter not initialized — socket is null");
    }

    const { jid } = this.decodeThreadId(threadId);

    // Check if this is a card with interactive buttons
    const card = extractCard(message);
    if (card) {
      const result = cardToWhatsApp(card);
      if (result.type === "interactive") {
        // Baileys doesn't have a native interactive message type,
        // so we send the body text with buttons as a text fallback
        const bodyText = result.interactive.body.text;
        const action = result.interactive.action;
        const buttons = "buttons" in action && action.buttons
          ? action.buttons
          : [];
        const buttonText = buttons
          .map((b: { reply: { title: string } }, i: number) => `${i + 1}. ${b.reply.title}`)
          .join("\n");
        const fullText = `${bodyText}\n\n${buttonText}`;
        return this.sendTextMessage(threadId, jid, convertEmojiPlaceholders(fullText, "whatsapp"));
      }
      return this.sendTextMessage(
        threadId,
        jid,
        convertEmojiPlaceholders(result.text, "whatsapp")
      );
    }

    // Regular text message
    const body = convertEmojiPlaceholders(
      this.formatConverter.renderPostable(message),
      "whatsapp"
    );
    return this.sendTextMessage(threadId, jid, body);
  }

  /**
   * Split text into chunks that fit within WhatsApp's message limit.
   */
  splitMessage(text: string): string[] {
    return splitMessage(text);
  }

  /**
   * Send a single text message via Baileys.
   */
  private async sendSingleTextMessage(
    threadId: string,
    jid: string,
    text: string
  ): Promise<RawMessage<WhatsAppRawMessage>> {
    if (!this.sock) {
      throw new Error("WhatsApp adapter not initialized — socket is null");
    }

    const sentMsg = await this.sock.sendMessage(jid, { text });
    if (!sentMsg?.key.id) {
      throw new Error("Baileys did not return a message ID for text message");
    }

    return {
      id: sentMsg.key.id,
      threadId,
      raw: {
        message: sentMsg,
      },
    };
  }

  /**
   * Send a text message, splitting into multiple messages if it exceeds
   * WhatsApp's 4096-character limit. Returns the last message sent.
   */
  private async sendTextMessage(
    threadId: string,
    jid: string,
    text: string
  ): Promise<RawMessage<WhatsAppRawMessage>> {
    const chunks = this.splitMessage(text);
    let result: RawMessage<WhatsAppRawMessage> | undefined;

    for (const chunk of chunks) {
      result = await this.sendSingleTextMessage(threadId, jid, chunk);
    }

    return result as RawMessage<WhatsAppRawMessage>;
  }

  /**
   * Edit a message via Baileys protocol message editing.
   */
  async editMessage(
    threadId: string,
    messageId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WhatsAppRawMessage>> {
    if (!this.sock) {
      throw new Error("WhatsApp adapter not initialized — socket is null");
    }

    const { jid } = this.decodeThreadId(threadId);
    const text = this.formatConverter.renderPostable(message);

    const sentMsg = await this.sock.sendMessage(jid, {
      text,
      edit: {
        remoteJid: jid,
        id: messageId,
        fromMe: true,
      },
    } as any);

    return {
      id: sentMsg?.key.id ?? messageId,
      threadId,
      raw: {
        message: sentMsg as WAMessage,
      },
    };
  }

  /**
   * Stream a message by buffering all chunks and sending as a single message.
   * Baileys can't do incremental message editing reliably for streaming.
   */
  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions
  ): Promise<RawMessage<WhatsAppRawMessage>> {
    let accumulated = "";
    for await (const chunk of textStream) {
      if (typeof chunk === "string") {
        accumulated += chunk;
      } else if (chunk.type === "markdown_text") {
        accumulated += chunk.text;
      }
    }
    return this.postMessage(threadId, { markdown: accumulated });
  }

  /**
   * Delete a message via Baileys.
   */
  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp adapter not initialized — socket is null");
    }

    const { jid } = this.decodeThreadId(threadId);

    await this.sock.sendMessage(jid, {
      delete: {
        remoteJid: jid,
        id: messageId,
        fromMe: true,
      },
    });
  }

  /**
   * Add a reaction to a message via Baileys.
   */
  async addReaction(
    threadId: string,
    messageId: string,
    emoji: EmojiValue | string
  ): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp adapter not initialized — socket is null");
    }

    const { jid } = this.decodeThreadId(threadId);
    const emojiStr = this.resolveEmoji(emoji);

    await this.sock.sendMessage(jid, {
      react: {
        text: emojiStr,
        key: {
          remoteJid: jid,
          id: messageId,
          fromMe: false,
        },
      },
    });
  }

  /**
   * Remove a reaction from a message via Baileys.
   */
  async removeReaction(
    threadId: string,
    messageId: string,
    _emoji: EmojiValue | string
  ): Promise<void> {
    if (!this.sock) {
      throw new Error("WhatsApp adapter not initialized — socket is null");
    }

    const { jid } = this.decodeThreadId(threadId);

    // Baileys removes reactions by sending empty text
    await this.sock.sendMessage(jid, {
      react: {
        text: "",
        key: {
          remoteJid: jid,
          id: messageId,
          fromMe: false,
        },
      },
    });
  }

  /**
   * Start typing indicator via Baileys presence update.
   */
  async startTyping(threadId: string, _status?: string): Promise<void> {
    if (!this.sock) return;

    const { jid } = this.decodeThreadId(threadId);
    await this.sock.presenceSubscribe(jid);
    await this.sock.sendPresenceUpdate("composing", jid);
  }

  /**
   * Fetch messages. Not supported — WhatsApp doesn't expose server-side history.
   * Message history is persisted by the Chat SDK state adapter.
   */
  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions
  ): Promise<FetchResult<WhatsAppRawMessage>> {
    this.logger.debug(
      "fetchMessages not supported on WhatsApp — message history is not available"
    );
    return { messages: [] };
  }

  /**
   * Fetch thread info.
   */
  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { jid } = this.decodeThreadId(threadId);
    const isGroup = isJidGroup(jid) ?? false;

    return {
      id: threadId,
      channelId: `whatsapp:${jid}`,
      channelName: `WhatsApp: ${jid}`,
      isDM: !isGroup,
      metadata: { jid },
    };
  }

  /**
   * Encode a WhatsApp thread ID.
   *
   * Format: whatsapp:{jid}
   */
  encodeThreadId(platformData: WhatsAppThreadId): string {
    return `whatsapp:${platformData.jid}`;
  }

  /**
   * Decode a WhatsApp thread ID.
   *
   * Format: whatsapp:{jid}
   */
  decodeThreadId(threadId: string): WhatsAppThreadId {
    if (!threadId.startsWith("whatsapp:")) {
      throw new ValidationError(
        "whatsapp",
        `Invalid WhatsApp thread ID: ${threadId}`
      );
    }

    const jid = threadId.slice(9);
    if (!jid) {
      throw new ValidationError(
        "whatsapp",
        `Invalid WhatsApp thread ID format: ${threadId}`
      );
    }

    return { jid };
  }

  /**
   * Derive channel ID from a WhatsApp thread ID.
   */
  channelIdFromThreadId(threadId: string): string {
    return threadId;
  }

  /**
   * Check if a thread is a DM (not a group).
   */
  isDM(threadId: string): boolean {
    const { jid } = this.decodeThreadId(threadId);
    return !isJidGroup(jid);
  }

  /**
   * Open a DM with a user. Returns the thread ID for the conversation.
   *
   * For Baileys, construct the JID from the phone number.
   */
  async openDM(userId: string): Promise<string> {
    // If the userId is already a JID, normalize it
    const jid = userId.includes("@")
      ? jidNormalizedUser(userId)
      : `${userId}@s.whatsapp.net`;
    return this.encodeThreadId({ jid });
  }

  /**
   * Parse platform message format to normalized format.
   */
  parseMessage(raw: WhatsAppRawMessage): Message<WhatsAppRawMessage> {
    const waMsg = raw.message;
    const text = this.extractTextContent(waMsg) || "";
    const formatted: FormattedContent = this.formatConverter.toAst(text);
    const attachments = this.buildAttachments(waMsg);

    const senderJid =
      waMsg.key.participant || waMsg.key.remoteJid || "";
    const pushName = raw.pushName || jidNormalizedUser(senderJid);

    const threadId = this.encodeThreadId({
      jid: jidNormalizedUser(waMsg.key.remoteJid || ""),
    });

    const timestamp = waMsg.messageTimestamp
      ? typeof waMsg.messageTimestamp === "number"
        ? waMsg.messageTimestamp
        : Number(waMsg.messageTimestamp)
      : Math.floor(Date.now() / 1000);

    return new Message<WhatsAppRawMessage>({
      id: waMsg.key.id ?? "",
      threadId,
      text,
      formatted,
      author: {
        userId: jidNormalizedUser(senderJid),
        userName: pushName,
        fullName: pushName,
        isBot: false,
        isMe: areJidsSameUser(senderJid, this._botUserId ?? undefined),
      },
      metadata: {
        dateSent: new Date(timestamp * 1000),
        edited: false,
      },
      attachments,
      raw,
    });
  }

  /**
   * Render formatted content to WhatsApp markdown.
   */
  renderFormatted(content: FormattedContent): string {
    return this.formatConverter.fromAst(content);
  }

  /**
   * Mark messages as read via Baileys.
   */
  async markAsRead(threadId: string, messageId: string): Promise<void> {
    if (!this.sock) return;

    const { jid } = this.decodeThreadId(threadId);
    await this.sock.readMessages([
      {
        remoteJid: jid,
        id: messageId,
        fromMe: false,
      },
    ]);
  }

  /**
   * Disconnect the Baileys socket cleanly.
   */
  async disconnect(): Promise<void> {
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.logger.info("WhatsApp Baileys adapter disconnected");
  }

  /**
   * Resolve an emoji value to a unicode string.
   */
  private resolveEmoji(emoji: EmojiValue | string): string {
    return defaultEmojiResolver.toGChat(emoji);
  }
}

/**
 * Factory function to create a WhatsApp adapter powered by Baileys.
 *
 * @example
 * ```typescript
 * import { useMultiFileAuthState } from "baileys";
 *
 * const { state, saveCreds } = await useMultiFileAuthState("auth_store");
 * const adapter = createWhatsAppAdapter({
 *   auth: state,
 *   onCredsUpdate: saveCreds,
 * });
 * ```
 */
export function createWhatsAppAdapter(config: {
  auth: AuthenticationState;
  countryCode?: string;
  logger?: Logger;
  onCredsUpdate?: () => Promise<void>;
  printQRInTerminal?: boolean;
  socketOptions?: Record<string, unknown>;
  userName?: string;
}): WhatsAppAdapter {
  const logger = config.logger ?? new ConsoleLogger("info").child("whatsapp");

  if (!config.auth) {
    throw new ValidationError(
      "whatsapp",
      "auth is required. Use useMultiFileAuthState() from baileys to create auth state."
    );
  }

  const userName =
    config.userName ?? process.env.WHATSAPP_BOT_USERNAME ?? "whatsapp-bot";

  return new WhatsAppAdapter({
    auth: config.auth,
    logger,
    userName,
    printQRInTerminal: config.printQRInTerminal,
    countryCode: config.countryCode,
    onCredsUpdate: config.onCredsUpdate,
    socketOptions: config.socketOptions,
  });
}
