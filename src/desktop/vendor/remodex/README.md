# remodex owner history adaptation

These two files are derived from the installed remodex 4.0.0 package:

- `desktop-ipc-live-owner.cjs`
- `desktop-ipc-conversation-adapter.cjs`

The package declares Apache-2.0. `LICENSE` is the exact license from its public
source commit `f67b1499dbd8ace7a23902fad3242cc88f7e9a9e`, retaining
`Copyright 2025-2026 Emanuele Di Pietro`. The public tree at that commit contains
no NOTICE file. Source: https://github.com/Emanuele-web04/remodex,
package directory `phodex-bridge`. Both files retain the original headers and
mark these modifications. Other protocol, transport, patch, and settings modules
continue to use the pinned `remodex` dependency.

Installed source SHA-256 before these changes:

```text
desktop-ipc-live-owner.js
5d9a7fd7ca19351be9a9824b51b73469dcc26e2d1122758c8b661ebb85ac353f
desktop-ipc-conversation-adapter.js
9be3d5be422bf6a89d24a8894500cbb81e5ea06f310cd3ec668e531a1070be57
```

LocalOwner resumes with `excludeTurns:true` and a descending initial page of
three summary turns. It supplies no model, effort, or permission overrides.
The owner accepts the authoritative page, including a valid empty page, without
requiring a full `thread/read` baseline. It keeps `nextCursor` as the older-turn
continuation; the response's different `backwardsCursor` is not substituted.
Responses without a supported page retain the existing legacy baseline path.

The page's cursor and turn completeness are stored separately from conversation
contents. After compatibility normalization, before building a snapshot or its
patch baseline, the owner projects truthful turn pagination and canonical
boundaries. Summary and notLoaded turns retain incomplete item pagination after
live updates. The actual thread `historyMode` is preserved. No accessors or
transport frame rewrites are involved.

Canonical `isComplete` describes turn coverage. A final page can cover every
turn while its summary items remain incomplete. H5 `desktopView` and native
complete-history checks both inspect item pagination as well. H5's existing
recorded-history entry point remains available for this incomplete live view;
its indexed pages continue to be read-only and explicitly incomplete.

Native `thread-follower-load-complete-history` still requests
`thread/read({threadId,includeTurns:true})`, waits for complete history, publishes
the complete snapshot, and returns that snapshot's revision. Legacy full-read
responses may omit itemsView. Explicit summary/notLoaded full-read responses,
or failed reads for a known bounded baseline, cannot acknowledge partial history
as complete. An authoritative full turn with no items clears a prior display
summary. Start, steer, stop, approvals, settings, and queue handling retain
the existing owner implementation.

The change removes the initial full-history read; native explicit complete
history still uses the full read and snapshot. This does not establish that a
real GiB-scale thread can complete that native path within memory/frame limits.
Three turns are a count limit, not a byte limit on an individual summary, and
app-server resume itself may still do substantial work. No frame limit is raised.

Idle writer release is restricted to a last follower departure observed on the
current owner connection. An initially empty follower map is not evidence that
the task has no viewers. Each new follow cancels the candidate; connection loss
or reinitialization clears every candidate and the follower map. H5 IPC answers
the existing status-request broadcast only for subscriptions already bound to
that exact owner, thread, and host, restoring presence after owner reconnection.
Sidebar observers count as followers too; this deliberately keeps the writer
while a task is still observed by the phone's task list.

After two seconds without renewed activity, release additionally requires known
idle runtime, terminal turns, no active goal, unfinished request, queued draft,
pending start/resume/hydration, mutation, follower request, app-server request,
write, unknown write outcome, or unresolved raw response. Existing work can
finish and start a fresh grace period. A per-task admission gate closes before
dispatch; it blocks both direct local requests/writes and follower controls.
The unsubscribe request bypasses inbound projection removal and waits for a
real `unsubscribed`, `notSubscribed`, or `notLoaded` acknowledgement before
dropping the owner projection and LocalOwner's tracked thread.

A definite unsubscribe RPC rejection retains the known writer. A timeout,
connection error, or malformed acknowledgement retains an uncertain admission
gate and prevents normal shutdown; it does not force-unlock or silently retry.
After acknowledged release, stale local sends require a successful resume.
This does not add a native archive handoff command: native archive/delete can
use the released writer only after all viewers have left. An open H5/native
view, task-list subscription, approval, or queued draft prevents release.

The local fork is necessary because the dependency exposes neither an explicit
initial-page baseline hook nor a pagination hook after compatibility projection.
A plain wrapper triggers automatic full reads or loses completeness metadata.
The maintenance surface is two files, about 3,600 lines. When updating remodex,
review owner/control and adapter changes plus the shared module contracts.

Targeted integration and regression checks:

```sh
node --test test/bounded-owner-history.test.mjs test/owner-settings-observer.test.mjs
node --test test/idle-owner-release.test.mjs test/desktop-ipc.test.mjs test/desktop-ipc-pool.test.mjs
```

The new integration tests use a temporary socket and fake app-server. A 1 GiB
rollout is a metadata marker, never a GiB allocation. They check bounded resume,
empty pages, summary completeness, full-read waiting and revision ordering,
failure handling, actual approval replies, and queue dispatch after completion.
They do not operate on user chats or constitute real large-thread validation.
