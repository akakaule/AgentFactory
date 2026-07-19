# Enforced Task Dependencies Implementation Plan

## 1. Persistence and domain behavior

Write failing core tests for migration 21, relationship directions, idempotency,
missing keys, self-links, direct/transitive cycles, cross-workspace links, lifecycle
restrictions, cascade deletion, and version bumps.

Append `MIGRATION_21_SQL`, add repository helpers for dependency reads and cycle
checks, add transactional `addTaskDependency` / `removeTaskDependency` operations,
bind them through `createCore`, and enrich `Task` / `TaskDetail` payloads.

## 2. Scheduling enforcement

Write failing claim tests proving FIFO skips a waiting task, later eligible work is
claimed, completion unblocks the dependent, and reopening blocks a future claim.
Add the unmet-dependency predicate to the atomic claim query.

Write a dispatcher test proving waiting rows consume no process slots. Filter them
before spawn while retaining the claim query as the authoritative race-safe gate.

## 3. REST API and client

Write failing server tests for PUT/DELETE success, idempotency, both missing-key
positions, self-link validation, cycle conflict, and lifecycle conflict. Add the two
task routes using the existing core-error mapping.

Write client API tests for the exact encoded URLs and add typed client methods.

## 4. Task drawer and board affordances

Write failing component tests for both relationship directions, cross-workspace
search, self/existing-edge filtering, correct endpoint order, removal from either
side, linked-task navigation, and visible mutation failures.

Add a focused dependency section to the drawer. Pass the unfiltered active task
list and an open-task callback from `App`. Reuse existing badges/buttons and add the
smallest necessary styles.

Write card/row tests for the `Waiting on N` indicator and keep queue actions
enabled with an explanatory waiting message.

## 5. Verification and delivery

Run focused core, dispatcher, server, API-client, and component tests; run the full
test suite and production build; inspect the complete diff; run one code review;
then create a Conventional Commit and push the current branch as explicitly
requested.
