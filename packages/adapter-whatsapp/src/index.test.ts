import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createWhatsAppAdapter, splitMessage, WhatsAppAdapter } from "./index";
import type { WhatsAppRawMessage } from "./types";

const AUTH_PATTERN = /auth/i;

/**
 * Minimal mock auth state for testing.
 */
function createMockAuth() {
  return {
    creds: {} as any,
    keys: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
  };
}

/**
 * Create a minimal WhatsAppAdapter for testing.
 * We mock makeWASocket so no real connection is made.
 */
function createTestAdapter(): WhatsAppAdapter {
  return new WhatsAppAdapter({
    auth: createMockAuth(),
    userName: "test-bot",
    printQRInTerminal: false,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  });
}

// ---------------------------------------------------------------------------
// Thread ID encoding/decoding
// ---------------------------------------------------------------------------

describe("encodeThreadId", () => {
  it("should encode a DM thread ID", () => {
    const adapter = createTestAdapter();
    const result = adapter.encodeThreadId({
      jid: "15551234567@s.whatsapp.net",
    });
    expect(result).toBe("whatsapp:15551234567@s.whatsapp.net");
  });

  it("should encode a group thread ID", () => {
    const adapter = createTestAdapter();
    const result = adapter.encodeThreadId({
      jid: "120363021234567890@g.us",
    });
    expect(result).toBe("whatsapp:120363021234567890@g.us");
  });
});

describe("decodeThreadId", () => {
  it("should decode a valid DM thread ID", () => {
    const adapter = createTestAdapter();
    const result = adapter.decodeThreadId(
      "whatsapp:15551234567@s.whatsapp.net"
    );
    expect(result).toEqual({
      jid: "15551234567@s.whatsapp.net",
    });
  });

  it("should decode a valid group thread ID", () => {
    const adapter = createTestAdapter();
    const result = adapter.decodeThreadId(
      "whatsapp:120363021234567890@g.us"
    );
    expect(result).toEqual({
      jid: "120363021234567890@g.us",
    });
  });

  it("should throw on invalid prefix", () => {
    const adapter = createTestAdapter();
    expect(() => adapter.decodeThreadId("slack:C123:ts123")).toThrow(
      "Invalid WhatsApp thread ID"
    );
  });

  it("should throw on empty after prefix", () => {
    const adapter = createTestAdapter();
    expect(() => adapter.decodeThreadId("whatsapp:")).toThrow(
      "Invalid WhatsApp thread ID format"
    );
  });

  it("should throw on completely wrong format", () => {
    const adapter = createTestAdapter();
    expect(() => adapter.decodeThreadId("nonsense")).toThrow(
      "Invalid WhatsApp thread ID"
    );
  });
});

