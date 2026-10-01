/**
 * THE DATABASE CHECK, IN WORDS A FIRST-TIME USER CAN ACT ON — in one place, for every caller.
 *
 * After a write or a delete the server checks its index against the folder and answers with two
 * lists: entries whose file is gone, and files the index does not list. They were reported as
 * "0 zombie(s) and 155 orphan(s)" -- Ron, 2026-09-22: "Not helpful for a novice user."
 *
 * The save was rewritten that day and the delete, one window away in the same browser, was not:
 * the critic found the same vocabulary still there (2026-09-22, 1.8). A wording fixed at one call
 * site is a one-off fix, and those do not count -- so the sentence lives here and both call it.
 */
export interface AuditResult { ok?: boolean; indexRows?: number; zombies?: unknown[]; orphans?: unknown[] }

/** "" when there is nothing to say; otherwise one plain sentence about the FOLDER, not about the work. */
export function auditWords(audit: AuditResult | undefined): string {
  const gone = audit?.zombies?.length ?? 0;
  const loose = audit?.orphans?.length ?? 0;
  if (audit?.ok || (!gone && !loose)) return "";
  const parts = [
    gone ? `${gone} ${gone === 1 ? "entry" : "entries"} in the database list ${gone === 1 ? "a file" : "files"} that ${gone === 1 ? "is" : "are"} no longer there` : "",
    loose ? `${loose} ${loose === 1 ? "file" : "files"} in the database folder ${loose === 1 ? "is" : "are"} not listed in it` : "",
  ].filter(Boolean);
  return parts.join("; ");
}
