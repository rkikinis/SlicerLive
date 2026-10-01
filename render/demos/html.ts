// A NAME INTO HTML, ESCAPED. Series descriptions, file names and node names come from DICOM files and from people;
// put into innerHTML as they are, a "<", "&" or quote in one broke its row (code review 2026-09-24, A11). One
// function for every panel, escaping quotes too, so it is safe in an attribute as well as in text.
export const escapeHtml = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
