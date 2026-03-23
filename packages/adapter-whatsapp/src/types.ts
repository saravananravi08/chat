/**
 * Type definitions for the WhatsApp adapter (Baileys-based).
 *
 * Uses Baileys (WhiskeySockets/Baileys) for WebSocket-based WhatsApp Web
 * connectivity instead of Meta's Cloud API.
 */

import type { Logger } from "chat";
import type {
  AuthenticationState,
  WAMessage,
} from "baileys";

// =============================================================================
// Configuration
// =============================================================================

/**
 * WhatsApp adapter configuration for Baileys.
 *
 * Requires a Baileys auth state (from useMultiFileAuthState or custom).
 * No Meta Cloud API credentials needed — connects directly via WebSocket.
 */
export interface WhatsAppAdapterConfig {
  /** Baileys authentication state (creds + keys) */
  auth: AuthenticationState;
  /** Logger instance for error reporting */
  logger: Logger;
  /** Bot display name used for identification */
  userName: string;
  /** Path to store auth credentials (used if auth is not provided) */
  authDir?: string;
  /** Whether to print QR code to terminal for pairing (default: true) */
  printQRInTerminal?: boolean;
  /** Country code for phone number handling (default: "1") */
  countryCode?: string;
  /**
   * Callback invoked when Baileys credentials update.
   * Must persist the updated state (e.g. call saveCreds from useMultiFileAuthState).
   */
  onCredsUpdate?: () => Promise<void>;
  /** Custom Baileys socket options (merged with defaults) */
  socketOptions?: Record<string, unknown>;
}

// =============================================================================
// Thread ID
// =============================================================================

/**
 * Decoded thread ID for WhatsApp (Baileys).
 *
 * Baileys uses JIDs (Jabber IDs) to identify chats.
 * Format: baileys:{jid}
 *
 * - 1:1 DMs use `{phone}@s.whatsapp.net`
 * - Groups use `{id}@g.us`
 */
export interface WhatsAppThreadId {
  /** Full Baileys JID (e.g. "15551234567@s.whatsapp.net" or "120363021234567890@g.us") */
  jid: string;
}

// =============================================================================
// Raw Message Type
// =============================================================================

/**
 * Platform-specific raw message type wrapping Baileys WAMessage.
 */
export interface WhatsAppRawMessage {
  /** The raw Baileys WAMessage */
  message: WAMessage;
  /** Sender's push name (display name) */
  pushName?: string;
}

// =============================================================================
// Re-exports from Baileys for convenience
// =============================================================================

export type { WAMessage, AuthenticationState };
