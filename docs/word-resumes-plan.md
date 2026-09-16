# Word resumes

A person can attach a Word resume (`.docx`) anywhere a resume is accepted - the
setup form, the account panel, `import-documents.ps1` - and the searches built
from it read it.

This changes `server/` (text extracted on upload), `client/` (the format list and
its messages) and `scripts/run-onboarding.ps1` (what it stages). The readable
formats today are in [onboarding-plan.md](onboarding-plan.md) and
[account-settings-plan.md](account-settings-plan.md); this plan adds one.

## Context

A PDF is read by the overnight run directly. A `.docx` is not: it is a zip of XML
files, and the run's model step has nothing that opens one. Asking a person to
paste the text instead is the workaround every resume screen carries today, and
Word is the format most resumes are kept in.

## Text is extracted once, on upload, by code

When a `.docx` is stored under `resumes/`, the server extracts its text and
writes it beside the original as `<same name>.txt`. From then on the `.txt` is
what a search reads; the `.docx` stays as the person's original.

- **No model reads a `.docx`.** Extraction is a fixed procedure: open the zip,
  read `word/document.xml`, take the text runs in order, a line break per
  paragraph, table cells joined by tabs. It gives the same text every time.
- **No new dependency.** The Worker opens the zip with the platform's own
  `DecompressionStream`. If that proves impractical, the same procedure runs in
  `run-onboarding.ps1` with .NET's zip support instead, and this plan says so -
  never both.
- **The upload answers with what was read**: the extracted `.txt` path and its
  word count. A `.docx` that yields almost nothing (under 50 words - a scanned
  image pasted into Word, or a template) is refused at upload, naming that, while
  the person is still there to fix it.
- **Replacing the `.docx` replaces the `.txt`.** Removing the `.docx` removes it.
  The pair is one resume in every list the person sees.

**The extracted `.txt` belongs to the server.** A direct upload to the path that
pairs with a stored `.docx` is refused: "This text is read from Resume.docx -
replace that file instead." Otherwise a hand-edited text file could silently
replace what was read from the Word file, and nothing would show which one a
search is using.

## What the person sees

- The accepted resume formats become `.pdf`, `.docx`, `.txt` and `.md`, from the
  one constant the setup form and the account panel share.
- After a Word upload, the file shows its word count, e.g. `Brenna_Resume.docx ·
  612 words read`, so a bad extraction is visible, not discovered overnight.
- **`.doc` (Word 97-2003) is still refused**, with "Save it as .docx or PDF and
  attach that". It is a binary format with no fixed procedure worth trusting.
  `.rtf`, `.pages` and images stay refused the same way.

## The overnight run and the daily search

- `run-onboarding.ps1` stages the `.txt` for a `.docx` resume, and names the
  `.txt` wherever it names a resume.
- A search's `documents` list names the `.txt`, so the daily search downloads
  and reads the extracted text.

## Word files already stored

Extraction runs on upload, so a `.docx` stored before this change has no text
beside it. Resumes moved into storage by hand carry `.docx` originals, often next
to a `.txt` someone extracted themselves.

- **A one-time backfill** runs the same extraction over every stored `.docx`
  under `resumes/`, across all accounts, once, after the server change deploys.
- **It never overwrites an existing `.txt` of the same name.** A text file already
  beside a Word file is taken as the extraction, and the backfill reports it as
  kept. The pair rule then protects it like any other.
- It reports each file: extracted with its word count, kept, or refused as
  under 50 words - so a thin one is visible before a search reads it.
- Until it has run, a `.docx` with no `.txt` beside it is unreadable, and the
  overnight run says so rather than building from nothing.

## Importing a folder

`import-documents.ps1` uploads through the same route, so it gets extraction
with no change to how it uploads. It does change in three ways:

- It skips a `.txt` whose `.docx` is in the same folder, so re-importing a
  restored backup does not collide with the pair the server writes.
- A refusal prints the server's reason, not "HTTP 400".
- A Word upload prints what was read, like the page: `Resume.docx - 612 words
  read`.

## Verification

- `verify-local` uploads fixture `.docx` files - a plain resume, one with a
  table, one with only an image - and checks the extracted text, the word count,
  the refusal, and that replacing and removing move the pair together.
- The client test pins the shared format list and the `.doc` message.
- End to end, with Brenna: a setup sent with only a `.docx`, and the profile the
  night writes carrying details that exist only in that file.

## Not in this change

`.doc`, `.rtf`, `.pages`, images, and OCR of scanned resumes.