describe("encodeThreadId / decodeThreadId roundtrip", () => {
  it("should round-trip a DM thread ID", () => {
    const adapter = createTestAdapter();
    const original = { jid: "15551234567@s.whatsapp.net" };
    const encoded = adapter.encodeThreadId(original);
    const decoded = adapter.decodeThreadId(encoded);
    expect(decoded).toEqual(original);
  });

  it("should round-trip a group thread ID", () => {
    const adapter = createTestAdapter();
    const original = { jid: "120363021234567890@g.us" };
    const encoded = adapter.encodeThreadId(original);
    const decoded = adapter.decodeThreadId(encoded);
    expect(decoded).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// channelIdFromThreadId
// ---------------------------------------------------------------------------

describe("channelIdFromThreadId", () => {
  it("should return the full thread ID", () => {
    const adapter = createTestAdapter();
    const result = adapter.channelIdFromThreadId(
      "whatsapp:15551234567@s.whatsapp.net"
    );
    expect(result).toBe("whatsapp:15551234567@s.whatsapp.net");
  });
});

// ---------------------------------------------------------------------------
// isDM
// ---------------------------------------------------------------------------

describe("isDM", () => {
  it("should return true for 1:1 DMs", () => {
    const adapter = createTestAdapter();
    expect(
      adapter.isDM("whatsapp:15551234567@s.whatsapp.net")
    ).toBe(true);
  });

  it("should return false for group chats", () => {
    const adapter = createTestAdapter();
    expect(
      adapter.isDM("whatsapp:120363021234567890@g.us")
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// renderFormatted
// ---------------------------------------------------------------------------

describe("renderFormatted", () => {
  it("should render markdown from AST", () => {
    const adapter = createTestAdapter();
    const ast = {
      type: "root" as const,
      children: [
        {
          type: "paragraph" as const,
          children: [{ type: "text" as const, value: "Hello world" }],
        },
      ],
    };
    const result = adapter.renderFormatted(ast);
    expect(result).toContain("Hello world");
  });
});

// ---------------------------------------------------------------------------
// parseMessage
// ---------------------------------------------------------------------------

describe("parseMessage", () => {
  it("should parse a raw Baileys text message (conversation)", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "AABBCC123",
          fromMe: false,
        },
        messageTimestamp: 1700000000,
        pushName: "Alice",
        message: {
          conversation: "Hello from WhatsApp!",
        },
      },
      pushName: "Alice",
    };
    const message = adapter.parseMessage(raw);
    expect(message.id).toBe("AABBCC123");
    expect(message.text).toBe("Hello from WhatsApp!");
    expect(message.author.userName).toBe("Alice");
  });

  it("should parse an extendedTextMessage", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "DDEEFF456",
          fromMe: false,
        },
        messageTimestamp: 1700000100,
        pushName: "Bob",
        message: {
          extendedTextMessage: {
            text: "Extended text message here",
          },
        },
      },
      pushName: "Bob",
    };
    const message = adapter.parseMessage(raw);
    expect(message.text).toBe("Extended text message here");
  });

  it("should parse an image message with caption", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "IMG001",
          fromMe: false,
        },
        messageTimestamp: 1700000200,
        message: {
          imageMessage: {
            caption: "Check this out",
            mimetype: "image/jpeg",
            url: "https://example.com/media",
          },
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.text).toBe("Check this out");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].type).toBe("image");
    expect(message.attachments[0].mimeType).toBe("image/jpeg");
  });

  it("should parse an image message without caption", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "IMG002",
          fromMe: false,
        },
        messageTimestamp: 1700000300,
        message: {
          imageMessage: {
            mimetype: "image/png",
            url: "https://example.com/media",
          },
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.text).toBe("[Image]");
  });

  it("should set correct dateSent from unix timestamp", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "TIME001",
          fromMe: false,
        },
        messageTimestamp: 1700000000,
        message: {
          conversation: "test",
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.metadata.dateSent.getTime()).toBe(1700000000000);
  });

  it("should have no attachments for plain text messages", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "TXT001",
          fromMe: false,
        },
        messageTimestamp: 1700000000,
        message: {
          conversation: "Hello",
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.attachments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// parseMessage - media attachments
// ---------------------------------------------------------------------------

describe("parseMessage - media attachments", () => {
  it("should create a document attachment with filename", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "DOC001",
          fromMe: false,
        },
        messageTimestamp: 1700000300,
        message: {
          documentMessage: {
            mimetype: "application/pdf",
            fileName: "report.pdf",
            url: "https://example.com/media",
          },
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.text).toBe("[Document: report.pdf]");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].type).toBe("file");
    expect(message.attachments[0].mimeType).toBe("application/pdf");
    expect(message.attachments[0].name).toBe("report.pdf");
  });

  it("should create an audio attachment", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "AUD001",
          fromMe: false,
        },
        messageTimestamp: 1700000400,
        message: {
          audioMessage: {
            mimetype: "audio/ogg",
            ptt: false,
            url: "https://example.com/media",
          },
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.text).toBe("[Audio message]");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].type).toBe("audio");
    expect(message.attachments[0].mimeType).toBe("audio/ogg");
  });

  it("should create a voice message attachment", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "VOC001",
          fromMe: false,
        },
        messageTimestamp: 1700000650,
        message: {
          audioMessage: {
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
            url: "https://example.com/media",
          },
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.text).toBe("[Voice message]");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].type).toBe("audio");
    expect(message.attachments[0].name).toBe("voice");
  });

  it("should create a video attachment", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "VID001",
          fromMe: false,
        },
        messageTimestamp: 1700000500,
        message: {
          videoMessage: {
            mimetype: "video/mp4",
            url: "https://example.com/media",
          },
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.text).toBe("[Video]");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].type).toBe("video");
    expect(message.attachments[0].mimeType).toBe("video/mp4");
  });

  it("should create a sticker attachment as image type", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "STK001",
          fromMe: false,
        },
        messageTimestamp: 1700000600,
        message: {
          stickerMessage: {
            mimetype: "image/webp",
            url: "https://example.com/media",
          },
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.text).toBe("[Sticker]");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].type).toBe("image");
    expect(message.attachments[0].mimeType).toBe("image/webp");
    expect(message.attachments[0].name).toBe("sticker");
  });

  it("should create a location attachment with Google Maps URL", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "LOC001",
          fromMe: false,
        },
        messageTimestamp: 1700000700,
        message: {
          locationMessage: {
            degreesLatitude: 37.7749,
            degreesLongitude: -122.4194,
            name: "San Francisco",
            address: "CA, USA",
          },
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.text).toBe("[Location: San Francisco - CA, USA]");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].type).toBe("file");
    expect(message.attachments[0].name).toBe("San Francisco");
    expect(message.attachments[0].url).toBe(
      "https://www.google.com/maps?q=37.7749,-122.4194"
    );
  });

  it("should format location text with coordinates when no name", () => {
    const adapter = createTestAdapter();
    const raw: WhatsAppRawMessage = {
      message: {
        key: {
          remoteJid: "15551234567@s.whatsapp.net",
          id: "LOC002",
          fromMe: false,
        },
        messageTimestamp: 1700000800,
        message: {
          locationMessage: {
            degreesLatitude: 48.8566,
            degreesLongitude: 2.3522,
          },
        },
      },
    };
    const message = adapter.parseMessage(raw);
    expect(message.text).toBe("[Location: 48.8566, 2.3522]");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].name).toBe("Location");
  });
});

