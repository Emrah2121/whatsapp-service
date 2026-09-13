import fs from 'node:fs/promises';
import path from 'node:path';
import type { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { config } from '../config';
import { postIncomingMessage, postStatus } from '../laravelClient';
import { createLogger } from '../logger';
import type { LocalSessionStatus, SessionStatus } from '../types';
import { runWithConcurrencyLimit } from '../util/concurrencyLimit';
import { getMediaConfig } from '../voice/mediaConfig';
import { transcribeAudio } from '../voice/stt';
import { synthesizeSpeech } from '../voice/tts';
import { analyzeImage } from '../voice/vision';

const logger = createLogger('SessionManager');

const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY_MS = 2000;
const RESUME_CONCURRENCY = 3;
const RESUME_STAGGER_MS = 1500;

interface CompanySessionState {
  socket: WASocket | null;
  status: SessionStatus;
  connecting: boolean;
  intentionalDisconnect: boolean;
  reconnectAttempts: number;
}

interface ConnectionUpdate {
  connection?: string;
  lastDisconnect?: { error?: unknown };
  qr?: string;
}

interface IncomingWAMessage {
  key: { remoteJid?: string | null; fromMe?: boolean | null; id?: string | null };
  pushName?: string | null;
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
    audioMessage?: { mimetype?: string | null } | null;
    imageMessage?: { mimetype?: string | null; caption?: string | null } | null;
  } | null;
}

interface MessagesUpsertEvent {
  type: string;
  messages: IncomingWAMessage[];
}

export class SessionManager {
  private sessions = new Map<number, CompanySessionState>();

  private getOrInitState(companyId: number): CompanySessionState {
    let state = this.sessions.get(companyId);

    if (!state) {
      state = {
        socket: null,
        status: 'disconnected',
        connecting: false,
        intentionalDisconnect: false,
        reconnectAttempts: 0,
      };
      this.sessions.set(companyId, state);
    }

    return state;
  }

  private sessionFolder(companyId: number): string {
    return path.join(config.sessionsDir, String(companyId));
  }

  /**
   * Starts (or no-ops if already in progress) a Baileys session for a
   * company. Returns immediately once listeners are attached - the actual
   * QR / connected state arrives asynchronously via connection.update events,
   * which are reported to Laravel through postStatus().
   */
  async connect(companyId: number): Promise<void> {
    const state = this.getOrInitState(companyId);

    if (state.connecting || state.status === 'connected') {
      logger.info({ companyId }, 'Connect requested but session already connecting/connected - ignoring');

      return;
    }

    state.connecting = true;
    state.intentionalDisconnect = false;

    try {
      await this.startSocket(companyId, state);
    } catch (error) {
      state.connecting = false;
      state.status = 'failed';
      logger.error({ companyId, err: error instanceof Error ? error.message : error }, 'Failed to start WhatsApp session');
      await postStatus(companyId, { status: 'failed' });
    }
  }

  private async startSocket(companyId: number, state: CompanySessionState): Promise<void> {
    const folder = this.sessionFolder(companyId);
    await fs.mkdir(folder, { recursive: true });

    const { state: authState, saveCreds } = await useMultiFileAuthState(folder);
    const { version } = await fetchLatestBaileysVersion();

    const socket = makeWASocket({
      version,
      auth: authState,
      logger: createLogger(`baileys:${companyId}`),
      printQRInTerminal: false,
    });

    state.socket = socket;

    socket.ev.on('creds.update', saveCreds);
    socket.ev.on('connection.update', (update: ConnectionUpdate) => {
      void this.handleConnectionUpdate(companyId, state, update);
    });
    socket.ev.on('messages.upsert', (event: MessagesUpsertEvent) => {
      void this.handleMessagesUpsert(companyId, event);
    });
  }

