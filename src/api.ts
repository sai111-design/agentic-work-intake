/**
 * Express API. Thin HTTP layer over the orchestrator.
 *
 * Every endpoint validates input, returns useful errors, and never exposes
 * secrets. The API surface is deliberately small — only what the UI needs.
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { config, isLlmConfigured, MAX_REQUEST_CHARS } from './config.js';
import type { LLMProvider } from './llm/provider.js';
import {
  submitRequest,
  approveAction,
  rejectAction,
  editAction,
  getRequest,
  getRequestActions,
  getRequestEvents,
  getRequestTasks,
} from './orchestrator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function createApp(provider: LLMProvider, db: DatabaseSync) {
  const app = express();

  app.use(express.json({ limit: '100kb' }));

  // Serve static files (the UI)
  app.use(express.static(join(__dirname, '..', 'public')));

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      llm: {
        provider: provider.name,
        model: provider.model,
        configured: provider.configured,
      },
      timestamp: new Date().toISOString(),
    });
  });

  // -----------------------------------------------------------------------
  // Submit a new request
  // -----------------------------------------------------------------------

  app.post('/api/requests', async (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const rawText = typeof body?.['text'] === 'string' ? body['text'].trim() : '';

      if (!rawText) {
        res.status(400).json({ error: 'Missing or empty "text" field.' });
        return;
      }

      if (rawText.length > MAX_REQUEST_CHARS) {
        res.status(400).json({ error: `Text exceeds maximum of ${MAX_REQUEST_CHARS} characters.` });
        return;
      }

      const requestId = await submitRequest({ db, provider }, rawText);

      // Return the full request state
      const request = getRequest(db, requestId);
      const actions = getRequestActions(db, requestId);
      const events = getRequestEvents(db, requestId);
      const tasks = getRequestTasks(db, requestId);

      res.status(201).json({
        request,
        actions,
        events,
        tasks,
      });
    } catch (err) {
      console.error('POST /api/requests error:', err);
      const message = err instanceof Error ? err.message : 'Internal error';
      res.status(500).json({ error: message });
    }
  });

  // -----------------------------------------------------------------------
  // Get request status (for polling)
  // -----------------------------------------------------------------------

  app.get('/api/requests/:id', (req, res) => {
    try {
      const id = req.params['id'];
      if (!id) {
        res.status(400).json({ error: 'Missing request ID.' });
        return;
      }

      const request = getRequest(db, id);
      if (!request) {
        res.status(404).json({ error: 'Request not found.' });
        return;
      }

      const actions = getRequestActions(db, id);
      const events = getRequestEvents(db, id);
      const tasks = getRequestTasks(db, id);

      res.json({ request, actions, events, tasks });
    } catch (err) {
      console.error('GET /api/requests/:id error:', err);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  // -----------------------------------------------------------------------
  // Approve an action
  // -----------------------------------------------------------------------

  app.post('/api/actions/:id/approve', async (req, res) => {
    try {
      const actionId = req.params['id'];
      if (!actionId) {
        res.status(400).json({ error: 'Missing action ID.' });
        return;
      }

      await approveAction({ db, provider }, actionId);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /api/actions/:id/approve error:', err);
      const message = err instanceof Error ? err.message : 'Internal error';
      const status = message.includes('not found') ? 404 : message.includes('Illegal') ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  // -----------------------------------------------------------------------
  // Reject an action
  // -----------------------------------------------------------------------

  app.post('/api/actions/:id/reject', (req, res) => {
    try {
      const actionId = req.params['id'];
      if (!actionId) {
        res.status(400).json({ error: 'Missing action ID.' });
        return;
      }

      rejectAction({ db, provider }, actionId);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /api/actions/:id/reject error:', err);
      const message = err instanceof Error ? err.message : 'Internal error';
      const status = message.includes('not found') ? 404 : message.includes('Illegal') ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  // -----------------------------------------------------------------------
  // Edit an action
  // -----------------------------------------------------------------------

  app.post('/api/actions/:id/edit', (req, res) => {
    try {
      const actionId = req.params['id'];
      if (!actionId) {
        res.status(400).json({ error: 'Missing action ID.' });
        return;
      }

      const body = req.body as Record<string, unknown>;
      const toolInput = body?.['tool_input'];
      if (!toolInput || typeof toolInput !== 'object') {
        res.status(400).json({ error: 'Missing or invalid "tool_input" object.' });
        return;
      }

      editAction({ db, provider }, actionId, toolInput as Record<string, unknown>);
      res.json({ ok: true });
    } catch (err) {
      console.error('POST /api/actions/:id/edit error:', err);
      const message = err instanceof Error ? err.message : 'Internal error';
      const status = message.includes('not found') ? 404 : message.includes('Illegal') ? 409 : 500;
      res.status(status).json({ error: message });
    }
  });

  return app;
}
