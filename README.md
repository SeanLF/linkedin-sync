# linkedin-sync

Keep your LinkedIn profile in sync with a plain-text file you control. You edit
one Markdown file; the tool reads your live profile, shows you exactly where the
two have drifted, and writes your changes back through LinkedIn's own edit
dialogs. Every write is checked by reading the profile again, so a "saved"
message is never taken on faith.

It drives **your own** logged-in browser against **your own** profile. It is not
a scraper, it holds no credentials, and it touches no one else's data. Unlike
the read-only LinkedIn tools out there, it also **writes**, and does it safely,
because it proves each change landed.

## What it does

- **Zero configuration.** It reads your own name from the session, so you never
  type your vanity URL, an API key, or a password.
- **Full structured export.** One JSON mirror of your whole profile: experience
  (with sub-roles), skills, projects, education, certifications, languages,
  recommendations, featured, publications, honours, volunteering, and your
  first-degree connections.
- **Writes that are proven, not hoped.** Headline, About, a position's
  description and skills, and projects (add, edit, dates, delete). Each write is
  verified by re-exporting and re-comparing; the write channel (the UI) and the
  check channel (the API) are different surfaces, so a bug in one cannot hide in
  the other.
- **Drift you can trust.** A three-state check (match, drift, or *unreadable*)
  with a self-test that proves the checker can still report a difference before
  you believe a clean run.
- **Reads by API, writes by UI, on purpose.** It replays LinkedIn's own Voyager
  GraphQL to read, and fills real edit dialogs to write, because LinkedIn's
  write path is React Server Component actions that rotate every deploy. The
  dialog is the stable contract, and it runs LinkedIn's validation and the
  "notify your network" switch, which a replayed write does not.
- **Auth by borrowing, not logging in.** A scripted login hits LinkedIn's
  app-approval checkpoint and then "Too many attempts". Instead it copies the
  session you already have in Chrome, decrypting the cookie jar with the macOS
  keychain (one Touch ID prompt).

## What a drift check looks like

```
$ linkedin-sync drift
mirror   2026-09-12T16:44:03Z
         0.1 days old
record   14 blocks

ok      headline                215 chars
DRIFT   about
        live    I take systems from prototype-or-fragile to production-grade ...
        record  I build AI systems that run with nobody watching ...
ok      project.dispatch        929 chars
ok      project.dispatch.dates  18 chars

14 fields: 13 match, 1 stale, 0 unreadable
```

`about` drifted because you edited your file; run `linkedin-sync write about` to
push it, then `linkedin-sync export && linkedin-sync drift` to confirm it landed.

## Getting started

Requirements: **macOS**, **Node 18+ (or Bun)**, and **Google Chrome signed into
LinkedIn** in your everyday profile. Nothing else to install: it uses
`@playwright/mcp` over `npx` and the `sqlite3` binary macOS already ships.

```bash
git clone <this repo> && cd linkedin-sync

# Import your session, export your profile, and write a linkedin.md
# bootstrapped from it (nothing to configure):
node src/cli.mjs init

# Edit linkedin.md (it starts as an exact copy of your live profile), then:
node src/cli.mjs drift                 # see what you changed
node src/cli.mjs write --dry-run about # rehearse a write (fills and discards)
node src/cli.mjs write about           # actually write it
node src/cli.mjs export && node src/cli.mjs drift   # prove it landed
```

The browser is **visible by default** so you can watch each write happen and
review it in real time. Set `LINKEDIN_HEADLESS=1` for no window (unattended use).

## The source-of-truth file

`linkedin.md` holds one fenced block per field, tagged `linkedin:<field>`, with
your own prose around it for notes. `init` fills it from your live profile, so
it starts matching and you edit down from there:

    ## Headline
    ```linkedin:headline
    Staff engineer, AI systems and full stack. ...
    ```

    ## Position: Acme Corp
    ```linkedin:position.acme-corp match="Acme Corp"
    I lead ...
    ```

The tag says what a block is; a `match` or `title` attribute says which entry it
maps to. This is the only per-user file. Everything else is machinery.

## Honest limits

- **macOS + Chrome only.** The session import is keychain- and Chrome-specific.
- **It breaks when LinkedIn ships.** Query IDs and dialog shapes rotate. A
  broken read exits with a distinct "the instrument is broken" code rather than
  a false clean; a moved dialog makes the writer refuse rather than guess.
- **It uses LinkedIn against its terms of service.** That is your call to make.

## License

MIT.
