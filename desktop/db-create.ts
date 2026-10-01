// A NEW, EMPTY DICOM DATABASE, and the description every database can carry.
//
// Ron, 2026-10-01: "load save module has all that is needed unless you want to add a feature load to database with
// an option to create your own" -- and "Albula has to be selfcontained": a person without Claude must be able to make
// a database from the app. Until now a database existed only if Slicer had made it, and registering one meant editing
// settings.ini by hand.
//
// The database is Slicer's own form (ctkDICOM.sql, CTK schema 0.8.1, the version Slicer writes into SchemaInfo), so
// Slicer opens it and Albula's reader reads it like any other. Slicer fills its display tables
// (ColumnDisplayProperties, DisplayedFieldGeneratorRules) itself on first open; a database Albula made has them empty,
// as the format-tests database does (Contents/data/databases/format-tests, read by Albula since 2026-09-30).
//
// THE DESCRIPTION (Ron: "sounds good option to edit might be nice") is a small JSON file in the database folder --
// what it is called, what it holds, whether it holds patient data and under which approval, whom to ask -- so the
// databases overview can say which one is which, and the file travels with the folder.

const SQLITE = "/usr/bin/sqlite3";

export const CTK_SCHEMA_VERSION = "0.8.1";

/** CTK's dicom-schema.sql as Slicer stores it (`.schema` of a Slicer-made database, 2026-10-01). */
export const CTK_SCHEMA = `
CREATE TABLE 'SchemaInfo' ( 'Version' VARCHAR(1024) NOT NULL );
CREATE TABLE 'Images' (   'SOPInstanceUID' VARCHAR(64) NOT NULL,   'Filename' VARCHAR(1024) NULL,   'URL' VARCHAR(2048) NULL,   'SeriesInstanceUID' VARCHAR(64) NOT NULL ,   'InsertTimestamp' VARCHAR(20) NOT NULL ,   'DisplayedFieldsUpdatedTimestamp' DATETIME NULL ,   PRIMARY KEY ('SOPInstanceUID') );
CREATE TABLE 'Patients' (   'UID' INTEGER PRIMARY KEY AUTOINCREMENT,   'PatientsName' VARCHAR(255) NULL ,   'PatientID' VARCHAR(255) NULL ,   'PatientsBirthDate' DATE NULL ,   'PatientsBirthTime' TIME NULL ,   'PatientsSex' VARCHAR(1) NULL ,   'PatientsAge' VARCHAR(10) NULL ,   'PatientsComments' VARCHAR(255) NULL ,   'InsertTimestamp' VARCHAR(20) NOT NULL ,   'DisplayedPatientsName' VARCHAR(255) NULL ,   'DisplayedNumberOfStudies' INT NULL ,   'DisplayedLastStudyDate' DATE NULL ,   'DisplayedFieldsUpdatedTimestamp' DATETIME NULL ,   'Connections' VARCHAR(2048) NULL );
CREATE TABLE 'Studies' (   'StudyInstanceUID' VARCHAR(64) NOT NULL ,   'PatientsUID' INT NOT NULL ,   'StudyID' VARCHAR(255) NULL ,   'StudyDate' DATE NULL ,   'StudyTime' VARCHAR(20) NULL ,   'StudyDescription' VARCHAR(255) NULL ,   'AccessionNumber' VARCHAR(255) NULL ,   'ModalitiesInStudy' VARCHAR(255) NULL ,   'InstitutionName' VARCHAR(255) NULL ,   'ReferringPhysician' VARCHAR(255) NULL ,   'PerformingPhysiciansName' VARCHAR(255) NULL ,   'InsertTimestamp' VARCHAR(20) NOT NULL ,   'DisplayedNumberOfSeries' INT NULL ,   'DisplayedFieldsUpdatedTimestamp' DATETIME NULL ,   PRIMARY KEY ('StudyInstanceUID') );
CREATE TABLE 'Series' (   'SeriesInstanceUID' VARCHAR(64) NOT NULL ,   'StudyInstanceUID' VARCHAR(64) NOT NULL ,   'SeriesNumber' INT NULL ,   'SeriesDate' DATE NULL ,   'SeriesTime' VARCHAR(20) NULL ,   'SeriesDescription' VARCHAR(255) NULL ,   'Modality' VARCHAR(20) NULL ,   'BodyPartExamined' VARCHAR(255) NULL ,   'FrameOfReferenceUID' VARCHAR(64) NULL ,   'AcquisitionNumber' INT NULL ,   'ContrastAgent' VARCHAR(255) NULL ,   'ScanningSequence' VARCHAR(45) NULL ,   'EchoNumber' INT NULL ,   'TemporalPosition' INT NULL ,   'InsertTimestamp' VARCHAR(20) NOT NULL ,   'DisplayedCount' INT NULL ,   'DisplayedSize' VARCHAR(20) NULL ,   'DisplayedNumberOfFrames' INT NULL ,   'DisplayedFieldsUpdatedTimestamp' DATETIME NULL ,   PRIMARY KEY ('SeriesInstanceUID') );
CREATE TABLE 'Directories' (   'Dirname' VARCHAR(1024) ,   PRIMARY KEY ('Dirname') );
CREATE TABLE 'ColumnDisplayProperties' (   'TableName' VARCHAR(64) NOT NULL,   'FieldName' VARCHAR(64) NOT NULL ,   'DisplayedName' VARCHAR(255) NULL ,   'Visibility' INT NULL DEFAULT 1 ,   'Weight' INT NULL ,   'Format' VARCHAR(255) NULL ,   PRIMARY KEY ('TableName', 'FieldName') );
CREATE TABLE 'DisplayedFieldGeneratorRules' (   'Name' VARCHAR(64) NOT NULL,   'Enabled' INT NULL DEFAULT 1 ,   'Options' VARCHAR(255) NULL ,   PRIMARY KEY ('Name') );
CREATE INDEX 'ImagesFilenameIndex' ON 'Images' ('Filename');
CREATE INDEX 'ImagesSeriesIndex' ON 'Images' ('SeriesInstanceUID');
CREATE INDEX 'SeriesStudyIndex' ON 'Series' ('StudyInstanceUID');
CREATE INDEX 'StudiesPatientIndex' ON 'Studies' ('PatientsUID');
INSERT INTO SchemaInfo (Version) VALUES ('${CTK_SCHEMA_VERSION}');
`;

