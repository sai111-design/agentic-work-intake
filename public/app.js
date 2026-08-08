/* ===========================================================================
   Agentic Work Intake — Client JS
   Vanilla JS, no framework. Handles submission, polling, approval, and display.
   =========================================================================== */

// Scenario texts for prefill buttons
const SCENARIOS = {
  partner: `Summarize a partner discussion, extract follow-ups, draft a thank-you email, and set a 7-day reminder.`,
  website: `Review https://hedamo.com`,
  vague: `Please take care of the documentation and send it to everyone before the meeting.`,
};

let currentRequestId = null;
let pollInterval = null;

// ---------------------------------------------------------------------------
// INIT
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  // Health check
  try {
    const res = await fetch('/api/health');
    const health = await res.json();
    if (!health.llm?.configured) {
      showBanner('⚠ LLM not configured — set GEMINI_API_KEY in .env and restart the server.', 'warning');
    }
  } catch {
    showBanner('⚠ Cannot reach server — is it running?', 'error');
  }

  // Scenario buttons
  document.querySelectorAll('.scenario-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.scenario;
      if (key && SCENARIOS[key]) {
        document.getElementById('request-input').value = SCENARIOS[key];
      }
    });
  });

  // Submit
  document.getElementById('submit-btn').addEventListener('click', handleSubmit);
});

// ---------------------------------------------------------------------------
// HEALTH BANNER
// ---------------------------------------------------------------------------

function showBanner(text, type) {
  const el = document.getElementById('health-banner');
  el.textContent = text;
  el.className = `health-banner ${type || ''}`;
}

// ---------------------------------------------------------------------------
// SUBMIT
// ---------------------------------------------------------------------------

async function handleSubmit() {
  const input = document.getElementById('request-input');
  const btn = document.getElementById('submit-btn');
  const status = document.getElementById('submit-status');
  const text = input.value.trim();

  if (!text) {
    showStatus(status, 'Please enter a work request.', 'error');
    return;
  }

  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = 'Processing';
  showStatus(status, 'Submitting...', '');

  // Reset display
  hideAll();

  try {
    const res = await fetch('/api/requests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });

    const data = await res.json();

    if (!res.ok) {
      showStatus(status, data.error || 'Submission failed.', 'error');
      return;
    }

    currentRequestId = data.request.id;
    renderAll(data);

    // Start polling if not terminal
    if (!isTerminal(data.request.status)) {
      startPolling(currentRequestId);
    }

    showStatus(status, `Request ${currentRequestId.slice(0, 8)}… submitted`, '');
  } catch (err) {
    showStatus(status, `Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = 'Submit Request';
  }
}

// ---------------------------------------------------------------------------
// POLLING
// ---------------------------------------------------------------------------

function startPolling(requestId) {
  stopPolling();
  pollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/requests/${requestId}`);
      if (!res.ok) return;
      const data = await res.json();
      renderAll(data);
      if (isTerminal(data.request.status)) {
        stopPolling();
      }
    } catch { /* ignore polling errors */ }
  }, 1000);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function isTerminal(status) {
  return ['COMPLETED', 'FAILED', 'NEEDS_CLARIFICATION'].includes(status);
}

// ---------------------------------------------------------------------------
// RENDER
// ---------------------------------------------------------------------------

function renderAll(data) {
  renderInterpretation(data.request, data.actions);
  renderPlan(data.actions);
  renderResults(data.actions);
  renderTrace(data.events);
}

function hideAll() {
  ['interpretation-section', 'plan-section', 'results-section', 'trace-section']
    .forEach((id) => document.getElementById(id).classList.add('hidden'));
}

// ---------------------------------------------------------------------------
// SECTION 2: INTERPRETATION
// ---------------------------------------------------------------------------

