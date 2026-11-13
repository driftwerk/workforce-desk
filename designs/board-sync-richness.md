# Synced boards that read like Jira and Linear

2026-11-13 · Desk `dd39a80` (origin/main) · hub `fef491d9` (workforce-public main) · builds on the ticket-view stack: hub #231 (files), #234 (comments), Desk #185 (layout)

Mockups: claude.ai artifact `DgYVqfC4KWR8RQcBEidCXD`: JiraBoard, LinearBoard, CardsBothThemes, StoryDetail, LinearIssue, EpicDetail, PopupNarrow and Description.

**Goal.** A synced card says what kind of work it is, where it belongs and how far along it is. An opened ticket shows the issue's parent, children, links, PRs, files and conversation, without leaving Desk. Desk's own actions stay on top: Take it, Hand to…, Start a session on it, Needs and Drop.

**Not here.** Writing any of these fields back. Desk's own (local) boards stay as they are.

---

## 1. Where the information is lost today

There are four layers, and each one drops something.

1. **The sync asks Jira for too little.** `board_sync::JIRA_FIELDS` is `summary, status, assignee, updated, labels, description`.
   - `jira.search` always writes `priority` and `issuetype` keys.
   - Because those fields aren't requested, both come back null.
2. **The Jira adapter's search output is a fixed whitelist.** Even when asked, `jira.search` drops `parent`, `subtasks`, `issuelinks`, `components`, `fixVersions`, `duedate`, the comment total and every customfield (sprint, points). `jira.get_issue` has `reporter`, `comment_count` and `attachments`, but not those either.
3. **The Desk parser drops what Linear already sends.** `linear.issue_list` returns `priority`, `priorityLabel`, the state's `color`, label `color`s, `project`, `parent` and `createdAt`. `board_sync::linear_issue()` keeps only title, body, state, labels (names), assignee and url.
   - #231 starts keeping priority, labels, project and due on `External.details`.