export const DESCRIPTION_FILE = "albula-database.json";

/** What a database says about itself (Ron, 2026-10-01: name, what it holds, patient data and approval, whom to ask). */
export interface DbDescription {
  name: string;
  /** What it holds, in a sentence or two. */
  holds?: string;
  /** Does it hold data of real patients (identifiable or under an approval)? */
  patientData?: boolean;
  /** The approval it was collected under, e.g. an IRB protocol number. */
  approval?: string;
  /** Whom to ask about it. */
  contact?: string;
  /** Where its contents came from, e.g. "OpenNeuro ds001226, CC0". */
  source?: string;
}

const LIMITS: Record<keyof DbDescription, number> = { name: 80, holds: 1000, patientData: 0, approval: 120, contact: 200, source: 300 };

/** A description as given by a page, checked: known fields, strings of sensible length, a name. */
export function cleanDescription(raw: unknown): DbDescription {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(LIMITS) as (keyof DbDescription)[]) {
    const v = r[k];
    if (v === undefined || v === null || v === "") continue;
    // PATIENT DATA IS A CLEAR YES OR NO: anything else ("yes", 1, a checkbox's "on") was stored as "no", the dangerous
    // direction for a database's own statement about IRB data (critic, 2026-10-01, finding 6). Refused instead.
    if (k === "patientData") {
      if (v === true || v === "true") out[k] = true;
      else if (v === false || v === "false") out[k] = false;
      else throw new Error("patient data must be yes (true) or no (false)");
      continue;
    }
    // No line breaks or control characters: the name becomes a folder name (finding 20).
    const s = (k === "name" ? String(v).replace(/[\u0000-\u001f\u007f]+/g, " ") : String(v)).trim();
    if (s.length > LIMITS[k]) throw new Error(`the ${k} is longer than ${LIMITS[k]} characters`);
    if (s) out[k] = s;
  }
  if (!out.name) throw new Error("a database needs a name");
  return out as unknown as DbDescription;
}