  /**
   * Handles text, voice and image messages. Voice notes are transcribed (Groq
   * Whisper) and images are described (Gemini vision) into text before being
   * forwarded to Laravel, each flagged so the conversation can continue. Voice
   * and vision are toggled per company; other media (documents/stickers) are
   * still skipped entirely.
   */
  private async handleMessagesUpsert(companyId: number, event: MessagesUpsertEvent): Promise<void> {
    if (event.type !== 'notify') {
      return;
    }

    for (const message of event.messages) {
      if (message.key.fromMe) {
        // Avoid echoing the bot's own sent messages back through the pipeline.
        continue;
      }

      if (!message.key.remoteJid) {
        continue;
      }

      const audio = message.message?.audioMessage;
      const image = message.message?.imageMessage;
      let text = message.message?.conversation ?? message.message?.extendedTextMessage?.text ?? null;
      let isVoice = false;
      let isImage = false;

      if (!text && audio) {
        text = await this.transcribeVoiceNote(companyId, message);
        isVoice = true;

        if (!text) {
          // Couldn't transcribe (STT off/failed) - skip rather than reply blindly.
          continue;
        }
      } else if (image) {
        // Image analysis is opt-in per company; skip entirely when it's off.
        const { visionEnabled } = await getMediaConfig(companyId);

        if (!visionEnabled) {
          continue;
        }

        text = await this.analyzeImageMessage(companyId, message);
        isImage = true;

        if (!text) {
          // Couldn't analyse (vision off/failed) - skip rather than reply blindly.
          continue;
        }
      }

      if (!text) {
        continue;
      }

      // remoteJid is the exact address to reply to - WhatsApp's LID (Linked
      // ID) privacy feature means this isn't always a real phone number, so
      // it must be kept as-is and reused verbatim when sending the reply,
      // not reconstructed from the stripped digits below (which are for
      // display/storage only).
      const jid = message.key.remoteJid;
      const from = jidNormalizedUser(jid).split('@')[0];

      await postIncomingMessage(companyId, {
        from,
        whatsapp_jid: jid,
        body: text,
        is_voice: isVoice,
        is_image: isImage,
        push_name: message.pushName ?? undefined,
        whatsapp_message_id: message.key.id ?? undefined,
      });
    }
  }

  /** Downloads a voice note's audio and returns its transcription, or null. */
  private async transcribeVoiceNote(companyId: number, message: IncomingWAMessage): Promise<string | null> {
    try {
      const buffer = (await downloadMediaMessage(message as WAMessage, 'buffer', {})) as Buffer;
      const mimetype = message.message?.audioMessage?.mimetype ?? 'audio/ogg';

      return await transcribeAudio(buffer, mimetype);
    } catch (error) {
      logger.warn(
        { companyId, err: error instanceof Error ? error.message : error },
        'Failed to download/transcribe voice note',
      );

      return null;
    }
  }

  /** Downloads an image and returns a text description (with its caption), or null. */
  private async analyzeImageMessage(companyId: number, message: IncomingWAMessage): Promise<string | null> {
    try {
      const buffer = (await downloadMediaMessage(message as WAMessage, 'buffer', {})) as Buffer;
      const mimetype = message.message?.imageMessage?.mimetype ?? 'image/jpeg';
      const caption = message.message?.imageMessage?.caption ?? undefined;

      const description = await analyzeImage(buffer, mimetype, caption);

      if (!description) {
        return null;
      }

      // Give the company AI both the customer's own words (if any) and the
      // image description so it can answer in context.
      return caption
        ? `${caption}\n\n[Şəklin təsviri: ${description}]`
        : `[İstifadəçi şəkil göndərdi. ${description}]`;
    } catch (error) {
      logger.warn(
        { companyId, err: error instanceof Error ? error.message : error },
        'Failed to download/analyse image',
      );

      return null;
    }
  }

  private async handleConnectionUpdate(
    companyId: number,
    state: CompanySessionState,
    update: ConnectionUpdate,
  ): Promise<void> {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Baileys regenerates the QR roughly every ~20s until scanned - each
      // one overwrites the previous value in Laravel, it is not appended.
      state.connecting = true;
      state.status = 'connecting';
      const qrDataUri = await QRCode.toDataURL(qr);
      await postStatus(companyId, { status: 'connecting', qr: qrDataUri });

      return;
    }