4. **Linear's query doesn't select some fields.** `estimate`, `cycle`, `dueDate`, `children` (only on `issue_get`), `attachments` (#231 adds them) and `relations` aren't requested.
   - **Bug: Linear "needs" never arrive.** `linear_issue()` parses `relations` into `blocked_by`, but neither `issue_list` nor `issue_get` selects `relations`, so it is always `None`.
   - The parse also reads `relations` of type `blocks` as "blocked by". In Linear's model that list holds the issues *this one blocks*.
   - "Blocked by" is `inverseRelations` of type `blocks`, and there the blocking issue is the node's **`issue`**, not its `relatedIssue`.
   - Fix both together, with a test against a real-shaped answer.

**The PLT-875 box.**
- Jira renders an issue macro as an indented `<span class="jira-issue-macro">`, with the key and a status lozenge on lines indented 12 spaces. This was checked on PLT-2692's `renderedFields.description`.
- `html_text` trims only line ends, so the macro becomes a CommonMark indented code block, which is the "Text / Copy" box holding `PLT-875` and `Done`.
- `<a href>` is dropped too, so every link loses its target.

## 2. Field map

"Free" means it comes with the pull's existing search page, once the field is asked for and the adapter passes it through.

| Shown as | Jira | Linear | Cost |
|---|---|---|---|
| Type glyph | `issuetype.name` (+ `hierarchyLevel`) | none (Linear has no type; `[Epic]` in titles stays text) | free: add to `JIRA_FIELDS` |
| State icon | n/a (column) | `state.type` (+ name) | free, kept already |
| Priority | `priority.name`, ranked by `/priority` order (site names: Now, Next, …) | `priority` 0–4, `priorityLabel` | free (Jira rank: one `/priority` read at link time) |
| Epic / project chip | `parent` (when the parent is an epic) | `project.name` | Jira: adapter passes `parent`; Linear: parse |
| Parent breadcrumb | `parent.key`, `summary`, `issuetype` | `parent.identifier`, `title` | same as above |
| Points / estimate | story-points customfield | `estimate` | Jira: field id per site; Linear: add to query |
| Sprint / cycle | sprint customfield (`name`, `endDate`) | `cycle { number startsAt endsAt }` | same |
| Sub-items n/m | `subtasks[].fields.status.statusCategory` | `children { nodes { state { type } } }` | Jira: free; Linear: add to list query (first: 50) |
| Epic children | JQL `parent in (A,B,…)` | `children` / `issue_list parent_id` | one extra search page per pass for all epics |
| Labels | `labels` | `labels.nodes{name}` | free, kept already |
| Components, fix version | `components[].name`, `fixVersions[].name` | n/a | free once passed through |
| Due / start | `duedate`, start-date customfield | `dueDate` | #231 has due |
| Reporter / creator | `reporter` | `creator` | Jira: search passes it; Linear: add `creator` |
| Created | `created` | `createdAt` | free |
| Blocked by / blocks / relates | `issuelinks[]` (`type.inward/outward`, `inwardIssue`/`outwardIssue`) | `relations`, `inverseRelations` | free once selected |
| Remote links (Confluence, Figma) | `/issue/{key}/remotelink` | `attachments` (link kind) | Jira: per issue, lazy; Linear: #231 |
| PR summary on cards | built-in **Development** field (`customfield_10000` here): `{pullrequest={state=MERGED, stateCount=2}}` | `attachments` | free on both: verified on PLT-2549 |
| PRs, branches, commits | dev-status `/rest/dev-status/latest/issue/detail?issueId=…&applicationType=GitHub&dataType=pullrequest\|branch` | `attachments` with `sourceType` github/gitlab (`metadata.status`, number, title) | Jira: per issue; Linear: free |
| Comment / file counts | `comment.total`, `attachment` length | `comments { totalCount }`?, attachments length | Jira: free fields; Linear: check `totalCount` exists, else lazy |
| Comments | `jira.list_comments` (#234) | `linear.comment_list` + `parent { id }` for threads | per issue, lazy (#234) |
| History | `?expand=changelog` (get_issue already asks, doesn't pass it) | `history { fromState toState actor botActor createdAt }` | per issue, lazy |
| Description | `fields.description` **ADF** (not `renderedFields`) | `description` markdown | free |

**Per-site Jira customfields.** Points, sprint, start date and Development are customfields whose ids differ per site. This site has:
- `customfield_10016` "Story point estimate" (`jsw-story-points`);
- `customfield_10026` "Story Points" (float);
- `customfield_10020` Sprint (`gh-sprint`);
- `customfield_10000` Development (`devsummarycf`).

Take the `jsw-story-points` one first, else "Story Points". When a board is linked, read `/rest/api/3/field` once. Find:
- the `com.pyxis.greenhopper.jira:gh-sprint` schema;
- the "Story point estimate" / "Story Points" number field;
- "Start date".

Keep their ids on the link (`BoardSync.fields`), then add them to `JIRA_FIELDS` for that board. A site without them shows no points. It needs a new optional read tool, `jira.list_fields`, since `jira.api` is not a sync tool.

## 3. What each surface shows (mockups)

**Card** (JiraBoard, LinearBoard, CardsBothThemes)
- **Always:**
  - type glyph (Jira) or state icon (Linear);
  - key and title;
  - who has it: the Desk session first, else the remote assignee.
- **Only when present:**
  - the epic or project chip in the head, which replaces the old "by Jira" slot;
  - one meta row, in a fixed order: priority, labels (Linear, two then "+n"), points, sub-items n/m, PR chip;
  - "Blocked by …";
  - Linear's created date at the foot.
- **On hover or focus:** comment and file counts, "blocks n", and the cycle.
- **Removed:** on synced boards, "by Jira" and "Jira added this". They said the same thing on every card.
- **Colours are Desk tokens.** Types use `magenta`, `done`, `red` and `working`. Epic, project and label dots take `series1..8` by a stable hash of the name, not Jira's or Linear's hex, so custom themes keep control.
- **PR chip:** Desk's `chip-live`, by state:

  | State | Style |
  |---|---|
  | open | dashed `working` |
  | review | solid `working` |
  | changes asked | `blocked` |
  | merged | `done` |
  | draft | faint dashed |

  A dot in the chip shows its checks.
- **Board head:** Epic, Type and Sprint (Jira), or Cycle, Project and Label (Linear), join the filter chips. Column heads add up their points.

**Ticket** (StoryDetail, LinearIssue). This is #185's two columns, with additions:
- A breadcrumb (team › epic/project › parent) above the title.
- A byline: "Story · written by X on Jira, date".
- In the reading column:
  - Sub-items: rows with a bar.
  - Development: PRs with number, title, checks, state and who opened them, then branches and commits. Desk sessions' `TicketLink::Pr` are merged in by URL, so each PR shows once.
  - Linked work: blocks, relates to and page links, read-only.
  - Files (#231).
  - **Activity**: comments (#234) and history in one timeline, with filters All / Comments / History / Only in Desk.
    - **This is a change to #185**, whose History is a folded `<details>` in the details column.
    - Linear replies nest one level. Jira comments stay flat.
    - Events show their actor: Jira, GitHub, or Desk on my behalf.
- In the details column, the facts gain Type, Working (the Desk session), Reporter, Points, Sprint/Cycle, Components, Fix version and Start, besides #185's State, Assignee, Priority, Labels, Project and Due.
  - Where Desk's word differs from the remote one, the remote's is shown faintly: "Doing · In Progress on Jira".
- **Needs**: a remote "is blocked by" becomes one of the ticket's needs, marked as from Jira or Linear, as Linear's `blocked_by` already does. Blocks and relates stay under Linked work.

**Epic** (EpicDetail)
- A segmented bar (done / doing+review / the rest) with "7 of 12 done · 28 of 47 points" and the blocked count.
- Children as rows with type, key, title, priority, points, PR, state and assignee.
- Group by State (default), Assignee or Type, or None. Done folds after two.
- A child outside the board's filter still lists here, from the epic-children search.

**Description** (Description)
- Jira: the hub converts **ADF to Desk markdown**, not `renderedFields` HTML.
  - `inlineCard` and `/browse/KEY` links become a ticket chip: type, key, title and state when known. It opens in Desk if the issue is on a synced board, else in Jira.
  - `mention` becomes a mention.
  - `panel` becomes a 2px rule in its state colour with an icon. This is not a tinted box.
  - `status` becomes a lozenge, and `date` a chip.
  - `expand` becomes a closed `<details>`.
  - `taskList` becomes read-only checkboxes.
  - `table` and `codeBlock{language}` use the chat renderer.
  - `media` becomes a file from #231.
- Linear: markdown passes through as today. Issue mentions (`MAN-611`, or a Linear issue URL) become chips, and `+++` collapsibles become a closed `<details>`.
- New rich directives:
  - the ticket chip;
  - the mention;
  - the lozenge;
  - the date;
  - the collapsible.

  Everything else already exists in `@workforce/rich`.
- **Until ADF lands**, `html_text` gets two fixes:
  - trim leading whitespace outside `<pre>`;
  - map `jira-issue-macro`, `/browse/KEY` anchors to `[KEY](…)`, and keep other links as `[text](href)` with `https` only.

## 4. Sync cost and rate limits

A pass runs every 2 minutes and spends at most `CALLS_PER_PASS = 60` calls, at 100 issues a page.

- **Eager, in the pass, at no extra calls:**
  - everything in the "free" rows above;
  - card counts from `comment.total` and attachment length (Jira).
  - This only makes each page wider: about 10 more fields, still one call per 100 issues.
- **Eager, one extra search a pass:**
  - epic children (`parent in (…)` over the board's epics, paged);
  - a mapped sprint's dates.
  - These skip a pass when the board is over budget.
- **Lazy, when a ticket opens, then cached:**
  - comments (#234: stale after 60 s, or when the issue moved);
  - history (changelog, or Linear `history`);
  - Jira remote links;
  - **Jira dev-status.**
  - These go on the `ticket read` (#231), which runs at most once every 5 minutes unless forced. Results are kept on the ticket (`External.dev`, `ticket_history`) with `read_at`.
- **The PR chip on Jira cards comes free from the Development field.**
  - Checked on PLT-2549, its value is `{pullrequest={dataType=pullrequest, state=MERGED, stateCount=2}, json={…"overall":{"count":2,"state":"MERGED","open":false}…}}`.
  - It comes with search, so every card gets its PR count and overall state at no extra call.
  - It has no PR numbers or checks. The card shows `#n` when there is one PR whose number is known: from a Desk session's link, or once the ticket has been opened and dev-status cached. Otherwise it shows "1 PR" or "2 PRs".
- **PR detail is per issue and lazy.**
  - Dev-status (`/rest/dev-status/latest/issue/detail`) is an **undocumented internal endpoint**. Wrap it in one tool, so a change there breaks one place.
- **Checks have three sources, and show only when known.**
  - Dev-status `dataType=build` lists builds when the site's GitHub app sends them.
  - For PRs a Desk session opened, Desk's own GitHub access gives them.
  - Linear's GitHub attachment `metadata` may carry a status. Confirm this when building.
  - With none of these, the check dot and "14/14" are absent: never a guess.
- **Linear's PR state is free.** `attachments` carry the GitHub integration's `metadata.status`. Select only `{ sourceType url title metadata }`, `first: 10`.
- **The MCP result cap is 1 MB** (`McpLimits::max_content_bytes`), so "free" fields must stay small on the page.
  - The search pass-through reduces `comment` and `attachment` to counts (`comment_total`, `attachment_count`), never bodies.
  - It keeps `subtasks` and `issuelinks` to key, type and status.
  - It never carries ADF: the full description (ADF) is read on ticket open, and the pass keeps today's clipped one.
- **Linear's rate limit** is about 1,500 requests an hour per key, plus a complexity budget (to confirm against Linear's docs when building). Adding `children(first: 50)` and `attachments(first: 10)` to a 100-issue page raises its complexity, so drop the page to 50 if the hub reports `RATELIMITED`.
- **Jira** throttles per user (cost-based; to confirm against Atlassian's docs). Dev-status is the heaviest call, which is why it never runs in a pass.

## 5. New tools (all optional: `BOARD_SYNC_VIEW_TOOLS`, as #231 does)

A hub without these keeps syncing, and the field is simply absent.
- `jira.list_fields`: the field ids, read at link time.
- `jira.dev_status`: the PRs, branches, commits and (when sent) builds for an issue id.
  - Read-only, on the workspace's own site.
  - It answers `{prs:[{id,url,title,status,author,lastUpdate,repo}], branches, commits:{count,latest}, builds:[{name,state,count}]}`.
- `jira.search`: passes through the fields asked for (parent, subtasks, issuelinks, components, fixVersions, duedate, comment total, and given customfield ids), each user-written string wrapped as today.
- `jira.get_issue`: passes `changelog` (already expanded) and the raw ADF `description`. `adapters/jira/markdown.rs` today only goes markdown → ADF, so ADF → markdown is new code, in the desk crate beside `html_text`.
- `linear.issue_list` / `issue_get`: add `estimate`, `cycle`, `dueDate`, `creator`, `relations`, `inverseRelations`, `children` (counts only on list) and `attachments`.
- `linear.issue_history`: a new read tool.
- `linear.comment_list`: adds `parent { id }` for threads.

## 6. Attachments and thumbnails

These are #231 as designed, and nothing changes. Bytes go only through `GET /api/desk/tickets/{id}/files/{file}[?thumb=1]`, read as the person through the board's remote, sniffed, sandboxed and cached in Postgres (256 MB).
- A Jira `media` node in ADF resolves to its attachment row by id.
- A Linear upload image resolves to its row by URL. No image is ever fetched by the page.
- Card file counts come from the pull; the files themselves come only when the ticket opens.

## 7. Write-back

**Read-only first.** Everything in this note is display only and never pushed. The writes that exist stay as they are:
- move a column (transition);
- Take it (assign to me);
- comment as the person (#234);
- create.

Later, one at a time, each through the existing tools as the person:
- priority;
- labels;
- linking a Desk session's PR to the issue (Linear `attachmentLinkURL`, Jira remote link). Private-path rules apply: PR links are never posted today.

Points, sprint and epic stay read-only.

## 8. PRs, in order

The ticket-view stack goes first, unchanged: hub #231 → #234, then Desk #185. Everything here branches from them, or from main once they merge.

Migrations are renumbered to main's max+1 at merge. `hub.ref` only moves forward.

| # | Repo | Branch | What | Desk needs |
|---|---|---|---|---|
| H1 | hub | `hub/board-sync-fixes` | `html_text` reads whitespace as HTML does, keeps `http(s)` links and fences `<pre>` (PLT-875); held bodies with the old code block are read again once | none |
| H2 | hub | `hub/board-sync-fields` | `JIRA_FIELDS` + `issuetype`, `priority`, `parent`; `jira.search` pass-through (counts only), `jira.list_fields` + per-link field ids, Development summary, Linear list fields; Linear `inverseRelations` (blocking issue = `node.issue`) wired into needs (today the parsed `blocked_by` is never used); `TicketDetails` grows | after #231 |
| D1 | Desk | `desk/board-cards` | the card (JiraBoard, LinearBoard, CardsBothThemes), filter chips and column points | H1, H2 |
| H3 | hub | `hub/board-sync-children` | epic children search; sub-items on the ticket | none |
| H4 | hub | `hub/ticket-development` | `jira.dev_status` (optional view tool), Linear attachments as PRs, cached on open | none |
| H5 | hub | `hub/ticket-adf` | ADF → Desk markdown on open, Linear issue-mention chips | none |
| H6 | hub | `hub/ticket-history` | changelog and Linear history on open, threads (`parent`) on comments | after #234 |
| D2 | Desk | `desk/ticket-rich` | the ticket view: breadcrumb, facts, Needs under the actions, Drop in the actions, Sub-items, Development, Linked work, the Activity timeline (replaces #185's History box) | H3–H6 |
| D3 | Desk | `desk/ticket-rich-text` | rich directives: ticket chip, mention, lozenge, date, collapsible; panels as rules | H5 |
| D4 | Desk | `desk/epic-view` | the epic view (EpicDetail) | H3 |

**One component, two places.** The ticket opens as the board's right panel and as the popup from a grid's board pane.
- Both are #185's `.ticket-panel` with its container query.
- Wide gives two columns (StoryDetail, EpicDetail).
- Under 760 px of the panel's own width it stacks (LinearIssue, PopupNarrow): actions and facts in one band under the title, then the reading column.
- The ↗ button (expand to full screen) is in the head in both places.

**Acceptance.** Every UI PR carries screenshots of the real build, in both themes and in both placements, beside the mockup PNGs. The reviewer rejects any visible difference the PR doesn't explain.

## Open questions

1. **Remote colours.** Should epic, project and label dots use Desk series colours (themeable, as mocked) or Jira's and Linear's own colours?
2. **Epics on the board.** Epics are cards today when the filter matches them. Should synced epics leave the columns and appear only as chips, a filter and their own view?
3. **"Hand the ready children to…"** on an epic (mocked as a single button). Is an epic a natural input to a boss plan (BD11)?
4. **Priority names.** This Jira site uses "Now / Next / …". Should a card show the bars only (as mocked) or the name too?
