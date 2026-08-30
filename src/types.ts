export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface StatusCallbackPayload {
  status: SessionStatus;
  qr?: string;
  phone_number?: string;
  session_name?: string;
}

export interface LocalSessionStatus {
  companyId: number;
  status: SessionStatus;
  hasSocket: boolean;
  reconnectAttempts: number;
}

export interface IncomingMessagePayload {
  from: string;
  whatsapp_jid?: string;
  body: string;
  is_voice?: boolean;
  is_image?: boolean;
  push_name?: string;
  whatsapp_message_id?: string;
}