// ---------------------------------------------------------------------------
// handleWebhook
// ---------------------------------------------------------------------------

describe("handleWebhook", () => {
  it("should return 501 (Baileys uses WebSocket, not HTTP)", async () => {
    const adapter = createTestAdapter();
    const request = new Request("https://example.com/webhook", {
      method: "POST",
    });
    const response = await adapter.handleWebhook(request);
    expect(response.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------
// splitMessage
// ---------------------------------------------------------------------------

describe("splitMessage", () => {
  it("should return a single chunk for short messages", () => {
    const result = splitMessage("Hello world");
    expect(result).toEqual(["Hello world"]);
  });

  it("should return a single chunk for exactly 4096 chars", () => {
    const text = "a".repeat(4096);
    const result = splitMessage(text);
    expect(result).toEqual([text]);
  });

  it("should split on paragraph boundaries when possible", () => {
    const paragraph1 = "a".repeat(3000);
    const paragraph2 = "b".repeat(3000);
    const text = `${paragraph1}\n\n${paragraph2}`;
    const result = splitMessage(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(paragraph1);
    expect(result[1]).toBe(paragraph2);
  });

  it("should split on line boundaries when no paragraph break", () => {
    const line1 = "a".repeat(3000);
    const line2 = "b".repeat(3000);
    const text = `${line1}\n${line2}`;
    const result = splitMessage(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe(line1);
    expect(result[1]).toBe(line2);
  });

  it("should hard-break when no line boundaries exist", () => {
    const text = "a".repeat(5000);
    const result = splitMessage(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("a".repeat(4096));
    expect(result[1]).toBe("a".repeat(904));
  });

  it("should handle three chunks", () => {
    const p1 = "a".repeat(4000);
    const p2 = "b".repeat(4000);
    const p3 = "c".repeat(4000);
    const text = `${p1}\n\n${p2}\n\n${p3}`;
    const result = splitMessage(text);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(p1);
    expect(result[1]).toBe(p2);
    expect(result[2]).toBe(p3);
  });

  it("should not split on a break that is too early in the chunk", () => {
    const earlyPart = "a".repeat(1000);
    const rest = "b".repeat(4500);
    const text = `${earlyPart}\n\n${rest}`;
    const result = splitMessage(text);
    expect(result).toHaveLength(2);
    expect(result[0].length).toBe(4096);
    expect(result[1].length).toBe(text.length - 4096);
  });

  it("should preserve all content across chunks", () => {
    const text = "x".repeat(10000);
    const result = splitMessage(text);
    expect(result.join("")).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// fetchMessages
// ---------------------------------------------------------------------------

describe("fetchMessages", () => {
  it("returns empty messages array", async () => {
    const adapter = createTestAdapter();
    const result = await adapter.fetchMessages(
      "whatsapp:15551234567@s.whatsapp.net"
    );
    expect(result).toEqual({ messages: [] });
  });
});

// ---------------------------------------------------------------------------
// fetchThread
// ---------------------------------------------------------------------------

describe("fetchThread", () => {
  it("returns correct ThreadInfo for DM", async () => {
    const adapter = createTestAdapter();
    const info = await adapter.fetchThread(
      "whatsapp:15551234567@s.whatsapp.net"
    );
    expect(info.id).toBe("whatsapp:15551234567@s.whatsapp.net");
    expect(info.channelId).toBe("whatsapp:15551234567@s.whatsapp.net");
    expect(info.isDM).toBe(true);
    expect(info.metadata).toEqual({
      jid: "15551234567@s.whatsapp.net",
    });
  });

  it("returns correct ThreadInfo for group", async () => {
    const adapter = createTestAdapter();
    const info = await adapter.fetchThread(
      "whatsapp:120363021234567890@g.us"
    );
    expect(info.isDM).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// openDM
// ---------------------------------------------------------------------------

describe("openDM", () => {
  it("returns encoded thread ID for a phone number", async () => {
    const adapter = createTestAdapter();
    const threadId = await adapter.openDM("15551234567");
    expect(threadId).toBe("whatsapp:15551234567@s.whatsapp.net");
  });

  it("returns encoded thread ID for an existing JID", async () => {
    const adapter = createTestAdapter();
    const threadId = await adapter.openDM("15551234567@s.whatsapp.net");
    expect(threadId).toBe("whatsapp:15551234567@s.whatsapp.net");
  });
});

// ---------------------------------------------------------------------------
// startTyping
// ---------------------------------------------------------------------------

describe("startTyping", () => {
  it("does not throw when socket is null (not initialized)", async () => {
    const adapter = createTestAdapter();
    await expect(
      adapter.startTyping("whatsapp:15551234567@s.whatsapp.net")
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createWhatsAppAdapter factory
// ---------------------------------------------------------------------------

describe("createWhatsAppAdapter", () => {
  it("throws when auth is missing", () => {
    expect(() =>
      createWhatsAppAdapter({
        auth: undefined as any,
      })
    ).toThrow(AUTH_PATTERN);
  });

  it("creates adapter with valid auth", () => {
    const adapter = createWhatsAppAdapter({
      auth: createMockAuth(),
    });
    expect(adapter).toBeInstanceOf(WhatsAppAdapter);
  });

  it("uses default userName when not provided", () => {
    const adapter = createWhatsAppAdapter({
      auth: createMockAuth(),
    });
    expect(adapter.userName).toBe("whatsapp-bot");
  });

  it("uses custom userName when provided", () => {
    const adapter = createWhatsAppAdapter({
      auth: createMockAuth(),
      userName: "custom-bot",
    });
    expect(adapter.userName).toBe("custom-bot");
  });
});
