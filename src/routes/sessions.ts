import { Router } from 'express';
import type { SessionManager } from '../sessions/SessionManager';

function parseCompanyId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) {
    return null;
  }

  return Number(raw);
}

export function createSessionsRouter(sessionManager: SessionManager): Router {
  const router = Router();

  router.param('companyId', (req, res, next, raw) => {
    const companyId = parseCompanyId(raw);

    if (companyId === null) {
      res.status(400).json({ success: false, message: 'Invalid companyId.', data: null, errors: null });

      return;
    }

    req.companyId = companyId;
    next();
  });

  router.post('/:companyId/connect', async (req, res) => {
    await sessionManager.connect(req.companyId!);
    res.status(202).json({ success: true, message: 'Connect requested.', data: null, errors: null });
  });

  router.post('/:companyId/disconnect', async (req, res) => {
    await sessionManager.disconnect(req.companyId!);
    res.status(200).json({ success: true, message: 'Disconnected.', data: null, errors: null });
  });

  router.get('/:companyId/status', (req, res) => {
    res.status(200).json({ success: true, message: '', data: sessionManager.getStatus(req.companyId!), errors: null });
  });

  router.post('/:companyId/send', async (req, res) => {
    const { to, body, as_voice: asVoice } = req.body ?? {};

    if (typeof to !== 'string' || typeof body !== 'string' || !to || !body) {
      res.status(400).json({ success: false, message: 'to and body are required.', data: null, errors: null });

      return;
    }

    try {
      await sessionManager.sendMessage(req.companyId!, to, body, asVoice === true);
      res.status(200).json({ success: true, message: 'Sent.', data: null, errors: null });
    } catch (error) {
      res.status(409).json({
        success: false,
        message: error instanceof Error ? error.message : 'Failed to send message.',
        data: null,
        errors: null,
      });
    }
  });

  router.post('/:companyId/send-image', async (req, res) => {
    const { to, image_url: imageUrl, caption } = req.body ?? {};

    if (typeof to !== 'string' || typeof imageUrl !== 'string' || !to || !imageUrl) {
      res.status(400).json({ success: false, message: 'to and image_url are required.', data: null, errors: null });

      return;
    }

    try {
      await sessionManager.sendImage(req.companyId!, to, imageUrl, typeof caption === 'string' ? caption : undefined);
      res.status(200).json({ success: true, message: 'Sent.', data: null, errors: null });
    } catch (error) {
      res.status(409).json({
        success: false,
        message: error instanceof Error ? error.message : 'Failed to send image.',
        data: null,
        errors: null,
      });
    }
  });

  return router;
}