    if (connection === 'open') {
      state.connecting = false;
      state.status = 'connected';
      state.reconnectAttempts = 0;

      const rawJid = state.socket?.user?.id;
      const phoneNumber = rawJid ? jidNormalizedUser(rawJid).split('@')[0] : undefined;

      await postStatus(companyId, {
        status: 'connected',
        phone_number: phoneNumber,
        session_name: `company-${companyId}`,
      });

      return;
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;

      if (statusCode === DisconnectReason.restartRequired) {
        // Normal part of the pairing handshake right after a QR scan, not a
        // failure - reconnect silently, no status change reported.
        logger.info({ companyId }, 'Restart required (pairing handshake) - reconnecting silently');
        state.connecting = false;
        await this.connect(companyId);

        return;
      }

      state.socket = null;
      state.connecting = false;

      if (state.intentionalDisconnect) {
        state.status = 'disconnected';
        state.intentionalDisconnect = false;

        return;
      }

      if (statusCode === DisconnectReason.loggedOut) {
        logger.info({ companyId }, 'Session logged out from the phone - clearing local auth state');
        state.status = 'disconnected';
        state.reconnectAttempts = 0;
        await this.clearAuthFolder(companyId);
        await postStatus(companyId, { status: 'disconnected' });

        return;
      }

      // Transient drop - reconnect with capped exponential backoff + jitter
      // rather than hot-looping against a persistently erroring account.
      state.reconnectAttempts += 1;

      if (state.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        logger.error({ companyId }, 'Exceeded max reconnect attempts - giving up');
        state.status = 'failed';
        await postStatus(companyId, { status: 'failed' });

        return;
      }

      state.status = 'connecting';
      const delay = BASE_RECONNECT_DELAY_MS * 2 ** (state.reconnectAttempts - 1) + Math.random() * 500;
      logger.warn({ companyId, attempt: state.reconnectAttempts, delay }, 'WhatsApp connection dropped - reconnecting');
      setTimeout(() => {
        void this.connect(companyId);
      }, delay);
    }
  }

  async disconnect(companyId: number): Promise<void> {
    const state = this.getOrInitState(companyId);
    state.intentionalDisconnect = true;

    if (state.socket) {
      try {
        await state.socket.logout();
      } catch (error) {
        logger.warn(
          { companyId, err: error instanceof Error ? error.message : error },
          'Error during logout - continuing with local cleanup',
        );
      }
    }

    state.socket = null;
    state.connecting = false;
    state.status = 'disconnected';
    state.reconnectAttempts = 0;

    await this.clearAuthFolder(companyId);
    await postStatus(companyId, { status: 'disconnected' });
  }

  private async clearAuthFolder(companyId: number): Promise<void> {
    await fs.rm(this.sessionFolder(companyId), { recursive: true, force: true });
  }

  /**
   * Sends a plain text message through the company's active socket. Throws
   * if there is no live, connected socket for this company.
   */
  /**
   * `to` should normally be the full original JID the conversation is on
   * (e.g. from an earlier incoming message's remoteJid, which may be a
   * WhatsApp LID address, not a phone number) - used as-is when it already
   * contains a domain. Falls back to constructing a plain phone-number JID
   * only for callers that pass a bare number.
   */
  async sendMessage(companyId: number, to: string, body: string, asVoice = false): Promise<void> {
    const state = this.sessions.get(companyId);

    if (!state?.socket || state.status !== 'connected') {
      throw new Error(`No active WhatsApp connection for company ${companyId}`);
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    if (asVoice) {
      const audio = await synthesizeSpeech(body);

      if (audio) {
        await state.socket.sendMessage(jid, {
          audio,
          ptt: true,
          mimetype: 'audio/ogg; codecs=opus',
        });

        return;
      }

      // TTS unavailable/failed - fall back to text so the reply still lands.
      logger.warn({ companyId }, 'Voice reply requested but TTS failed - sending text instead');
    }

    await state.socket.sendMessage(jid, { text: body });
  }

  /**
   * Sends an image through the company's active socket, fetched directly by
   * Baileys from `imageUrl` (must be a publicly reachable HTTPS URL - Laravel
   * never uploads the bytes here). Throws under the same conditions as
   * sendMessage().
   */
  async sendImage(companyId: number, to: string, imageUrl: string, caption?: string): Promise<void> {
    const state = this.sessions.get(companyId);

    if (!state?.socket || state.status !== 'connected') {
      throw new Error(`No active WhatsApp connection for company ${companyId}`);
    }

    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;

    await state.socket.sendMessage(jid, {
      image: { url: imageUrl },
      caption,
    });
  }

  /** Node's local in-memory view - debugging/ops only, never the UI's source of truth. */
  getStatus(companyId: number): LocalSessionStatus {
    const state = this.sessions.get(companyId);

    return {
      companyId,
      status: state?.status ?? 'disconnected',
      hasSocket: Boolean(state?.socket),
      reconnectAttempts: state?.reconnectAttempts ?? 0,
    };
  }

  /**
   * Resumes every company folder found under SESSIONS_DIR on process boot,
   * staggered to avoid opening many WhatsApp sockets simultaneously.
   */
  async resumeAll(): Promise<void> {
    await fs.mkdir(config.sessionsDir, { recursive: true });
    const entries = await fs.readdir(config.sessionsDir, { withFileTypes: true });
    const companyIds = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name));

    if (companyIds.length === 0) {
      return;
    }

    logger.info({ count: companyIds.length }, 'Resuming existing WhatsApp sessions after restart');

    const tasks = companyIds.map((companyId, index) => async () => {
      await new Promise((resolve) => setTimeout(resolve, index * RESUME_STAGGER_MS));
      await this.connect(companyId);
    });

    await runWithConcurrencyLimit(tasks, RESUME_CONCURRENCY);
  }
}