function renderInterpretation(request, actions) {
  const section = document.getElementById('interpretation-section');
  const content = document.getElementById('interpretation-content');

  if (!request.interpretation) {
    if (request.status === 'FAILED') {
      section.classList.remove('hidden');
      content.innerHTML = `
        <div class="missing-alert" style="border-color: rgba(248,113,113,0.3); background: rgba(248,113,113,0.08);">
          <div class="alert-title" style="color: var(--danger);">⚠ Interpretation Failed</div>
          <p style="color: var(--danger); font-size: 0.9rem;">${escapeHtml(request.error || 'Unknown error')}</p>
        </div>`;
    }
    return;
  }

  let interp;
  try {
    interp = JSON.parse(request.interpretation);
  } catch {
    return;
  }

  section.classList.remove('hidden');

  const missingHtml = interp.missing_information?.length > 0
    ? `<div class="missing-alert">
        <div class="alert-title">⚠ Missing Information</div>
        <ul>${interp.missing_information.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
      </div>`
    : '';

  const humanConfirm = interp.what_requires_human_confirmation?.length > 0
    ? `<div class="interp-field full-width">
        <div class="interp-label">Requires Human Confirmation</div>
        <div class="interp-value">${interp.what_requires_human_confirmation.map((s) => `<span>• ${escapeHtml(s)}</span>`).join('<br>')}</div>
      </div>`
    : '';

  content.innerHTML = `
    <div class="interp-grid">
      <div class="interp-field full-width">
        <div class="interp-label">Title</div>
        <div class="interp-value" style="font-weight: 600; font-size: 1.05rem;">${escapeHtml(interp.task_title)}</div>
      </div>
      <div class="interp-field full-width">
        <div class="interp-label">Summary</div>
        <div class="interp-value">${escapeHtml(interp.summary)}</div>
      </div>
      <div class="interp-field">
        <div class="interp-label">Priority</div>
        <div class="interp-value"><span class="priority-badge priority-${interp.priority}">${interp.priority}</span></div>
      </div>
      <div class="interp-field">
        <div class="interp-label">Detected Deadline</div>
        <div class="interp-value">${interp.detected_deadline ? escapeHtml(interp.detected_deadline) : '<em style="color: var(--text-muted)">None detected</em>'}</div>
      </div>
      <div class="interp-field full-width">
        <div class="interp-label">Action Items (${interp.action_items?.length || 0})</div>
        <div class="interp-value">${(interp.action_items || []).map((a, i) => `<span>${i + 1}. ${escapeHtml(a.title)} <em style="color: var(--text-muted)">(${a.kind})</em></span>`).join('<br>')}</div>
      </div>
      ${humanConfirm}
      ${missingHtml}
    </div>`;
}

// ---------------------------------------------------------------------------
// SECTION 3: AGENT PLAN
// ---------------------------------------------------------------------------

