# Agent Names and Notifications PRD

Make agents easy to recognize, find and message in Facade's existing CLI terminals.

## 1. Names and identity

- UI starts get a random, short, readable name. API starts can supply a name.
- Names are unique among starting, running and stopping agents in one window.
  Generate an available name; reject conflicting supplied names or renames.
  Other windows and history may repeat names.
- Right-click **Rename Agent...** to change the name. Support Chinese names and
  lookup by the displayed name.
- Each run keeps its immutable ID. Renaming updates display and lookup; messages
  and queued operations remain attached to the same run.
- Preserve names through reload. Future Pin/resume support should reserve pinned
  names while inactive.

## 2. Tabs and Show Active Agents

Show the CLI logo, name and optional CLI-provided title. Keep CLI text, `@` and ID
out of the default label.

| Surface | Text after the CLI logo |
| --- | --- |
| Tab | `Alin - Fix the login bug` |
| Show Active Agents | `Alin - Fix the login bug` followed by subdued `facadecode / login-fix` |

- The task-like text comes from the CLI's existing terminal title. Facade does not
  generate it or ask the user to fill it in.
- Both surfaces use `terminal.integrated.tabs.separator`, default ` - `, honoring
  user settings. Omit the separator when no title exists.
- **Show Active Agents stays one line.** Put folder/worktree after the name and
  title in subdued text. Preserve the name when truncating.
- Search names, titles, folders and worktrees in this window. Order by recent human
  use, then recent start. Title changes do not reorder an open picker.
- Details show ID, CLI, window, full folder path, worktree and start time, with
  **Copy Agent Reference**.

## 3. Finding the right agent

A name alone looks up an active agent in the current window. If absent, offer
cross-window discovery without silently selecting a remote namesake.

Cross-window or historical candidates include name, available CLI title, window,
folder/worktree and start time. The API also returns IDs. Use the user's description
to select the right candidate; clarify only when still ambiguous. The user can say
"the one fixing login" without copying a number.

Once selected, use the ID for operations; names and titles can change.

## 4. Message notifications

The notice typed into the receiving agent's terminal reads:

```text
Facade: You have an unread message from Alin. Use read_messages to read it.
```

For multiple messages:

```text
Facade: You have 3 unread messages from Alin and Bo. Use read_messages to read them.
```

Qualify cross-window sender names. Keep agent/message IDs in tool results and
records, outside the notice. Retries describe current unread messages; fetching
does not imply accepting or completing the work.

For the person: `Alin sent you a message.` with **View**, opening the sender's
terminal where the message is printed, or the saved message after it ends.
The person's notification contains no tool instructions.

## 5. Pinned agents

- An agent lives with its window. Reloading the window keeps it running; closing
  the window, quitting the editor or a crash ends it once the window has not come
  back for 15 seconds. Nothing keeps running in the background.
- Right-click **Pin Agent** to keep an agent across windows. When the window opens
  again, each pinned agent whose process ended starts again in the same folder,
  with the same name and ID, YOLO, model and effort, and its CLI resumes its
  conversation:

  | CLI | How its conversation is found |
  |---|---|
  | Claude Code | Facade gives it a session ID at launch (`--session-id`); a hook records each new one (after `/clear` too); `--resume <id>` |
  | Qwen Code | Facade gives it a session ID at launch; `--resume <id>` |
  | Codex | Found in its session files by folder and launch time; `codex resume <id>` |
  | Antigravity | Found in its CLI log by folder and launch time; `--conversation <id>` |
  | Muse Code | The folder's latest; `muse resume --last` |

  Where no ID is found, the folder's latest conversation is resumed.
- Unpinned agents end with the window and do not come back.
- An agent whose worktree was deleted is not restored: its work went with it.
- Custom agents cannot be pinned.
- Pinned agents are listed first, with a pin.