export async function readDescription(dir: string): Promise<DbDescription | undefined> {
  try { return cleanDescription(JSON.parse(await Deno.readTextFile(`${dir}/${DESCRIPTION_FILE}`))); }
  catch { return undefined; }
}

/** Written beside, then renamed over, so a reader never sees half a file. */
export async function writeDescription(dir: string, d: DbDescription): Promise<void> {
  const tmp = `${dir}/${DESCRIPTION_FILE}.${crypto.randomUUID()}.tmp`;   // two saves at once must not share one (finding 20)
  await Deno.writeTextFile(tmp, JSON.stringify(cleanDescription(d), null, 2) + "\n");
  await Deno.rename(tmp, `${dir}/${DESCRIPTION_FILE}`);
}

/**
 * Where a new database goes unless the person chooses: "Albula Databases" in the home folder (Ron, 2026-10-01: yes).
 * NOT Desktop or Documents: with iCloud's "Desktop & Documents" on, patient data there is uploaded (this workspace
 * left the Desktop on 2026-09-16 for the same reason).
 */
export function defaultDatabasesFolder(): string {
  const home = Deno.env.get("HOME");
  if (!home) throw new Error("the home folder is not known, so there is no default place for a database; choose a folder");   // never /tmp: emptied at restart
  return `${home}/Albula Databases`;
}

/**
 * Said when a folder is one a cloud service may copy off this Mac: Desktop and Documents (iCloud's "Desktop &
 * Documents"), iCloud Drive, and the folders of Dropbox, OneDrive, Google Drive, Box and the like, which macOS keeps
 * under ~/Library/CloudStorage (critic, 2026-10-01, finding 7). Not refused, since the person may have syncing off.
 */
export function icloudWarning(dir: string): string | undefined {
  const home = Deno.env.get("HOME");
  if (!home) return undefined;
  const d = dir.replace(/^\/System\/Volumes\/Data(?=\/)/, "");
  const rel = d.startsWith(home + "/") ? d.slice(home.length + 1) : "";
  if (/^(Desktop|Documents|Library\/Mobile Documents|Library\/CloudStorage)(\/|$)/.test(rel)) {
    return "This folder is one a cloud service can copy to the internet (Desktop, Documents, iCloud Drive, or a Dropbox, OneDrive, Google Drive or Box folder). For patient data, choose a folder outside them.";
  }
  return undefined;
}

/** The settings key for a database: its name in lower case, letters and digits, unique among `taken`. */
export function idFor(name: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "database";
  if (base !== "current" && !t.has(base)) return base;
  for (let i = 2; ; i++) if (!t.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * Make an empty database in `dir` (created if missing). Refuses a folder that already holds one -- that is
 * "Add an existing database", which registers it and leaves its files, its description included, as they are.
 */
export async function createDatabase(dir: string, description: DbDescription): Promise<void> {
  const d = cleanDescription(description);
  const index = `${dir}/ctkDICOM.sql`;
  if (await Deno.stat(index).then(() => true, () => false)) throw new Error("that folder already holds a DICOM database; add it as an existing one instead");
  await Deno.mkdir(dir, { recursive: true });
  const p = new Deno.Command(SQLITE, { args: [index], stdin: "piped", stdout: "null", stderr: "piped" }).spawn();
  const w = p.stdin.getWriter();
  await w.write(new TextEncoder().encode(`BEGIN;\n${CTK_SCHEMA}\nCOMMIT;\n`));
  await w.close();
  const { code, stderr } = await p.output();
  if (code !== 0) {
    await Deno.remove(index).catch(() => {});
    throw new Error(`the database could not be made: ${new TextDecoder().decode(stderr).trim()}`);
  }
  await writeDescription(dir, d);
}
