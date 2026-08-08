# Agentic Work Intake Prototype — Completion Walkthrough

I have successfully completed all phases of the AI engineering take-home assignment. The result is a robust, reliable, and secure prototype that takes unstructured requests and turns them into reviewable agentic workflows.

## What Was Built

### 1. The Core Infrastructure (Phases 1 & 2)
- **State Machine & Orchestrator:** A robust, deterministic planner that governs state transitions. The LLM understands the request and proposes actions, but the **TypeScript state machine** validates and gates all execution. `PENDING_APPROVAL → EXECUTING` is an illegal state transition, ensuring human oversight cannot be bypassed.
- **Provider-Neutral LLM Interface:** The system interfaces with Gemini via a clean adapter. If the model fails or returns non-JSON, the system retries with corrective feedback and eventually fails loudly (`VALIDATION_FAILED`) rather than hallucinating.

### 2. Tools & SSRF Protection (Phase 3)
Four specialized tools were implemented:
- `draft_communication`: Generates a subject and body for emails (never actually sends).
- `create_task`: Calculates and persists deadlines in SQLite.
- `generate_brief`: Reads from the database to generate a markdown summary.
- `website_check`: A heavily sandboxed HTTP client to inspect web pages.

> [!IMPORTANT]
> **SSRF Security:** The `website_check` tool validates every URL before fetching. It blocks `localhost`, `127.x.x.x`, private IPs (`10.x.x.x`, `192.168.x.x`), cloud metadata endpoints, IPv6 loopback, and explicitly handles URL normalization tricks (like `::ffff:127.0.0.1` being mapped to hex format). This is verified by 27 distinct SSRF tests.

### 3. Orchestration & API (Phase 4)
- **API Server:** An Express API server that receives requests, fetches request states for polling, and provides endpoints to approve, reject, or edit pending actions.
- **SQLite Persistence:** All transitions, generated plans, tool inputs, and tool outputs are persisted in the `data/app.db` SQLite database. Complete activity traces are generated.

### 4. Web UI (Phase 5)
- **Clean Vanilla Interface:** A dependency-free (no frameworks) HTML, CSS, and JS web application available at `http://localhost:3000`. 
- **Interactive Scenarios:** Features built-in one-click test cases (Partner Follow-up, Website Review, Vague Request) to demonstrate the system's ability to automate securely and halt when clarification is needed.

### 5. Final Verification (Phase 6)
I executed the complete test suite and simulated user interactions in the browser.
- **105/105 Tests Pass:** Including full-pipeline integration tests without API keys.
- **Scenario Verification:** Verified that Scenario 1 routes correctly to a human approval step, Scenario 2 successfully checks the Hedamo website under SSRF guardrails, and Scenario 3 gracefully blocks execution because of missing information.

## Demonstrating the AI Workflow

Scenario 1 routes to a human approval step, Scenario 2 checks a website under SSRF guardrails, and Scenario 3 blocks execution on missing information — see the Scenario sections of `README.md` for the expected behavior of each.

## Quick Start

You can verify the final prototype yourself by running the following commands in the terminal:

```bash
npm test         # Run the 105 automated unit and integration tests
npm run dev      # Start the local development server at http://localhost:3000
```

> [!NOTE]
> All work has been committed to the local git repository with descriptive messages for each phase. The final `README.md` includes detailed documentation on the architecture, setup instructions, security, and the honest "How I Used AI" section required by the assignment.
