# Letena Content OS
## Technical and product blueprint, phase 1

Version 1.0 | 11 August 2026

Letena Content OS is a medically governed SRH knowledge, demand intelligence, content generation, video production, publishing and analytics system for Letena Ethiopia. This set covers deliverables A to G of the brief. Read in order.

| File | Deliverable | What it contains |
|---|---|---|
| `LCOS_00_Executive_Product_Definition.md` | A | Scope, the knowledge and content separation, users and their jobs, privacy model, success measures, ten non-negotiable behaviours, decisions already made |
| `LCOS_01_System_Architecture.md` | B | Three-zone architecture, services, PII firewall, storage layout, integration contracts, environments, deployment, observability, security, failure posture |
| `LCOS_02_Data_Model_and_ERD.md` | C1 | Domain map, ERD, design rules, five state machines, risk tier routing, traceability query, indexing, retention |
| `LCOS_03_schema.sql` | C2 | Complete PostgreSQL 16 DDL: 51 tables, 29 enums, 168 indexes, 122 foreign keys, 55 checks, 26 triggers, 5 views, seed data, database roles and grants |
| `LCOS_04_Modules_and_API.md` | D | Repository layout, module boundaries, state transition engine, full endpoint catalogue with examples, RBAC matrix, queue architecture, test strategy |
| `LCOS_05_n8n_Workflows.md` | E | WF01 to WF20 with node maps, triggers, guards, error handling, retries, human checkpoints, the priority formula, the coverage states, the three score formulas |
| `LCOS_06_AI_Agents_and_Prompts.md` | F | Thirteen agents, gateway contract, production system prompts, ten JSON Schemas, claim validation logic, risk tier computation, model selection, evaluation harness |
| `LCOS_07_Build_Sequence_and_Pilot.md` | G | Four releases with a task-level backlog and acceptance criteria, the parallel clinical track, the 20-card pilot backlog, the 30-day pilot, the path to 100 cards, team and effort |

### Verification performed

- `LCOS_03_schema.sql` applied cleanly against PostgreSQL 16.13 with pgvector, pg_trgm, pgcrypto and btree_gin.
- Smoke test confirms the source supersession cascade moves dependent claims and knowledge cards to `NEEDS_UPDATE` in one transaction.
- Smoke test confirms an approved knowledge card cannot be created without a recorded reviewer and review date.
- All ten agent response schemas validate as JSON Schema Draft 2020-12.
- The `SCRIPT_V1` branching schema accepts a valid script and a valid `NEEDS_KNOWLEDGE` refusal, and rejects a payload carrying both.
- Cross-document check: every settings key, enum literal and table name referenced across the seven documents exists in the schema.

### The one thing to hold onto

Medical knowledge and content are separate objects with separate lifecycles. AI repackages approved claims. AI never authors a medical fact. When a script needs a fact that does not exist as an approved claim, the pipeline stops and asks the clinical team. That stop condition is the load-bearing safety control of the entire system, and every other design decision here serves it.

### Next

Phase 2, still to write:

1. Screen-by-screen UI requirements for all 25 screens, with wireframes for the six complex ones.
2. Clinical QA test cases and the seeded-defect catalogue for the validator.
3. Language QA test cases including the Amharic negation and time-window corpus.
4. Automation test cases for the 12 named failure paths.
5. Creatomate template specifications for the six master templates.
6. HeyGen integration detail, avatar consent, presenter labelling standard.
7. Operations runbook.
8. Roadmap beyond 100 cards.