function renderPlan(actions) {
  const section = document.getElementById('plan-section');
  const content = document.getElementById('plan-content');

  if (!actions || actions.length === 0) return;

  section.classList.remove('hidden');

  content.innerHTML = actions.map((action) => {
    const statusClass = action.status.toLowerCase().replace(/_/g, '-');
    const cardClass = action.status === 'PENDING_APPROVAL' ? 'pending-approval'
      : action.status === 'COMPLETED' ? 'completed'
      : action.status === 'FAILED' ? 'failed'
      : action.status === 'NEEDS_CLARIFICATION' ? 'clarification'
      : '';

    let buttonsHtml = '';
    if (action.status === 'PENDING_APPROVAL') {
      buttonsHtml = `
        <div class="action-buttons">
          <button class="action-btn approve" onclick="handleApprove('${action.id}')">✓ Approve</button>
          <button class="action-btn reject" onclick="handleReject('${action.id}')">✗ Reject</button>
          <button class="action-btn edit" onclick="toggleEdit('${action.id}')">✎ Edit</button>
        </div>
        <div id="edit-form-${action.id}" class="edit-form hidden">
          <textarea id="edit-input-${action.id}">${escapeHtml(action.tool_input || '{}')}</textarea>
          <div class="action-buttons">
            <button class="action-btn approve" onclick="handleEdit('${action.id}')">Save Edit</button>
            <button class="action-btn reject" onclick="toggleEdit('${action.id}')">Cancel</button>
          </div>
        </div>`;
    }

    return `
      <div class="action-card ${cardClass}">
        <div class="action-header">
          <span class="action-title">${escapeHtml(action.title)}</span>
          <span class="action-status status-${statusClass}">${action.status.replace(/_/g, ' ')}</span>
        </div>
        <div class="action-meta">
          <span><strong>Classification:</strong> ${action.classification.replace(/_/g, ' ')}</span>
          <span><strong>Tool:</strong> ${action.tool || 'None'}</span>
        </div>
        <div class="action-meta">
          <span><strong>Reason:</strong> ${escapeHtml(action.reason)}</span>
        </div>
        ${buttonsHtml}
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// SECTION 4: TOOL RESULTS
// ---------------------------------------------------------------------------

function renderResults(actions) {
  const section = document.getElementById('results-section');
  const content = document.getElementById('results-content');

  const completedWithOutput = (actions || []).filter((a) => a.output);
  if (completedWithOutput.length === 0) return;

  section.classList.remove('hidden');

  content.innerHTML = completedWithOutput.map((action) => {
    let output;
    try {
      output = JSON.parse(action.output);
    } catch {
      return '';
    }

    if (action.tool === 'draft_communication' && output.subject) {
      return `
        <div class="result-block">
          <h3>📧 Draft Communication</h3>
          <table class="evidence-table">
            <tr><th>Subject</th><td>${escapeHtml(output.subject)}</td></tr>
            <tr><th>Recipient</th><td>${escapeHtml(output.recipient_description || 'N/A')}</td></tr>
            <tr><th>Recipients Resolved</th><td>${output.recipients_resolved ? 'Yes' : 'No'}</td></tr>
            <tr><th>Sent</th><td>${output.sent ? 'Yes' : 'No'}</td></tr>
          </table>
          <pre>${escapeHtml(output.body)}</pre>
        </div>`;
    }

    if (action.tool === 'create_task') {
      return `
        <div class="result-block">
          <h3>📋 Task Created</h3>
          <table class="evidence-table">
            <tr><th>Title</th><td>${escapeHtml(output.title || action.title)}</td></tr>
            <tr><th>Due Date</th><td>${output.due_at ? output.due_at.slice(0, 10) : 'No due date'}</td></tr>
            <tr><th>Due In</th><td>${output.due_in_days ? output.due_in_days + ' days' : 'N/A'}</td></tr>
            <tr><th>Status</th><td>${output.status || 'OPEN'}</td></tr>
          </table>
        </div>`;
    }

    if (action.tool === 'website_check' && output.http_status) {
      const rows = [
        ['URL', output.requested_url],
        ['Final URL', output.final_url],
        ['HTTP Status', `${output.http_status} ${output.status_text || ''}`],
        ['Content Type', output.content_type || 'N/A'],
        ['Response Time', `${output.response_time_ms}ms`],
        ['Page Title', output.page_title || 'N/A'],
        ['Has DOCTYPE', output.has_doctype ? 'Yes' : 'No'],
        ['HTML Lang', output.html_lang || 'N/A'],
        ['Meta Description', output.meta_description || 'N/A'],
        ['Meta Viewport', output.meta_viewport || 'N/A'],
        ['Content Size', `${output.content_length_bytes} bytes`],
        ['Redirects', output.redirect_count],
      ];

      const checksHtml = (output.checks_performed || [])
        .map((c) => `<li>${escapeHtml(c)}</li>`).join('');

      return `
        <div class="result-block">
          <h3>🌐 Website Check Evidence</h3>
          <table class="evidence-table">
            ${rows.map(([k, v]) => `<tr><th>${k}</th><td>${escapeHtml(String(v ?? 'N/A'))}</td></tr>`).join('')}
          </table>
          ${checksHtml ? `<div style="margin-top:12px"><strong style="color:var(--text-muted);font-size:0.82rem">CHECKS PERFORMED</strong><ul style="margin:6px 0 0 18px;font-size:0.85rem;color:var(--text-muted)">${checksHtml}</ul></div>` : ''}
        </div>`;
    }

    if (action.tool === 'generate_brief' && output.markdown) {
      return `
        <div class="result-block">
          <h3>📝 Generated Brief</h3>
          <pre>${escapeHtml(output.markdown)}</pre>
        </div>`;
    }

    // Generic fallback
    return `
      <div class="result-block">
        <h3>${escapeHtml(action.title)}</h3>
        <pre>${escapeHtml(JSON.stringify(output, null, 2))}</pre>
      </div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// SECTION 5: ACTIVITY TRACE
// ---------------------------------------------------------------------------

function renderTrace(events) {
  const section = document.getElementById('trace-section');
  const content = document.getElementById('trace-content');

  if (!events || events.length === 0) return;

  section.classList.remove('hidden');

  // Newest first for visibility
  const sorted = [...events].reverse();

  const items = sorted.map((e) => {
    const time = new Date(e.created_at).toLocaleTimeString('en-US', { hour12: false });
    const typeClass = getTraceTypeClass(e.type);

    return `
      <div class="trace-item">
        <span class="trace-time">${time}</span>
        <span class="trace-type ${typeClass}">${e.type}</span>
        <span class="trace-message">${escapeHtml(e.message)}</span>
      </div>`;
  }).join('');

  content.innerHTML = `<div class="trace-list">${items}</div>`;
}

function getTraceTypeClass(type) {
  if (type.includes('FAILED') || type.includes('REJECTED')) return 'failure';
  if (type.includes('COMPLETED') || type.includes('APPROVED')) return 'success';
  if (type.includes('CLARIFICATION') || type.includes('APPROVAL_REQUESTED')) return 'warning';
  return 'info';
}

// ---------------------------------------------------------------------------
// APPROVAL / REJECT / EDIT HANDLERS
// ---------------------------------------------------------------------------

async function handleApprove(actionId) {
  try {
    const res = await fetch(`/api/actions/${actionId}/approve`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json();
      alert(`Approve failed: ${data.error}`);
      return;
    }
    // Refresh
    await refreshCurrentRequest();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function handleReject(actionId) {
  try {
    const res = await fetch(`/api/actions/${actionId}/reject`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json();
      alert(`Reject failed: ${data.error}`);
      return;
    }
    await refreshCurrentRequest();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

function toggleEdit(actionId) {
  const form = document.getElementById(`edit-form-${actionId}`);
  form.classList.toggle('hidden');
}

async function handleEdit(actionId) {
  const textarea = document.getElementById(`edit-input-${actionId}`);
  let parsed;
  try {
    parsed = JSON.parse(textarea.value);
  } catch {
    alert('Invalid JSON. Please fix the input.');
    return;
  }

  try {
    const res = await fetch(`/api/actions/${actionId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool_input: parsed }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert(`Edit failed: ${data.error}`);
      return;
    }
    await refreshCurrentRequest();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

async function refreshCurrentRequest() {
  if (!currentRequestId) return;
  try {
    const res = await fetch(`/api/requests/${currentRequestId}`);
    if (!res.ok) return;
    const data = await res.json();
    renderAll(data);
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// UTILS
// ---------------------------------------------------------------------------

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function showStatus(el, text, type) {
  el.textContent = text;
  el.className = `status-line ${type || ''}`;
  el.classList.remove('hidden');
}

// Make handlers available globally for onclick attributes
window.handleApprove = handleApprove;
window.handleReject = handleReject;
window.handleEdit = handleEdit;
window.toggleEdit = toggleEdit;
